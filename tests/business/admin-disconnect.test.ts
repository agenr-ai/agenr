import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { Hono } from "hono";

import { AdapterRegistry } from "../../src/core/adapter-registry";
import { createBusiness } from "../../src/db/businesses";
import { setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { createSession } from "../../src/db/sessions";
import { upsertOAuthUser } from "../../src/db/users";
import { createBusinessRoutes } from "../../src/routes/businesses";
import { getServiceAuditLog } from "../../src/vault/audit-queries";
import { hasCredential, storeCredential } from "../../src/vault/credential-store";

let testDb: Client | null = null;
let originalAdminEmails: string | undefined;

function createTestApp(): Hono {
  const registry = new AdapterRegistry();
  const noopFactory = () => ({
    discover: async () => ({}),
    query: async () => ({}),
    execute: async () => ({}),
  });

  for (const platform of ["toast", "stripe", "square"]) {
    registry.registerPublic(
      platform,
      noopFactory,
      `/tmp/${platform}.ts`,
      { name: platform },
      {
        platform,
        auth: {
          type: "oauth2",
          strategy: "bearer",
          oauth: {
            oauthService: platform,
            authorizationUrl: `https://${platform}.example.com/oauth/authorize`,
            tokenUrl: `https://${platform}.example.com/oauth/token`,
          },
        },
        authenticatedDomains: [`${platform}.example.com`],
      },
    );
  }

  const app = new Hono();
  app.route("/businesses", createBusinessRoutes(registry));
  return app;
}

function sessionHeaders(sessionToken: string): Record<string, string> {
  return { authorization: `Bearer ${sessionToken}` };
}

beforeEach(async () => {
  originalAdminEmails = process.env.AGENR_ADMIN_EMAILS;
  process.env.AGENR_ADMIN_EMAILS = "admin@example.com";

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

  if (originalAdminEmails === undefined) {
    delete process.env.AGENR_ADMIN_EMAILS;
  } else {
    process.env.AGENR_ADMIN_EMAILS = originalAdminEmails;
  }
});

describe("admin business connection management", () => {
  test("GET /businesses/:id/connections returns connections for business owner", async () => {
    const app = createTestApp();
    const owner = await upsertOAuthUser({
      provider: "github",
      providerId: "biz-owner-connections",
      email: "owner@example.com",
      name: "Owner",
    });
    const admin = await upsertOAuthUser({
      provider: "google",
      providerId: "admin-connections",
      email: "admin@example.com",
      name: "Admin",
    });
    const adminSession = await createSession(admin.id);

    await createBusiness({
      id: "joes-pizza",
      ownerId: owner.id,
      name: "Joe's Pizza",
      platform: "toast",
    });
    await storeCredential(
      owner.id,
      "toast",
      "oauth2",
      {
        access_token: "secret-access-token",
        refresh_token: "secret-refresh-token",
        expires_in: 3600,
      },
      ["read_write"],
    );

    const response = await app.request("/businesses/joes-pizza/connections", {
      headers: sessionHeaders(adminSession.token),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.businessId).toBe("joes-pizza");
    expect(body.ownerId).toBe(owner.id);
    expect(Array.isArray(body.connections)).toBe(true);
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]).toMatchObject({
      service: "toast",
      authType: "oauth2",
      scopes: ["read_write"],
    });
    expect(typeof body.connections[0]?.createdAt).toBe("string");
    expect(typeof body.connections[0]?.expiresAt).toBe("string");
    expect(body.connections[0]?.access_token).toBeUndefined();
    expect(body.connections[0]?.refresh_token).toBeUndefined();
    expect(body.connections[0]?.encrypted_payload).toBeUndefined();
  });

  test("GET /businesses/:id/connections returns 404 for unknown business", async () => {
    const app = createTestApp();
    const admin = await upsertOAuthUser({
      provider: "google",
      providerId: "admin-connections-missing",
      email: "admin@example.com",
      name: "Admin",
    });
    const adminSession = await createSession(admin.id);

    const response = await app.request("/businesses/missing-business/connections", {
      headers: sessionHeaders(adminSession.token),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Business not found" });
  });

  test("GET /businesses/:id/connections returns 403 for non-admin", async () => {
    const app = createTestApp();
    const owner = await upsertOAuthUser({
      provider: "github",
      providerId: "biz-owner-non-admin-read",
      email: "owner-read@example.com",
      name: "Owner Read",
    });
    const nonAdmin = await upsertOAuthUser({
      provider: "google",
      providerId: "user-non-admin-read",
      email: "member@example.com",
      name: "Member",
    });
    const nonAdminSession = await createSession(nonAdmin.id);

    await createBusiness({
      id: "member-biz",
      ownerId: owner.id,
      name: "Member Biz",
      platform: "stripe",
    });

    const response = await app.request("/businesses/member-biz/connections", {
      headers: sessionHeaders(nonAdminSession.token),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Forbidden",
      message: "Missing required scope: admin",
    });
  });

  test("DELETE /businesses/:id/connections/:service disconnects credential", async () => {
    const app = createTestApp();
    const owner = await upsertOAuthUser({
      provider: "github",
      providerId: "biz-owner-delete",
      email: "owner-delete@example.com",
      name: "Owner Delete",
    });
    const admin = await upsertOAuthUser({
      provider: "google",
      providerId: "admin-delete",
      email: "admin@example.com",
      name: "Admin Delete",
    });
    const adminSession = await createSession(admin.id);

    await createBusiness({
      id: "delete-biz",
      ownerId: owner.id,
      name: "Delete Biz",
      platform: "square",
    });
    await storeCredential(owner.id, "stripe", "oauth2", {
      access_token: "to-be-revoked",
    });

    const response = await app.request("/businesses/delete-biz/connections/stripe", {
      method: "DELETE",
      headers: sessionHeaders(adminSession.token),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: "Connection disconnected",
      service: "stripe",
      businessId: "delete-biz",
    });
    expect(await hasCredential(owner.id, "stripe")).toBe(false);

    const auditEntries = await getServiceAuditLog(owner.id, "stripe");
    const revokedEntry = auditEntries.find((entry) => entry.action === "credential_revoked_by_admin");
    expect(revokedEntry).toBeTruthy();
    expect(revokedEntry?.metadata).toEqual({ revokedBy: admin.id });
  });

  test("DELETE /businesses/:id/connections/:service returns 404 when no credential", async () => {
    const app = createTestApp();
    const owner = await upsertOAuthUser({
      provider: "github",
      providerId: "biz-owner-missing-credential",
      email: "owner-missing@example.com",
      name: "Owner Missing",
    });
    const admin = await upsertOAuthUser({
      provider: "google",
      providerId: "admin-missing-credential",
      email: "admin@example.com",
      name: "Admin Missing",
    });
    const adminSession = await createSession(admin.id);

    await createBusiness({
      id: "missing-connection-biz",
      ownerId: owner.id,
      name: "Missing Connection Biz",
      platform: "toast",
    });

    const response = await app.request("/businesses/missing-connection-biz/connections/stripe", {
      method: "DELETE",
      headers: sessionHeaders(adminSession.token),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "No connection found for service" });
  });

  test("DELETE /businesses/:id/connections/:service returns 403 for non-admin", async () => {
    const app = createTestApp();
    const owner = await upsertOAuthUser({
      provider: "github",
      providerId: "biz-owner-non-admin-delete",
      email: "owner-non-admin@example.com",
      name: "Owner Non Admin",
    });
    const nonAdmin = await upsertOAuthUser({
      provider: "google",
      providerId: "user-non-admin-delete",
      email: "member@example.com",
      name: "Member",
    });
    const nonAdminSession = await createSession(nonAdmin.id);

    await createBusiness({
      id: "non-admin-delete-biz",
      ownerId: owner.id,
      name: "Non Admin Delete Biz",
      platform: "toast",
    });
    await storeCredential(owner.id, "stripe", "oauth2", {
      access_token: "still-present",
    });

    const response = await app.request("/businesses/non-admin-delete-biz/connections/stripe", {
      method: "DELETE",
      headers: sessionHeaders(nonAdminSession.token),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Forbidden",
      message: "Missing required scope: admin",
    });
  });
});
