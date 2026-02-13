import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { Hono } from "hono";

import { AdapterRegistry } from "../../src/core/adapter-registry";
import { createApiKey } from "../../src/db/api-keys";
import { getDb, setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { upsertOAuthUser } from "../../src/db/users";
import { createConnectRoutes } from "../../src/routes/connect";
import { deleteAppCredential, storeAppCredential } from "../../src/vault/app-credential-store";
import { hasCredential, retrieveCredential } from "../../src/vault/credential-store";

const originalFetch = globalThis.fetch;
const ORIGINAL_SQUARE_ENVIRONMENT = process.env.SQUARE_ENVIRONMENT;
const ORIGINAL_AGENR_BASE_URL = process.env.AGENR_BASE_URL;
const ORIGINAL_PORT = process.env.PORT;

let testDb: Client | null = null;

function createRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  const noopFactory = () => ({
    discover: async () => ({}),
    query: async () => ({}),
    execute: async () => ({}),
  });

  registry.registerPublic(
    "stripe",
    noopFactory,
    "/tmp/oauth-stripe.ts",
    { name: "Stripe" },
    {
      platform: "stripe",
      auth: {
        type: "oauth2",
        strategy: "bearer",
        scopes: ["read_write"],
        oauth: {
          authorizationUrl: "https://connect.stripe.com/oauth/authorize",
          tokenUrl: "https://connect.stripe.com/oauth/token",
          tokenContentType: "form",
        },
      },
      authenticatedDomains: ["connect.stripe.com"],
      allowedDomains: [],
    },
  );

  registry.registerPublic(
    "github",
    noopFactory,
    "/tmp/oauth-github.ts",
    { name: "Github" },
    {
      platform: "github",
      auth: {
        type: "oauth2",
        strategy: "bearer",
        scopes: ["read:user", "user:email"],
        oauth: {
          authorizationUrl: "https://github.com/login/oauth/authorize",
          tokenUrl: "https://github.com/login/oauth/access_token",
          tokenContentType: "form",
          oauthService: "github",
        },
      },
      authenticatedDomains: ["github.com"],
      allowedDomains: [],
    },
  );

  return registry;
}

function createTestApp(): Hono {
  const app = new Hono();
  app.route("/connect", createConnectRoutes(createRegistry()));
  return app;
}

function keyHeaders(rawKey: string): Record<string, string> {
  return { "x-api-key": rawKey };
}

function readActionCount(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    return Number(value);
  }
  return 0;
}

beforeEach(async () => {
  delete process.env.SQUARE_ENVIRONMENT;
  process.env.AGENR_BASE_URL = "http://localhost:3001";
  delete process.env.PORT;

  testDb = createClient({ url: ":memory:" });
  setDb(testDb);
  await migrate();
  await storeAppCredential("stripe", {
    clientId: "ca_test_123",
    clientSecret: "sk_test_123",
  });
});

afterEach(async () => {
  globalThis.fetch = originalFetch;

  if (ORIGINAL_SQUARE_ENVIRONMENT === undefined) {
    delete process.env.SQUARE_ENVIRONMENT;
  } else {
    process.env.SQUARE_ENVIRONMENT = ORIGINAL_SQUARE_ENVIRONMENT;
  }
  if (ORIGINAL_AGENR_BASE_URL === undefined) {
    delete process.env.AGENR_BASE_URL;
  } else {
    process.env.AGENR_BASE_URL = ORIGINAL_AGENR_BASE_URL;
  }
  if (ORIGINAL_PORT === undefined) {
    delete process.env.PORT;
  } else {
    process.env.PORT = ORIGINAL_PORT;
  }

  if (testDb) {
    await testDb.close();
  }
  setDb(null);
  testDb = null;
});

describe("connect oauth flow", () => {
  test("list oauth services returns empty array when no app credentials are configured", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "oauth-services-empty", tier: "paid" });
    await deleteAppCredential("stripe");

    const response = await app.request("/connect/services", {
      headers: keyHeaders(key.raw),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ services: [] });
  });

  test("list oauth services returns only configured oauth providers", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "oauth-services-configured", tier: "paid" });

    const response = await app.request("/connect/services", {
      headers: keyHeaders(key.raw),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      services: [{ service: "stripe", name: "Stripe", platforms: ["stripe"] }],
    });
  });

  test("connect returns 404 when oauth app credentials are missing", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "oauth-missing-app-creds", tier: "paid" });
    await deleteAppCredential("stripe");

    const response = await app.request("/connect/stripe", {
      headers: keyHeaders(key.raw),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "OAuth credentials for Stripe are not configured. Ask the admin to set up OAuth app credentials.",
    });
  });

  test("create state, exchange code, and store credential", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "oauth-owner", tier: "paid" });
    let tokenRequestBody = "";
    let tokenRequestContentType = "";
    let tokenRequestAccept = "";

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      tokenRequestBody = typeof init?.body === "string" ? init.body : "";
      tokenRequestContentType = new Headers(init?.headers).get("content-type") ?? "";
      tokenRequestAccept = new Headers(init?.headers).get("accept") ?? "";

      return new Response(
        JSON.stringify({
          access_token: "oauth-access",
          refresh_token: "oauth-refresh",
          token_type: "bearer",
          expires_in: 3600,
          scope: "read_write",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const connectResponse = await app.request("/connect/stripe", {
      headers: keyHeaders(key.raw),
    });
    expect(connectResponse.status).toBe(302);

    const location = connectResponse.headers.get("location");
    expect(location).toBeTruthy();
    const redirectUrl = new URL(location!);
    const state = redirectUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(redirectUrl.searchParams.get("client_id")).toBe("ca_test_123");
    expect(redirectUrl.searchParams.get("scope")).toBe("read_write");
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe("http://localhost:3001/connect/stripe/callback");

    const callbackResponse = await app.request(`/connect/stripe/callback?code=auth-code&state=${state}`);
    expect(callbackResponse.status).toBe(200);
    expect(await callbackResponse.text()).toContain("Connected to Stripe!");

    const formBody = new URLSearchParams(tokenRequestBody);
    expect(tokenRequestContentType).toBe("application/x-www-form-urlencoded");
    expect(tokenRequestAccept).toBe("application/json");
    expect(formBody.get("grant_type")).toBe("authorization_code");
    expect(formBody.get("code")).toBe("auth-code");
    expect(formBody.get("client_id")).toBe("ca_test_123");
    expect(formBody.get("client_secret")).toBe("sk_test_123");
    expect(formBody.get("redirect_uri")).toBe("http://localhost:3001/connect/stripe/callback");

    const credential = await retrieveCredential(key.record.id, "stripe");
    expect(credential.access_token).toBe("oauth-access");
    expect(credential.refresh_token).toBe("oauth-refresh");
    expect(credential.token_type).toBe("bearer");
    expect(credential.expires_in).toBe(3600);
  });

  test("connect flow stores OAuth credential under owning user when API key is linked", async () => {
    const app = createTestApp();
    const user = await upsertOAuthUser({
      provider: "github",
      providerId: "oauth-linked-owner",
      email: "oauth-linked-owner@example.com",
      name: "OAuth Linked Owner",
    });
    const key = await createApiKey({
      label: "oauth-linked-key",
      tier: "paid",
      userId: user.id,
    });

    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          access_token: "oauth-linked-access",
          token_type: "bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const connectResponse = await app.request("/connect/stripe", {
      headers: keyHeaders(key.raw),
    });
    expect(connectResponse.status).toBe(302);
    const location = connectResponse.headers.get("location");
    expect(location).toBeTruthy();
    const state = new URL(location!).searchParams.get("state");
    expect(state).toBeTruthy();

    const callbackResponse = await app.request(`/connect/stripe/callback?code=auth-code&state=${state}`);
    expect(callbackResponse.status).toBe(200);

    expect(await hasCredential(user.id, "stripe")).toBe(true);
    expect(await hasCredential(key.record.id, "stripe")).toBe(false);
    const credential = await retrieveCredential(user.id, "stripe");
    expect(credential.access_token).toBe("oauth-linked-access");
  });

  test("expired state is rejected", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "oauth-expired", tier: "paid" });
    const state = crypto.randomUUID();
    await getDb().execute({
      sql: "INSERT INTO oauth_states (state, user_id, service, created_at) VALUES (?, ?, ?, ?)",
      args: [state, key.record.id, "stripe", new Date(Date.now() - 11 * 60 * 1000).toISOString()],
    });

    const response = await app.request(`/connect/stripe/callback?code=auth-code&state=${state}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid or expired state" });
  });

  test("invalid state is rejected", async () => {
    const app = createTestApp();
    const response = await app.request("/connect/stripe/callback?code=auth-code&state=missing-state");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid or expired state" });
  });

  test("error param logs failure and does not store credential", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "oauth-error", tier: "paid" });

    const connectResponse = await app.request("/connect/stripe", {
      headers: keyHeaders(key.raw),
    });
    const location = connectResponse.headers.get("location");
    const state = new URL(location!).searchParams.get("state");
    expect(state).toBeTruthy();

    const callbackResponse = await app.request(
      `/connect/stripe/callback?error=access_denied&state=${state}&error_description=denied`,
    );
    expect(callbackResponse.status).toBe(400);
    expect(await callbackResponse.json()).toEqual({
      error: "OAuth authorization failed",
      reason: "access_denied",
    });

    expect(await hasCredential(key.record.id, "stripe")).toBe(false);

    const result = await getDb().execute({
      sql: `SELECT COUNT(*) AS count
        FROM credential_audit_log
        WHERE user_id = ? AND service_id = ? AND action = ?`,
      args: [key.record.id, "stripe", "connection_failed"],
    });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    expect(readActionCount(row?.["count"])).toBe(1);
  });

  test("github oauth flow uses form token exchange and stores credential", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "oauth-github", tier: "paid" });
    await storeAppCredential("github", {
      clientId: "gh_client_123",
      clientSecret: "gh_secret_123",
    });

    let tokenRequestBody = "";
    let tokenRequestContentType = "";
    let tokenRequestAccept = "";
    let tokenRequestUrl = "";

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      tokenRequestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      tokenRequestBody = typeof init?.body === "string" ? init.body : "";
      tokenRequestContentType = new Headers(init?.headers).get("content-type") ?? "";
      tokenRequestAccept = new Headers(init?.headers).get("accept") ?? "";

      return new Response(
        JSON.stringify({
          access_token: "github-access",
          token_type: "bearer",
          scope: "read:user user:email",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const connectResponse = await app.request("/connect/github", {
      headers: keyHeaders(key.raw),
    });
    expect(connectResponse.status).toBe(302);

    const location = connectResponse.headers.get("location");
    expect(location).toBeTruthy();
    const redirectUrl = new URL(location!);
    const state = redirectUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(redirectUrl.origin).toBe("https://github.com");
    expect(redirectUrl.pathname).toBe("/login/oauth/authorize");
    expect(redirectUrl.searchParams.get("client_id")).toBe("gh_client_123");
    expect(redirectUrl.searchParams.get("scope")).toBe("read:user user:email");
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe("http://localhost:3001/connect/github/callback");

    const callbackResponse = await app.request(`/connect/github/callback?code=gh-code&state=${state}`);
    expect(callbackResponse.status).toBe(200);
    expect(await callbackResponse.text()).toContain("Connected to Github!");

    const formBody = new URLSearchParams(tokenRequestBody);
    expect(tokenRequestUrl).toBe("https://github.com/login/oauth/access_token");
    expect(tokenRequestContentType).toBe("application/x-www-form-urlencoded");
    expect(tokenRequestAccept).toBe("application/json");
    expect(formBody.get("grant_type")).toBe("authorization_code");
    expect(formBody.get("code")).toBe("gh-code");
    expect(formBody.get("client_id")).toBe("gh_client_123");
    expect(formBody.get("client_secret")).toBe("gh_secret_123");
    expect(formBody.get("redirect_uri")).toBe("http://localhost:3001/connect/github/callback");

    const credential = await retrieveCredential(key.record.id, "github");
    expect(credential.access_token).toBe("github-access");
    expect(credential.token_type).toBe("bearer");
  });
});
