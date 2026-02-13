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

describe("adapter oauth registry", () => {
  test("listOAuthAdapters returns public oauth adapters only", () => {
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
          scopes: ["repo"],
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

    registry.registerScoped(
      "github-private",
      "owner-1",
      createFactory(),
      "/tmp/github-private.ts",
      { name: "GitHub Private" },
      {
        platform: "github-private",
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
      "toast",
      createFactory(),
      "/tmp/toast.ts",
      { name: "Toast" },
      {
        platform: "toast",
        auth: {
          type: "oauth2",
          strategy: "bearer",
        },
        authenticatedDomains: ["ws-api.toasttab.com"],
      },
    );

    const oauthAdapters = registry.listOAuthAdapters();

    expect(oauthAdapters).toEqual([
      {
        platform: "github-issues",
        oauthService: "github",
        name: "GitHub Issues",
        oauth: {
          oauthService: "github",
          authorizationUrl: "https://github.com/login/oauth/authorize",
          tokenUrl: "https://github.com/login/oauth/access_token",
          tokenContentType: "form",
          extraAuthParams: undefined,
        },
        scopes: ["repo"],
      },
    ]);
  });

  test("getOAuthAdapter matches by platform or oauthService", () => {
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
          scopes: ["repo"],
          oauth: {
            oauthService: "github",
            authorizationUrl: "https://github.com/login/oauth/authorize",
            tokenUrl: "https://github.com/login/oauth/access_token",
          },
        },
        authenticatedDomains: ["api.github.com"],
      },
    );

    expect(registry.getOAuthAdapter("github-issues")?.oauthService).toBe("github");
    expect(registry.getOAuthAdapter("github")?.platform).toBe("github-issues");
    expect(registry.getOAuthAdapter("missing")).toBeNull();
  });
});


describe("listOAuthAdapters – manifest without explicit platform field", () => {
  test("hot-loaded adapter with no platform in manifest still appears in listOAuthAdapters", async () => {
    const registry = new AdapterRegistry();

    // Write an adapter whose defineManifest() call omits the platform field
    // (platform is optional in AdapterManifest). This mirrors the real stripe adapter.
    const filePath = await writeAdapter(
      "stripe",
      JSON.stringify({
        name: "Stripe",
        version: "1.0.0",
        auth: {
          type: "oauth2",
          strategy: "bearer",
          oauth: {
            oauthService: "stripe",
            authorizationUrl: "https://connect.stripe.com/oauth/authorize",
            tokenUrl: "https://connect.stripe.com/oauth/token",
          },
        },
        authenticatedDomains: ["api.stripe.com"],
      }),
    );

    await registry.hotLoadPublic("stripe", filePath);

    const oauthAdapters = registry.listOAuthAdapters();
    expect(oauthAdapters.length).toBeGreaterThanOrEqual(1);

    const stripe = oauthAdapters.find((a) => a.platform === "stripe");
    expect(stripe).toBeDefined();
    expect(stripe!.oauthService).toBe("stripe");
    expect(stripe!.oauth.authorizationUrl).toBe("https://connect.stripe.com/oauth/authorize");
  });
});
