/**
 * Regression tests for the bundled/runtime adapter directory separation.
 *
 * Background: on staging, restoreFromDatabase() wrote old DB source code into
 * data/adapters/stripe.ts, overwriting the pristine bundled file BEFORE the
 * seeder ran.  The seeder then read the corrupted file and failed.
 *
 * The fix: bundled source lives in data/adapters/ (read-only at runtime).
 * All runtime writes go to data/runtime-adapters/.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";

import { createClient, type Client } from "@libsql/client";

import { AdapterRegistry } from "../../src/core/adapter-registry";
import {
  getPublicAdapterByPlatform,
  seedBundledAdapter,
  upsertSandboxAdapter,
} from "../../src/db/adapters";
import { createApiKey } from "../../src/db/api-keys";
import { setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import {
  resolvePublicAdapterPath,
  resolveSandboxAdapterPath,
} from "../../src/utils/adapter-paths";
import { createConnectRoutes } from "../../src/routes/connect";
import { storeAppCredential, deleteAppCredential } from "../../src/vault/app-credential-store";
import { createMockContext } from "../helpers/mock-context";
import type { BusinessProfile } from "../../src/types/profile";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

let testDb: Client | null = null;
let tempRoot = "";
let bundledDir = "";
let runtimeDir = "";
let originalAdaptersDir: string | undefined;
let originalRuntimeDir: string | undefined;
let originalBundledDir: string | undefined;

function adapterSource(params: {
  platform: string;
  version: string;
  tag: string;
  name?: string;
  oauth?: boolean;
  authenticatedDomains?: string[];
}): string {
  const importPath = pathToFileURL(path.resolve(process.cwd(), "src", "adapter-api.ts")).href;

  const authBlock = params.oauth
    ? [
        "  auth: {",
        "    type: 'oauth2',",
        "    strategy: 'bearer',",
        "    scopes: ['read_write'],",
        "    oauth: {",
        "      authorizationUrl: 'https://connect.example.com/authorize',",
        "      tokenUrl: 'https://connect.example.com/token',",
        "      tokenContentType: 'form',",
        "    },",
        "  },",
        `  authenticatedDomains: [${(params.authenticatedDomains ?? ["api.example.com"]).map((d) => `'${d}'`).join(", ")}],`,
        "  allowedDomains: [],",
      ].join("\n")
    : [
        "  auth: { type: 'none', strategy: 'none' },",
        "  authenticatedDomains: [],",
        "  allowedDomains: ['localhost'],",
      ].join("\n");

  return [
    `import { type AgpAdapter, type AdapterContext, type BusinessProfile, type ExecuteOptions, defineManifest } from '${importPath}';`,
    "",
    "export const manifest = defineManifest({",
    `  name: '${params.name ?? params.platform}',`,
    `  version: '${params.version}',`,
    `  platform: '${params.platform}',`,
    authBlock,
    "});",
    "",
    "export default class TestAdapter implements AgpAdapter {",
    "  constructor(private readonly _b: BusinessProfile, private readonly _c: AdapterContext) {}",
    `  async discover(_ctx: AdapterContext) { return { tag: '${params.tag}', version: '${params.version}' }; }`,
    `  async query(r: Record<string, unknown>, _ctx: AdapterContext) { return { tag: '${params.tag}', request: r }; }`,
    `  async execute(r: Record<string, unknown>, _o: ExecuteOptions | undefined, _ctx: AdapterContext) { return { tag: '${params.tag}', request: r }; }`,
    "}",
    "",
  ].join("\n");
}

function createBusiness(platform: string): BusinessProfile {
  return { id: `${platform}-biz`, name: `${platform} business`, platform };
}

beforeEach(async () => {
  originalAdaptersDir = process.env.AGENR_ADAPTERS_DIR;
  originalRuntimeDir = process.env.AGENR_RUNTIME_ADAPTERS_DIR;
  originalBundledDir = process.env.AGENR_BUNDLED_ADAPTERS_DIR;

  tempRoot = await mkdtemp(path.join(tmpdir(), "agenr-regression-"));
  bundledDir = path.join(tempRoot, "bundled");
  runtimeDir = path.join(tempRoot, "runtime");
  await mkdir(bundledDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });

  process.env.AGENR_ADAPTERS_DIR = runtimeDir;
  process.env.AGENR_RUNTIME_ADAPTERS_DIR = runtimeDir;
  process.env.AGENR_BUNDLED_ADAPTERS_DIR = bundledDir;

  testDb = createClient({ url: ":memory:" });
  setDb(testDb);
  await migrate();
});

afterEach(async () => {
  const restore = (key: string, original: string | undefined) => {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  };
  restore("AGENR_ADAPTERS_DIR", originalAdaptersDir);
  restore("AGENR_RUNTIME_ADAPTERS_DIR", originalRuntimeDir);
  restore("AGENR_BUNDLED_ADAPTERS_DIR", originalBundledDir);

  if (testDb) await testDb.close();
  setDb(null);
  testDb = null;
  await rm(tempRoot, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/*  Regression tests                                                  */
/* ------------------------------------------------------------------ */

describe("bundled / runtime adapter isolation (regression)", () => {
  test("seeder reads bundled files from the bundled directory, not runtime", async () => {
    const bundledSource = adapterSource({ platform: "stripe", version: "1.0.0", tag: "bundled-pristine" });
    await writeFile(path.join(bundledDir, "stripe.ts"), bundledSource, "utf8");

    expect(existsSync(path.join(runtimeDir, "stripe.ts"))).toBe(false);

    const registry = new AdapterRegistry();
    await registry.seedBundledAdapters();

    const seeded = await getPublicAdapterByPlatform("stripe");
    expect(seeded).not.toBeNull();
    expect(seeded?.sourceCode).toContain("bundled-pristine");
    expect(existsSync(path.join(runtimeDir, "stripe.ts"))).toBe(true);
  });

  test("DB restore writes to runtime directory, not bundled directory", async () => {
    const ownerId = "owner-db";
    const sandboxPath = resolveSandboxAdapterPath(ownerId, "stripe");
    const dbSource = adapterSource({ platform: "stripe", version: "0.9.0", tag: "old-db-code" });

    await upsertSandboxAdapter({
      platform: "stripe",
      ownerId,
      filePath: sandboxPath,
      sourceCode: dbSource,
    });

    const registry = new AdapterRegistry();
    await registry.restoreFromDatabase();

    expect(existsSync(sandboxPath)).toBe(true);
    expect(sandboxPath.startsWith(runtimeDir)).toBe(true);

    // Bundled directory must be completely untouched
    expect(readdirSync(bundledDir)).toEqual([]);
  });

  test("after DB restore + seeder run, bundled source files are unchanged", async () => {
    const bundledSource = adapterSource({ platform: "stripe", version: "2.0.0", tag: "pristine-v2" });
    await writeFile(path.join(bundledDir, "stripe.ts"), bundledSource, "utf8");

    // Seed so DB has v2
    const registryA = new AdapterRegistry();
    await registryA.seedBundledAdapters();

    // Corrupt runtime file (simulates old DB restore overwriting)
    const runtimeFilePath = resolvePublicAdapterPath("stripe");
    await writeFile(runtimeFilePath, "// corrupted by DB restore", "utf8");

    // Restore from DB — only touches runtime
    const registryB = new AdapterRegistry();
    await registryB.restoreFromDatabase();

    // Bundled file must still be pristine
    const bundledAfterRestore = await readFile(path.join(bundledDir, "stripe.ts"), "utf8");
    expect(bundledAfterRestore).toBe(bundledSource);

    // Seeder can still read the pristine bundled file
    await registryB.seedBundledAdapters();
    const dbState = await getPublicAdapterByPlatform("stripe");
    expect(dbState?.sourceCode).toContain("pristine-v2");
  });

  test("connect/services endpoint returns service when adapter is loaded + app creds exist", async () => {
    // Seed an OAuth adapter
    const oauthSource = adapterSource({
      platform: "stripe",
      version: "1.0.0",
      tag: "oauth-service-test",
      name: "Stripe",
      oauth: true,
      authenticatedDomains: ["api.stripe.com"],
    });
    await writeFile(path.join(bundledDir, "stripe.ts"), oauthSource, "utf8");

    const registry = new AdapterRegistry();
    await registry.seedBundledAdapters();

    // Store app credentials
    await storeAppCredential("stripe", {
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
    });

    // Create API key
    const apiKey = await createApiKey({ label: "regression-test", tier: "free" });

    // Hit /services
    const app = new Hono();
    app.route("/connect", createConnectRoutes(registry));

    const response = await app.request("/connect/services", {
      headers: { "x-api-key": apiKey.raw },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      services: Array<{ service: string; name: string; platforms: string[] }>;
    };
    expect(body.services).toBeInstanceOf(Array);

    const stripeService = body.services.find((s) => s.service === "stripe");
    expect(stripeService).toBeDefined();
    expect(stripeService?.name).toBe("stripe");
    expect(stripeService?.platforms).toContain("stripe");

    await deleteAppCredential("stripe");
  });
});
