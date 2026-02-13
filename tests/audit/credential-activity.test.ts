import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { Hono } from "hono";

import { createApiKey } from "../../src/db/api-keys";
import { getDb, setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { credentialsApp } from "../../src/routes/credentials";

interface ActivityEntryResponse {
  id: string;
  timestamp: string;
  action: string;
  execution_id: string | null;
  metadata: Record<string, unknown> | null;
}

interface ActivityResponse {
  service: string;
  entries: ActivityEntryResponse[];
  has_more: boolean;
}

let testDb: Client | null = null;

function createTestApp(): Hono {
  const app = new Hono();
  app.route("/credentials", credentialsApp);
  return app;
}

function keyHeaders(rawKey: string): Record<string, string> {
  return { "x-api-key": rawKey };
}

async function insertAuditRow(params: {
  id: string;
  userId: string;
  serviceId: string;
  action: string;
  timestamp: string;
  executionId?: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await getDb().execute({
    sql: `INSERT INTO credential_audit_log (
      id,
      user_id,
      service_id,
      action,
      execution_id,
      ip_address,
      metadata,
      timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      params.id,
      params.userId,
      params.serviceId,
      params.action,
      params.executionId ?? null,
      params.ipAddress ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
      params.timestamp,
    ],
  });
}

beforeEach(async () => {
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
});

describe("credential activity api route", () => {
  test("returns empty entries when no audit records exist for the service", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "activity-empty", tier: "paid" });

    const response = await app.request("/credentials/stripe/activity", {
      headers: keyHeaders(key.raw),
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as ActivityResponse).toEqual({
      service: "stripe",
      entries: [],
      has_more: false,
    });
  });

  test("returns audit entries only for the authenticated user and requested service", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "activity-owner", tier: "paid" });
    const other = await createApiKey({ label: "activity-other", tier: "paid" });
    const timestamp = "2026-02-12T14:34:00.000Z";

    await insertAuditRow({
      id: "row-owner-stripe",
      userId: key.record.id,
      serviceId: "stripe",
      action: "credential_retrieved",
      timestamp,
      executionId: "exec-owner",
      metadata: { domain: "api.stripe.com" },
    });
    await insertAuditRow({
      id: "row-owner-square",
      userId: key.record.id,
      serviceId: "square",
      action: "credential_retrieved",
      timestamp: "2026-02-12T14:35:00.000Z",
    });
    await insertAuditRow({
      id: "row-other-stripe",
      userId: other.record.id,
      serviceId: "stripe",
      action: "credential_retrieved",
      timestamp: "2026-02-12T14:36:00.000Z",
    });

    const response = await app.request("/credentials/stripe/activity", {
      headers: keyHeaders(key.raw),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as ActivityResponse;
    expect(body.service).toBe("stripe");
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.id).toBe("row-owner-stripe");
  });

  test("respects limit defaults and clamps values (default 50, max 200, min 1)", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "activity-limit", tier: "paid" });

    for (let index = 0; index < 210; index += 1) {
      await insertAuditRow({
        id: `limit-${index}`,
        userId: key.record.id,
        serviceId: "stripe",
        action: "credential_retrieved",
        timestamp: new Date(Date.UTC(2026, 1, 1, 0, 0, index)).toISOString(),
      });
    }

    const defaultResponse = await app.request("/credentials/stripe/activity", {
      headers: keyHeaders(key.raw),
    });
    expect(defaultResponse.status).toBe(200);
    const defaultBody = (await defaultResponse.json()) as ActivityResponse;
    expect(defaultBody.entries).toHaveLength(50);
    expect(defaultBody.has_more).toBe(true);

    const maxResponse = await app.request("/credentials/stripe/activity?limit=1000", {
      headers: keyHeaders(key.raw),
    });
    expect(maxResponse.status).toBe(200);
    const maxBody = (await maxResponse.json()) as ActivityResponse;
    expect(maxBody.entries).toHaveLength(200);
    expect(maxBody.has_more).toBe(true);

    const minResponse = await app.request("/credentials/stripe/activity?limit=0", {
      headers: keyHeaders(key.raw),
    });
    expect(minResponse.status).toBe(200);
    const minBody = (await minResponse.json()) as ActivityResponse;
    expect(minBody.entries).toHaveLength(1);
    expect(minBody.has_more).toBe(true);
  });

  test("supports before cursor pagination", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "activity-before", tier: "paid" });
    const timestamps = [
      "2026-02-12T10:00:00.000Z",
      "2026-02-12T10:01:00.000Z",
      "2026-02-12T10:02:00.000Z",
      "2026-02-12T10:03:00.000Z",
      "2026-02-12T10:04:00.000Z",
    ];

    for (let index = 0; index < timestamps.length; index += 1) {
      await insertAuditRow({
        id: `before-${index}`,
        userId: key.record.id,
        serviceId: "stripe",
        action: "credential_retrieved",
        timestamp: timestamps[index]!,
      });
    }

    const response = await app.request(
      `/credentials/stripe/activity?before=${encodeURIComponent("2026-02-12T10:02:00.000Z")}`,
      {
        headers: keyHeaders(key.raw),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ActivityResponse;
    expect(body.entries).toHaveLength(2);
    expect(body.entries.map((entry) => entry.id)).toEqual(["before-1", "before-0"]);
  });

  test("returns has_more true when additional entries exist", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "activity-has-more-true", tier: "paid" });

    await insertAuditRow({
      id: "more-1",
      userId: key.record.id,
      serviceId: "stripe",
      action: "credential_retrieved",
      timestamp: "2026-02-12T10:01:00.000Z",
    });
    await insertAuditRow({
      id: "more-2",
      userId: key.record.id,
      serviceId: "stripe",
      action: "credential_retrieved",
      timestamp: "2026-02-12T10:02:00.000Z",
    });
    await insertAuditRow({
      id: "more-3",
      userId: key.record.id,
      serviceId: "stripe",
      action: "credential_retrieved",
      timestamp: "2026-02-12T10:03:00.000Z",
    });

    const response = await app.request("/credentials/stripe/activity?limit=2", {
      headers: keyHeaders(key.raw),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as ActivityResponse;
    expect(body.entries).toHaveLength(2);
    expect(body.has_more).toBe(true);
  });

  test("returns has_more false when all entries fit within limit", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "activity-has-more-false", tier: "paid" });

    await insertAuditRow({
      id: "fit-1",
      userId: key.record.id,
      serviceId: "stripe",
      action: "credential_retrieved",
      timestamp: "2026-02-12T10:01:00.000Z",
    });
    await insertAuditRow({
      id: "fit-2",
      userId: key.record.id,
      serviceId: "stripe",
      action: "credential_retrieved",
      timestamp: "2026-02-12T10:02:00.000Z",
    });

    const response = await app.request("/credentials/stripe/activity?limit=10", {
      headers: keyHeaders(key.raw),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as ActivityResponse;
    expect(body.entries).toHaveLength(2);
    expect(body.has_more).toBe(false);
  });

  test("returns 400 for invalid service identifier", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "activity-invalid-service", tier: "paid" });

    const response = await app.request("/credentials/stripe$prod/activity", {
      headers: keyHeaders(key.raw),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid service identifier" });
  });

  test("response entries omit user_id, service_id, and ip_address", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "activity-privacy", tier: "paid" });

    await insertAuditRow({
      id: "privacy-1",
      userId: key.record.id,
      serviceId: "stripe",
      action: "credential_retrieved",
      timestamp: "2026-02-12T10:00:00.000Z",
      ipAddress: "203.0.113.10",
    });

    const response = await app.request("/credentials/stripe/activity", {
      headers: keyHeaders(key.raw),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ActivityResponse;
    expect(body.entries).toHaveLength(1);

    const entry = body.entries[0] as Record<string, unknown>;
    expect(entry["user_id"]).toBeUndefined();
    expect(entry["service_id"]).toBeUndefined();
    expect(entry["ip_address"]).toBeUndefined();
  });

  test("returns 400 when before is not a valid ISO timestamp", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "activity-invalid-before", tier: "paid" });

    const response = await app.request("/credentials/stripe/activity?before=not-a-timestamp", {
      headers: keyHeaders(key.raw),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid before cursor" });
  });
});
