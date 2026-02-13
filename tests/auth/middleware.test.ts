import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { Hono } from "hono";

import { createApiKey } from "../../src/db/api-keys";
import { setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { createSession } from "../../src/db/sessions";
import { upsertOAuthUser } from "../../src/db/users";
import { apiKeyAuthMiddleware, requireScope } from "../../src/middleware/auth";

let testDb: Client | null = null;
let originalApiKey: string | undefined;
let originalAllowUnauthBootstrap: string | undefined;

function createTestApp(): Hono {
  const app = new Hono();

  app.use("/protected/*", apiKeyAuthMiddleware);
  app.options("/protected/ping", (c) => c.body(null, 204));
  app.get("/protected/ping", (c) => {
    return c.json({
      tier: c.get("apiKeyTier"),
      scopes: c.get("apiKeyScopes"),
      keyId: c.get("apiKeyId") ?? null,
    });
  });
  app.get("/protected/generate", requireScope("generate"), (c) => c.json({ ok: true }));

  return app;
}

beforeEach(async () => {
  originalApiKey = process.env.AGENR_API_KEY;
  originalAllowUnauthBootstrap = process.env.AGENR_ALLOW_UNAUTH_BOOTSTRAP;
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

  if (originalApiKey === undefined) {
    delete process.env.AGENR_API_KEY;
  } else {
    process.env.AGENR_API_KEY = originalApiKey;
  }

  if (originalAllowUnauthBootstrap === undefined) {
    delete process.env.AGENR_ALLOW_UNAUTH_BOOTSTRAP;
  } else {
    process.env.AGENR_ALLOW_UNAUTH_BOOTSTRAP = originalAllowUnauthBootstrap;
  }
});

describe("apiKeyAuthMiddleware", () => {
  test("OPTIONS requests pass through", async () => {
    process.env.AGENR_API_KEY = "admin-key";
    const app = createTestApp();

    const response = await app.request("/protected/ping", { method: "OPTIONS" });
    expect(response.status).toBe(204);
  });

  test("valid AGENR_API_KEY grants admin tier", async () => {
    process.env.AGENR_API_KEY = "admin-key";
    const app = createTestApp();

    const response = await app.request("/protected/ping", {
      headers: { authorization: "Bearer admin-key" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tier: "admin",
      scopes: ["*"],
      keyId: null,
    });
  });

  test("valid DB key grants tier and scopes", async () => {
    delete process.env.AGENR_API_KEY;
    const app = createTestApp();
    const created = await createApiKey({
      label: "Paid",
      tier: "paid",
    });

    const response = await app.request("/protected/ping", {
      headers: { "x-api-key": created.raw },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tier: "paid",
      scopes: ["discover", "query", "execute", "generate"],
      keyId: created.record.id,
    });
  });

  test("invalid key returns 401", async () => {
    delete process.env.AGENR_API_KEY;
    await createApiKey({
      label: "Free",
      tier: "free",
    });
    const app = createTestApp();

    const response = await app.request("/protected/ping", {
      headers: { authorization: "Bearer invalid-key" },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  test("query parameter api_key no longer authenticates", async () => {
    delete process.env.AGENR_API_KEY;
    const created = await createApiKey({
      label: "Legacy Query Key",
      tier: "free",
    });
    const app = createTestApp();

    const response = await app.request(`/protected/ping?api_key=${encodeURIComponent(created.raw)}`);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  test("valid session cookie authenticates as user context", async () => {
    delete process.env.AGENR_API_KEY;
    const app = createTestApp();
    const user = await upsertOAuthUser({
      provider: "google",
      providerId: "google-sub-1",
      email: "session-user@example.com",
      name: "Session User",
    });
    const session = await createSession(user.id);

    const response = await app.request("/protected/ping", {
      headers: {
        cookie: `agenr_session=${session.token}`,
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tier: "paid",
      scopes: ["discover", "query", "execute", "generate"],
      keyId: user.id,
    });
  });

  test("requireScope('generate') blocks free-tier key", async () => {
    delete process.env.AGENR_API_KEY;
    const app = createTestApp();
    const created = await createApiKey({
      label: "Free Key",
      tier: "free",
    });

    const response = await app.request("/protected/generate", {
      headers: { "x-api-key": created.raw },
    });

    expect(response.status).toBe(403);
  });

  test("requireScope('generate') allows paid-tier key", async () => {
    delete process.env.AGENR_API_KEY;
    const app = createTestApp();
    const created = await createApiKey({
      label: "Paid Key",
      tier: "paid",
    });

    const response = await app.request("/protected/generate", {
      headers: { authorization: `Bearer ${created.raw}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("no AGENR_API_KEY and no DB keys returns 401 when bootstrap flag is unset", async () => {
    delete process.env.AGENR_API_KEY;
    const app = createTestApp();

    const response = await app.request("/protected/ping");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  test("no AGENR_API_KEY and no DB keys allows bootstrap when flag is explicitly enabled", async () => {
    delete process.env.AGENR_API_KEY;
    process.env.AGENR_ALLOW_UNAUTH_BOOTSTRAP = "1";
    const app = createTestApp();

    const response = await app.request("/protected/ping");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tier: "admin",
      scopes: ["*"],
      keyId: null,
    });
  });
});

describe("Bearer token as session", () => {
  test("valid session id via Authorization Bearer authenticates as user", async () => {
    delete process.env.AGENR_API_KEY;
    const app = createTestApp();
    const user = await upsertOAuthUser({
      provider: "github",
      providerId: "gh-bearer-1",
      email: "bearer-user@example.com",
      name: "Bearer User",
    });
    const session = await createSession(user.id);

    const response = await app.request("/protected/ping", {
      headers: {
        authorization: `Bearer ${session.token}`,
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tier: "paid",
      scopes: ["discover", "query", "execute", "generate"],
      keyId: user.id,
    });
  });

  test("session Bearer gets scoped permissions, not admin", async () => {
    process.env.AGENR_API_KEY = "admin-key";
    const app = createTestApp();
    const user = await upsertOAuthUser({
      provider: "google",
      providerId: "goog-scope-1",
      email: "scope-test@example.com",
      name: "Scope Test",
    });
    const session = await createSession(user.id);

    const response = await app.request("/protected/ping", {
      headers: {
        authorization: `Bearer ${session.token}`,
      },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tier).toBe("paid");
    expect(body.scopes).not.toContain("*");
  });

  test("admin key via Bearer takes priority over session lookup", async () => {
    process.env.AGENR_API_KEY = "admin-key";
    const app = createTestApp();

    const response = await app.request("/protected/ping", {
      headers: {
        authorization: "Bearer admin-key",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tier: "admin",
      scopes: ["*"],
      keyId: null,
    });
  });

  test("DB API key via Bearer takes priority over session lookup", async () => {
    delete process.env.AGENR_API_KEY;
    const app = createTestApp();
    const created = await createApiKey({
      label: "Priority Key",
      tier: "paid",
    });

    const response = await app.request("/protected/ping", {
      headers: {
        authorization: `Bearer ${created.raw}`,
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tier: "paid",
      scopes: ["discover", "query", "execute", "generate"],
      keyId: created.record.id,
    });
  });

  test("expired or invalid session via Bearer returns 401", async () => {
    delete process.env.AGENR_API_KEY;
    const app = createTestApp();

    const response = await app.request("/protected/ping", {
      headers: {
        authorization: "Bearer not-a-real-session-id",
      },
    });

    expect(response.status).toBe(401);
  });

  test("cookie session takes priority over Bearer session", async () => {
    delete process.env.AGENR_API_KEY;
    const app = createTestApp();
    const user1 = await upsertOAuthUser({
      provider: "google",
      providerId: "goog-cookie-user",
      email: "cookie@example.com",
      name: "Cookie User",
    });
    const user2 = await upsertOAuthUser({
      provider: "github",
      providerId: "gh-bearer-user",
      email: "bearer@example.com",
      name: "Bearer User",
    });
    const cookieSession = await createSession(user1.id);
    const bearerSession = await createSession(user2.id);

    const response = await app.request("/protected/ping", {
      headers: {
        cookie: `agenr_session=${cookieSession.token}`,
        authorization: `Bearer ${bearerSession.token}`,
      },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.keyId).toBe(user1.id);
  });
});
