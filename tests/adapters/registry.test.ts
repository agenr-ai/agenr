import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createClient, type Client } from "@libsql/client";

import { AdapterRegistry } from "../../src/core/adapter-registry";
import {
  getAdapterByPlatformOwner,
  markAdapterPublic,
  upsertSandboxAdapter,
} from "../../src/db/adapters";
import { getDb, setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import type { BusinessProfile } from "../../src/types/profile";
import { resolvePublicAdapterPath, resolveSandboxAdapterPath } from "../../src/utils/adapter-paths";
import { createMockContext } from "../helpers/mock-context";

function adapterSourceForPath(filePath: string, tag: string): string {
  const importPath = pathToFileURL(path.resolve(process.cwd(), "src", "adapter-api.ts")).href;
  const platform = path.basename(filePath, ".ts");

  return [
    `import { type AgpAdapter, type AdapterContext, type BusinessProfile, type ExecuteOptions, defineManifest } from '${importPath}';`,
    "",
    "export const manifest = defineManifest({",
    `  platform: '${platform}',`,
    "  auth: { type: 'none', strategy: 'none' },",
    "  authenticatedDomains: [],",
    "  allowedDomains: ['localhost'],",
    "});",
    "",
    "export default class TestAdapter implements AgpAdapter {",
    "  constructor(private readonly business: BusinessProfile, private readonly _ctx: AdapterContext) {}",
    "  async discover(_ctx: AdapterContext) {",
    `    return { tag: '${tag}', platform: this.business.platform };`,
    "  }",
    "  async query(request: Record<string, unknown>, _ctx: AdapterContext) {",
    `    return { tag: '${tag}', request };`,
    "  }",
    "  async execute(request: Record<string, unknown>, _options: ExecuteOptions | undefined, _ctx: AdapterContext) {",
    `    return { tag: '${tag}', request };`,
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

let testDb: Client | null = null;
let testAdaptersDir: string;
let originalAdaptersDir: string | undefined;

beforeEach(async () => {
  originalAdaptersDir = process.env.AGENR_ADAPTERS_DIR;
  testAdaptersDir = await mkdtemp(path.join(tmpdir(), "agenr-registry-adapters-"));
  process.env.AGENR_ADAPTERS_DIR = testAdaptersDir;
  process.env.AGENR_RUNTIME_ADAPTERS_DIR = testAdaptersDir;

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

  if (testDb) {
    await testDb.close();
  }
  setDb(null);
  testDb = null;

  await rm(testAdaptersDir, { recursive: true, force: true });
});

describe("adapter registry DB restore/sync", () => {
  test("restoreFromDatabase writes adapter files and loadDynamicAdapters can hot-load them", async () => {
    const ownerId = "owner-restore";
    const filePath = resolveSandboxAdapterPath(ownerId, "toast");
    const sourceCode = adapterSourceForPath(filePath, "restore");
    await upsertSandboxAdapter({
      platform: "toast",
      ownerId,
      filePath,
      sourceCode,
    });

    const registry = new AdapterRegistry();
    expect(existsSync(filePath)).toBe(false);

    await registry.restoreFromDatabase();
    expect(existsSync(filePath)).toBe(true);
    expect(await readFile(filePath, "utf8")).toBe(sourceCode);

    await registry.loadDynamicAdapters();
    const entry = registry.getScopedEntry("toast", ownerId);
    expect(entry).toBeDefined();
    const ctx = createMockContext({ platform: "toast", manifest: entry?.manifest });
    const queried = await entry!.factory(createBusiness("toast"), ctx).query({}, ctx);
    expect(queried).toEqual({ tag: "restore", request: {} });
    expect(entry?.manifest?.platform).toBe("toast");
  });

  test("syncFromDatabase hot-loads newly added adapters", async () => {
    const ownerId = "owner-sync-new";
    const filePath = resolveSandboxAdapterPath(ownerId, "square");
    await upsertSandboxAdapter({
      platform: "square",
      ownerId,
      filePath,
      sourceCode: adapterSourceForPath(filePath, "new"),
    });

    const registry = new AdapterRegistry();
    await registry.syncFromDatabase();

    const entry = registry.getScopedEntry("square", ownerId);
    expect(entry).toBeDefined();
    const ctx = createMockContext({ platform: "square", manifest: entry?.manifest });
    const queried = await entry!.factory(createBusiness("square"), ctx).query({}, ctx);
    expect(queried).toEqual({ tag: "new", request: {} });
  });

  test("syncFromDatabase re-hot-loads when source hash changes for same adapter id", async () => {
    const ownerId = "owner-sync-update";
    const filePath = resolveSandboxAdapterPath(ownerId, "factor");
    const initial = await upsertSandboxAdapter({
      platform: "factor",
      ownerId,
      filePath,
      sourceCode: adapterSourceForPath(filePath, "v1"),
    });

    const registry = new AdapterRegistry();
    await registry.syncFromDatabase();
    const firstEntry = registry.getScopedEntry("factor", ownerId);
    expect(firstEntry).toBeDefined();
    const firstCtx = createMockContext({ platform: "factor", manifest: firstEntry?.manifest });
    expect(await firstEntry!.factory(createBusiness("factor"), firstCtx).query({}, firstCtx)).toEqual({
      tag: "v1",
      request: {},
    });

    await upsertSandboxAdapter({
      platform: "factor",
      ownerId,
      filePath,
      sourceCode: adapterSourceForPath(filePath, "v2"),
    });

    await registry.syncFromDatabase();
    const secondEntry = registry.getScopedEntry("factor", ownerId);
    expect(secondEntry).toBeDefined();
    expect(secondEntry?.factory).not.toBe(firstEntry?.factory);
    const secondCtx = createMockContext({ platform: "factor", manifest: secondEntry?.manifest });
    expect(await secondEntry!.factory(createBusiness("factor"), secondCtx).query({}, secondCtx)).toEqual({
      tag: "v2",
      request: {},
    });
    expect((await getAdapterByPlatformOwner("factor", ownerId))?.id).toBe(initial.id);
  });

  test("syncFromDatabase re-registers adapter when status changes with same source", async () => {
    const ownerId = "owner-sync-status";
    const sandboxPath = resolveSandboxAdapterPath(ownerId, "stripe");
    const publicPath = resolvePublicAdapterPath("stripe");
    const sourceCode = adapterSourceForPath(sandboxPath, "same-code");
    const sandbox = await upsertSandboxAdapter({
      platform: "stripe",
      ownerId,
      filePath: sandboxPath,
      sourceCode,
    });

    const registry = new AdapterRegistry();
    await registry.syncFromDatabase();
    expect(registry.getScopedEntry("stripe", ownerId)).toBeDefined();
    expect(registry.getPublicEntry("stripe")).toBeUndefined();

    await markAdapterPublic({
      adapterId: sandbox.id,
      promotedBy: "admin",
      filePath: publicPath,
    });

    await registry.syncFromDatabase();
    expect(registry.getScopedEntry("stripe", ownerId)).toBeUndefined();
    const publicEntry = registry.getPublicEntry("stripe");
    expect(publicEntry).toBeDefined();
    const ctx = createMockContext({ platform: "stripe", manifest: publicEntry?.manifest });
    expect(await publicEntry!.factory(createBusiness("stripe"), ctx).query({}, ctx)).toEqual({
      tag: "same-code",
      request: {},
    });
    expect(await readFile(publicPath, "utf8")).toContain("same-code");
  });

  test("restoreFromDatabase and syncFromDatabase skip adapter rows with unsafe file paths", async () => {
    const outsidePath = path.join(tmpdir(), `agenr-outside-${crypto.randomUUID()}.ts`);
    const now = new Date().toISOString();
    await getDb().execute({
      sql: `INSERT INTO adapters (
        id,
        platform,
        owner_id,
        status,
        file_path,
        source_code,
        source_hash,
        created_at,
        promoted_at,
        promoted_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        crypto.randomUUID(),
        "unsafe",
        "owner-unsafe",
        "sandbox",
        outsidePath,
        "export default class Unsafe {}",
        "fake-hash",
        now,
        null,
        null,
      ],
    });

    const registry = new AdapterRegistry();
    await registry.restoreFromDatabase();
    await registry.syncFromDatabase();

    expect(existsSync(outsidePath)).toBe(false);
    expect(registry.getScopedEntry("unsafe", "owner-unsafe")).toBeUndefined();

    await rm(outsidePath, { force: true });
  });
});
