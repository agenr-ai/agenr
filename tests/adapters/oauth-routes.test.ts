import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";

import { AdapterRegistry } from "../../src/core/adapter-registry";
import { createApiKey } from "../../src/db/api-keys";
import { getDb, setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { createConnectRoutes } from "../../src/routes/connect";
import { storeAppCredential } from "../../src/vault/app-credential-store";

const ORIGINAL_AGENR_BASE_URL = process.env.AGENR_BASE_URL;

let testDb: Client | null = null;
let tempDir: string;

function createFactory() {
  return () => ({
    discover: async () => ({}),
    query: async () => ({}),
    execute: async () => ({}),
  });
}

function keyHeaders(rawKey: string): Record<string, string> {
  return { "x-api-key": rawKey };
}

function createTestApp(registry: AdapterRegistry): Hono {
  const app = new Hono();
  app.route("/connect", createConnectRoutes(registry));
  return app;
}

async function writeAdapter(platform: string, manifestSource: string): Promise<string> {
  const importPath = pathToFileURL(path.resolve(process.cwd(), "src", "adapter-api.ts")).href;
  const filePath = path.join(tempDir, `${platform}.ts`);
  const source = [
    `import { type AgpAdapter, type AdapterContext, type BusinessProfile, type ExecuteOptions, defineManifest } from '${importPath}';`,
    "",
    `export const manifest = defineManifest(${manifestSource});`,
    "",
    "export default class TestAdapter implements AgpAdapter {",
    "  constructor(private readonly _business: BusinessProfile, private readonly _ctx: AdapterContext) {}",
    "  async discover(_ctx: AdapterContext) { return {}; }",
    "  async query(_request: Record<string, unknown>, _ctx: AdapterContext) { return {}; }",
    "  async execute(_request: Record<string, unknown>, _options: ExecuteOptions | undefined, _ctx: AdapterContext) { return {}; }",
    "}",
    "",
  ].join("\n");

  await Bun.write(filePath, source);
  return filePath;
}

beforeEach(async () => {
  process.env.AGENR_BASE_URL = "http://localhost:3001";
  tempDir = await mkdtemp(path.join(tmpdir(), "agenr-adapter-oauth-"));

  testDb = createClient({ url: ":memory:" });
  setDb(testDb);
  await migrate();
});

afterEach(async () => {
  if (ORIGINAL_AGENR_BASE_URL === undefined) {
    delete process.env.AGENR_BASE_URL;
  } else {
    process.env.AGENR_BASE_URL = ORIGINAL_AGENR_BASE_URL;
  }

  await rm(tempDir, { recursive: true, force: true });

  if (testDb) {
    await testDb.close();
  }
  setDb(null);
  testDb = null;
});

describe("adapter oauth routes", () => {
  test("GET /connect/services includes configured adapter oauth services", async () => {
    const registry = new AdapterRegistry();
    registry.registerPublic(
      "github-issues",
      createFactory(),
      "/tmp/github-issues.ts",
      { name: "GitHub Issues" },
      {
        platform: "github-issues",
        auth: {
          type: "oauth2",
          strategy: "bearer",
          oauth: {
            oauthService: "github",
            authorizationUrl: "https://github.com/login/oauth/authorize",
            tokenUrl: "https://github.com/login/oauth/access_token",
          },
        },
        authenticatedDomains: ["api.github.com"],
      },
    );

    await storeAppCredential("github", {
      clientId: "gh_client_123",
      clientSecret: "gh_secret_123",
    });

    const app = createTestApp(registry);
    const key = await createApiKey({ label: "adapter-oauth-services", tier: "paid" });

    const response = await app.request("/connect/services", {
      headers: keyHeaders(key.raw),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      services: [{ service: "github", name: "GitHub Issues", platforms: ["github-issues"] }],
    });
  });

  test("GET /connect/services deduplicates by oauthService", async () => {
    const registry = new AdapterRegistry();

    registry.registerPublic(
      "github-issues",
      createFactory(),
      "/tmp/github-issues.ts",
      { name: "GitHub Issues" },
      {
        platform: "github-issues",
        auth: {
          type: "oauth2",
          strategy: "bearer",
          oauth: {
            oauthService: "github",
            authorizationUrl: "https://github.com/login/oauth/authorize",
            tokenUrl: "https://github.com/login/oauth/access_token",
          },
        },
        authenticatedDomains: ["api.github.com"],
      },
    );

    registry.registerPublic(
      "github-repos",
      createFactory(),
      "/tmp/github-repos.ts",
      { name: "GitHub Repos" },
      {
        platform: "github-repos",
        auth: {
          type: "oauth2",
          strategy: "bearer",
          oauth: {
            oauthService: "github",
            authorizationUrl: "https://github.com/login/oauth/authorize",
            tokenUrl: "https://github.com/login/oauth/access_token",
          },
        },
        authenticatedDomains: ["api.github.com"],
      },
    );

    await storeAppCredential("github", {
      clientId: "gh_client_123",
      clientSecret: "gh_secret_123",
    });

    const app = createTestApp(registry);
    const key = await createApiKey({ label: "adapter-oauth-services-dedupe", tier: "paid" });

    const response = await app.request("/connect/services", {
      headers: keyHeaders(key.raw),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      services: [
        {
          service: "github",
          name: "GitHub Issues",
          platforms: ["github-issues", "github-repos"],
        },
      ],
    });
  });

  test("GET /connect/services returns empty when no oauth adapters are available", async () => {
    const registry = new AdapterRegistry();
    registry.registerPublic(
      "stripe",
      createFactory(),
      "/tmp/stripe.ts",
      { name: "Stripe" },
      {
        platform: "stripe",
        auth: {
          type: "api_key",
          strategy: "bearer",
        },
        authenticatedDomains: ["api.stripe.com"],
      },
    );

    const app = createTestApp(registry);
    const key = await createApiKey({ label: "adapter-oauth-services-empty", tier: "paid" });

    const response = await app.request("/connect/services", {
      headers: keyHeaders(key.raw),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ services: [] });
  });

  test("GET /connect/:service resolves oauth from adapter manifest", async () => {
    const registry = new AdapterRegistry();
    registry.registerPublic(
      "github-issues",
      createFactory(),
      "/tmp/github-issues.ts",
      { name: "GitHub Issues" },
      {
        platform: "github-issues",
        auth: {
          type: "oauth2",
          strategy: "bearer",
          scopes: ["repo", "read:user"],
          oauth: {
            oauthService: "github",
            authorizationUrl: "https://github.com/login/oauth/authorize",
            tokenUrl: "https://github.com/login/oauth/access_token",
            tokenContentType: "form",
          },
        },
        authenticatedDomains: ["api.github.com"],
      },
    );

    await storeAppCredential("github", {
      clientId: "gh_client_123",
      clientSecret: "gh_secret_123",
    });

    const app = createTestApp(registry);
    const key = await createApiKey({ label: "adapter-oauth-connect", tier: "paid" });

    const response = await app.request("/connect/github-issues", {
      headers: keyHeaders(key.raw),
    });

    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toBeTruthy();
    const redirectUrl = new URL(location!);
    expect(redirectUrl.origin).toBe("https://github.com");
    expect(redirectUrl.pathname).toBe("/login/oauth/authorize");
    expect(redirectUrl.searchParams.get("client_id")).toBe("gh_client_123");
    expect(redirectUrl.searchParams.get("scope")).toBe("repo read:user");
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe("http://localhost:3001/connect/github/callback");

    const state = redirectUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    const stateResult = await getDb().execute({
      sql: "SELECT service FROM oauth_states WHERE state = ? LIMIT 1",
      args: [state!],
    });
    const row = stateResult.rows[0] as Record<string, unknown> | undefined;
    expect(row?.["service"]).toBe("github");
  });

  test("GET /connect/:service returns 400 for unknown service", async () => {
    const app = createTestApp(new AdapterRegistry());
    const key = await createApiKey({ label: "adapter-oauth-unknown", tier: "paid" });

    const response = await app.request("/connect/missing", {
      headers: keyHeaders(key.raw),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Unknown service" });
  });

  test("GET /connect/:service returns 404 when app credentials are missing", async () => {
    const registry = new AdapterRegistry();
    registry.registerPublic(
      "github-issues",
      createFactory(),
      "/tmp/github-issues.ts",
      { name: "GitHub Issues" },
      {
        platform: "github-issues",
        auth: {
          type: "oauth2",
          strategy: "bearer",
          oauth: {
            oauthService: "github",
            authorizationUrl: "https://github.com/login/oauth/authorize",
            tokenUrl: "https://github.com/login/oauth/access_token",
          },
        },
        authenticatedDomains: ["api.github.com"],
      },
    );

    const app = createTestApp(registry);
    const key = await createApiKey({ label: "adapter-oauth-no-creds", tier: "paid" });

    const response = await app.request("/connect/github", {
      headers: keyHeaders(key.raw),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "OAuth credentials for Github are not configured. Ask the admin to set up OAuth app credentials.",
    });
  });
});
