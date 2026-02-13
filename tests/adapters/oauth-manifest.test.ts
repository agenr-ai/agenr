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

describe("adapter oauth manifest parsing", () => {
  test("hot-load keeps valid auth.oauth config", async () => {
    const registry = new AdapterRegistry();
    const filePath = await writeAdapter(
      "github-issues",
      `{
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
      extraAuthParams: { allow_signup: "false" }
    }
  },
  authenticatedDomains: ["api.github.com"]
}`,
    );

    await registry.hotLoadPublic("github-issues", filePath);
    const manifest = registry.getPublicEntry("github-issues")?.manifest;

    expect(manifest?.auth.oauth).toEqual({
      oauthService: "github",
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      tokenContentType: "form",
      extraAuthParams: { allow_signup: "false" },
    });
  });

  test("hot-load accepts oauth2 manifest without auth.oauth", async () => {
    const registry = new AdapterRegistry();
    const filePath = await writeAdapter(
      "stripe-lite",
      `{
  platform: "stripe-lite",
  auth: {
    type: "oauth2",
    strategy: "bearer",
    scopes: ["read_write"]
  },
  authenticatedDomains: ["api.stripe.com"]
}`,
    );

    await registry.hotLoadPublic("stripe-lite", filePath);
    const manifest = registry.getPublicEntry("stripe-lite")?.manifest;

    expect(manifest?.auth.type).toBe("oauth2");
    expect(manifest?.auth.oauth).toBeUndefined();
  });

  test("hot-load drops malformed auth.oauth when oauth urls are not https", async () => {
    const registry = new AdapterRegistry();
    const filePath = await writeAdapter(
      "insecure-oauth",
      `{
  platform: "insecure-oauth",
  auth: {
    type: "oauth2",
    strategy: "bearer",
    oauth: {
      authorizationUrl: "http://localhost:9999/authorize",
      tokenUrl: "http://localhost:9999/token"
    }
  },
  authenticatedDomains: ["localhost"]
}`,
    );

    await registry.hotLoadPublic("insecure-oauth", filePath);
    const manifest = registry.getPublicEntry("insecure-oauth")?.manifest;

    expect(manifest).toBeDefined();
    expect(manifest?.auth.type).toBe("oauth2");
    expect(manifest?.auth.oauth).toBeUndefined();
  });
});

