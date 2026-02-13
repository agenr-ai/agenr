import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type Client } from "@libsql/client";

import { AdapterRegistry, compareSemverVersions } from "../../src/core/adapter-registry";
import { getPublicAdapterByPlatform, seedBundledAdapter } from "../../src/db/adapters";
import { setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { resolvePublicAdapterPath } from "../../src/utils/adapter-paths";
import type { BusinessProfile } from "../../src/types/profile";
import { createMockContext } from "../helpers/mock-context";

let testDb: Client | null = null;
let tempRoot = "";
let bundledAdaptersDir = "";
let originalAdaptersDir: string | undefined;
let originalBundledAdaptersDir: string | undefined;

function adapterSource(params: { name: string; platform: string; version: string; tag: string }): string {
  const importPath = pathToFileURL(path.resolve(process.cwd(), "src", "adapter-api.ts")).href;

  return [
    `import { type AgpAdapter, type AdapterContext, type BusinessProfile, type ExecuteOptions, defineManifest } from '${importPath}';`,
    "",
    "export const manifest = defineManifest({",
    `  name: '${params.name}',`,
    `  version: '${params.version}',`,
    `  platform: '${params.platform}',`,
    "  auth: { type: 'none', strategy: 'none' },",
    "  authenticatedDomains: [],",
    "  allowedDomains: ['localhost'],",
    "});",
    "",
    "export default class BundledTestAdapter implements AgpAdapter {",
    "  constructor(private readonly _business: BusinessProfile, private readonly _ctx: AdapterContext) {}",
    "  async discover(_ctx: AdapterContext) {",
    `    return { tag: '${params.tag}', version: '${params.version}' };`,
    "  }",
    "  async query(_request: Record<string, unknown>, _ctx: AdapterContext) {",
    `    return { tag: '${params.tag}', version: '${params.version}' };`,
    "  }",
    "  async execute(_request: Record<string, unknown>, _options: ExecuteOptions | undefined, _ctx: AdapterContext) {",
    `    return { tag: '${params.tag}', version: '${params.version}' };`,
    "  }",
    "}",
    "",
  ].join("\n");
}

function createBusiness(platform: string): BusinessProfile {
  return {
    id: `${platform}-business`,
    name: `${platform} business`,
    platform,
  };
}

async function writeBundledAdapter(fileName: string, sourceCode: string): Promise<void> {
  await writeFile(path.join(bundledAdaptersDir, fileName), sourceCode, "utf8");
}

beforeEach(async () => {
  originalAdaptersDir = process.env.AGENR_ADAPTERS_DIR;
  originalBundledAdaptersDir = process.env.AGENR_BUNDLED_ADAPTERS_DIR;

  tempRoot = await mkdtemp(path.join(tmpdir(), "agenr-bundled-adapters-"));
  const runtimeAdaptersDir = path.join(tempRoot, "runtime-adapters");
  bundledAdaptersDir = path.join(tempRoot, "bundled-adapters");
  await mkdir(runtimeAdaptersDir, { recursive: true });
  await mkdir(bundledAdaptersDir, { recursive: true });

  process.env.AGENR_ADAPTERS_DIR = runtimeAdaptersDir;
  process.env.AGENR_RUNTIME_ADAPTERS_DIR = runtimeAdaptersDir;
  process.env.AGENR_BUNDLED_ADAPTERS_DIR = bundledAdaptersDir;

  testDb = createClient({ url: ":memory:" });
  setDb(testDb);
  await migrate();
});

afterEach(async () => {
  if (originalAdaptersDir === undefined) {
    delete process.env.AGENR_ADAPTERS_DIR;
    delete process.env.AGENR_RUNTIME_ADAPTERS_DIR;
  } else {
    process.env.AGENR_ADAPTERS_DIR = originalAdaptersDir;
    process.env.AGENR_RUNTIME_ADAPTERS_DIR = originalAdaptersDir;
  }

  if (originalBundledAdaptersDir === undefined) {
    delete process.env.AGENR_BUNDLED_ADAPTERS_DIR;
  } else {
    process.env.AGENR_BUNDLED_ADAPTERS_DIR = originalBundledAdaptersDir;
  }

  if (testDb) {
    await testDb.close();
  }
  setDb(null);
  testDb = null;

  await rm(tempRoot, { recursive: true, force: true });
  tempRoot = "";
  bundledAdaptersDir = "";
});

describe("bundled adapters", () => {
  test("seeds bundled adapter when platform has no public adapter", async () => {
    await writeBundledAdapter(
      "stripe.ts",
      adapterSource({
        name: "Stripe",
        platform: "stripe",
        version: "1.1.0",
        tag: "bundled-seed",
      }),
    );

    const registry = new AdapterRegistry();
    await registry.seedBundledAdapters();

    const seeded = await getPublicAdapterByPlatform("stripe");
    expect(seeded).not.toBeNull();
    expect(seeded?.status).toBe("public");
    expect(seeded?.ownerId).toBe("system");
    expect(seeded?.sourceCode).toContain("bundled-seed");

    const entry = registry.getPublicEntry("stripe");
    expect(entry).toBeDefined();
    const ctx = createMockContext({ platform: "stripe", manifest: entry?.manifest });
    const queried = await entry!.factory(createBusiness("stripe"), ctx).query({}, ctx);
    expect(queried).toEqual({
      tag: "bundled-seed",
      version: "1.1.0",
    });
  });

  test("updates bundled adapter when DB version is older", async () => {
    const runtimeFilePath = resolvePublicAdapterPath("stripe");
    await seedBundledAdapter({
      platform: "stripe",
      filePath: runtimeFilePath,
      sourceCode: adapterSource({
        name: "Stripe",
        platform: "stripe",
        version: "1.0.0",
        tag: "db-old",
      }),
    });

    await writeBundledAdapter(
      "stripe.ts",
      adapterSource({
        name: "Stripe",
        platform: "stripe",
        version: "1.1.0",
        tag: "bundled-new",
      }),
    );

    const registry = new AdapterRegistry();
    await registry.seedBundledAdapters();

    const updated = await getPublicAdapterByPlatform("stripe");
    expect(updated).not.toBeNull();
    expect(updated?.sourceCode).toContain("version: '1.1.0'");
    expect(updated?.sourceCode).toContain("bundled-new");
  });

  test("skips bundled adapter when DB version is same", async () => {
    const runtimeFilePath = resolvePublicAdapterPath("stripe");
    await seedBundledAdapter({
      platform: "stripe",
      filePath: runtimeFilePath,
      sourceCode: adapterSource({
        name: "Stripe",
        platform: "stripe",
        version: "1.1.0",
        tag: "db-custom-same",
      }),
    });
    const before = await getPublicAdapterByPlatform("stripe");

    await writeBundledAdapter(
      "stripe.ts",
      adapterSource({
        name: "Stripe",
        platform: "stripe",
        version: "1.1.0",
        tag: "bundled-same",
      }),
    );

    const registry = new AdapterRegistry();
    await registry.seedBundledAdapters();

    const after = await getPublicAdapterByPlatform("stripe");
    expect(after?.sourceHash).toBe(before?.sourceHash);
    expect(after?.promotedAt).toBe(before?.promotedAt);
    expect(after?.sourceCode).toContain("db-custom-same");
  });

  test("skips bundled adapter when DB version is newer", async () => {
    const runtimeFilePath = resolvePublicAdapterPath("stripe");
    await seedBundledAdapter({
      platform: "stripe",
      filePath: runtimeFilePath,
      sourceCode: adapterSource({
        name: "Stripe",
        platform: "stripe",
        version: "2.0.0",
        tag: "db-custom-newer",
      }),
    });
    const before = await getPublicAdapterByPlatform("stripe");

    await writeBundledAdapter(
      "stripe.ts",
      adapterSource({
        name: "Stripe",
        platform: "stripe",
        version: "1.1.0",
        tag: "bundled-older",
      }),
    );

    const registry = new AdapterRegistry();
    await registry.seedBundledAdapters();

    const after = await getPublicAdapterByPlatform("stripe");
    expect(after?.sourceHash).toBe(before?.sourceHash);
    expect(after?.promotedAt).toBe(before?.promotedAt);
    expect(after?.sourceCode).toContain("db-custom-newer");
  });

  test("semver comparison works correctly", () => {
    expect(compareSemverVersions("1.0.0", "1.1.0")).toBe(-1);
    expect(compareSemverVersions("1.1.0", "1.1.1")).toBe(-1);
    expect(compareSemverVersions("1.1.1", "2.0.0")).toBe(-1);
    expect(compareSemverVersions("2.0.0", "2.0.0")).toBe(0);
    expect(compareSemverVersions("2.0.1", "2.0.0")).toBe(1);
  });
});
