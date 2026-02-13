import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { Hono } from "hono";

import { setDb, getDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { createSession } from "../../src/db/sessions";
import { upsertOAuthUser } from "../../src/db/users";
import { apiKeyAuthMiddleware } from "../../src/middleware/auth";
import { auditApp } from "../../src/routes/audit";
import { logAudit } from "../../src/vault/audit";
import type { AuditAction } from "../../src/vault/audit-types";

const TEST_ADMIN_API_KEY = "audit-admin-key";

let testDb: Client | null = null;
let originalAdminApiKey: string | undefined;
let originalAllowUnauthBootstrap: string | undefined;

function createTestApp(): Hono {
  const app = new Hono();
  app.use("/audit/*", apiKeyAuthMiddleware);
  app.route("/audit", auditApp);
  return app;
}

function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${TEST_ADMIN_API_KEY}` };
}

function sessionHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function insertAuditEntry(userId: string, serviceId: string, action: AuditAction = "credential_stored"): Promise<void> {
  await logAudit({
    userId,
    serviceId,
    action,
  });
}

async function insertLegacyAuditEntry(userId: string, serviceId: string): Promise<void> {
  await getDb().execute({
    sql: `INSERT INTO credential_audit_log (
      id,
      user_id,
      service_id,
      action,
      execution_id,
      ip_address,
      metadata,
      timestamp,
      prev_hash
    ) VALUES (?, ?, ?, 'credential_stored', NULL, NULL, NULL, ?, NULL)`,
    args: [crypto.randomUUID(), userId, serviceId, new Date().toISOString()],
  });
}

beforeEach(async () => {
  originalAdminApiKey = process.env.AGENR_API_KEY;
  originalAllowUnauthBootstrap = process.env.AGENR_ALLOW_UNAUTH_BOOTSTRAP;
  process.env.AGENR_API_KEY = TEST_ADMIN_API_KEY;
  delete process.env.AGENR_ALLOW_UNAUTH_BOOTSTRAP;

  testDb = createClient({ url: ":memory:" });
  setDb(testDb);
  await migrate();
});

afterEach(async () => {
  if (testDb) {
    await testDb.close();
  }
  setDb(null);
  testDb = null;

  if (originalAdminApiKey === undefined) {
    delete process.env.AGENR_API_KEY;
  } else {
    process.env.AGENR_API_KEY = originalAdminApiKey;
  }

  if (originalAllowUnauthBootstrap === undefined) {
    delete process.env.AGENR_ALLOW_UNAUTH_BOOTSTRAP;
  } else {
    process.env.AGENR_ALLOW_UNAUTH_BOOTSTRAP = originalAllowUnauthBootstrap;
  }
});

describe("role-scoped audit verification route", () => {
  test("admin sees full chain verification", async () => {
    const app = createTestApp();

    await insertAuditEntry("alice", "stripe");
    await Bun.sleep(2);
    await insertAuditEntry("bob", "square");
    await Bun.sleep(2);
    await insertAuditEntry("alice", "stripe", "credential_retrieved");

    const response = await app.request("/audit/verify", {
      headers: adminHeaders(),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["valid"]).toBe(true);
    expect(body["totalEntries"]).toBe(3);
    expect(body["checkedEntries"]).toBe(3);
  });

  test("authenticated user sees only their entries", async () => {
    const app = createTestApp();
    const alice = await upsertOAuthUser({
      provider: "github",
      providerId: "audit-alice",
      email: "alice@example.com",
      name: "Alice",
    });
    const aliceSession = await createSession(alice.id);

    await insertAuditEntry(alice.id, "stripe");
    await Bun.sleep(2);
    await insertAuditEntry("bob-user", "square");
    await Bun.sleep(2);
    await insertAuditEntry(alice.id, "stripe", "credential_retrieved");

    const response = await app.request("/audit/verify", {
      headers: sessionHeaders(aliceSession.token),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["valid"]).toBe(true);
    expect(body["totalEntries"]).toBe(2);
    expect(body["checkedEntries"]).toBe(2);
    expect(body["unchainedEntries"]).toBe(0);
  });

  test("user verification reports unchained legacy entries", async () => {
    const app = createTestApp();
    const alice = await upsertOAuthUser({
      provider: "google",
      providerId: "audit-legacy-alice",
      email: "legacy-alice@example.com",
      name: "Legacy Alice",
    });
    const aliceSession = await createSession(alice.id);

    await insertLegacyAuditEntry(alice.id, "stripe");
    await Bun.sleep(2);
    await insertAuditEntry(alice.id, "stripe");

    const response = await app.request("/audit/verify", {
      headers: sessionHeaders(aliceSession.token),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["totalEntries"]).toBe(2);
    expect(body["checkedEntries"]).toBe(2);
    expect(body["unchainedEntries"]).toBe(1);
    expect(body["valid"]).toBe(true);
  });

  test("unauthenticated request returns 401", async () => {
    const app = createTestApp();

    const response = await app.request("/audit/verify");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });
});
