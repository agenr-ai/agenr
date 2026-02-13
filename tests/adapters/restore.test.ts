import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createClient, type Client } from "@libsql/client";
import { Hono } from "hono";

import { AdapterRegistry } from "../../src/core/adapter-registry";
import {
  getAdapterByPlatformOwner,
  markAdapterArchived,
  upsertSandboxAdapter,
} from "../../src/db/adapters";
import { createApiKey } from "../../src/db/api-keys";
import { getDb, setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { createAdapterRoutes } from "../../src/routes/adapters";
import { resolveSandboxAdapterPath } from "../../src/utils/adapter-paths";

function createTestApp(registry: AdapterRegistry): Hono {
  const app = new Hono();
  app.route("/", createAdapterRoutes(registry));
  return app;
}

function adminHeaders(): Record<string, string> {
  return { authorization: "Bearer admin-key" };
}

function keyHeaders(rawKey: string): Record<string, string> {
  return { "x-api-key": rawKey };
}

function adapterSourceForPath(filePath: string): string {
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
    "export const meta = { generatedBy: 'test' };",
    "",
    "export default class TestAdapter implements AgpAdapter {",
    "  constructor(private readonly business: BusinessProfile, private readonly _ctx: AdapterContext) {}",
    "  async discover(_ctx: AdapterContext) {",
    "    return { businessId: this.business.id };",
    "  }",
    "  async query(request: Record<string, unknown>, _ctx: AdapterContext) {",
    "    return { request };",
    "  }",
    "  async execute(request: Record<string, unknown>, _options: ExecuteOptions | undefined, _ctx: AdapterContext) {",
    "    return { request };",
    "  }",
    "}",
    "",
  ].join("\n");
}

async function writeAdapterFile(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, adapterSourceForPath(filePath), "utf8");
}

let testDb: Client | null = null;
let originalApiKey: string | undefined;
let originalAdaptersDir: string | undefined;
let testAdaptersDir: string;
const interactionProfilesDirectory = path.resolve(process.cwd(), "data", "interaction-profiles");
const interactionProfileSnapshots = new Map<string, string>(
  ["factor75", "mytime", "square", "stripe", "toast"].map((platform) => [
    platform,
    readFileSync(path.join(interactionProfilesDirectory, `${platform}.json`), "utf8"),
  ]),
);

beforeEach(async () => {
  originalApiKey = process.env.AGENR_API_KEY;
  originalAdaptersDir = process.env.AGENR_ADAPTERS_DIR;
  process.env.AGENR_API_KEY = "admin-key";
  testAdaptersDir = await mkdtemp(path.join(tmpdir(), "agenr-adapters-"));
  process.env.AGENR_ADAPTERS_DIR = testAdaptersDir;
  process.env.AGENR_RUNTIME_ADAPTERS_DIR = testAdaptersDir;

  testDb = createClient({ url: ":memory:" });
  setDb(testDb);
  await migrate();
});

afterEach(async () => {
  if (originalApiKey === undefined) {
    delete process.env.AGENR_API_KEY;
  } else {
    process.env.AGENR_API_KEY = originalApiKey;
  }

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
  await mkdir(interactionProfilesDirectory, { recursive: true });
  for (const [platform, contents] of interactionProfileSnapshots) {
    await writeFile(path.join(interactionProfilesDirectory, `${platform}.json`), contents, "utf8");
  }
});

describe("POST /adapters/:platform/restore", () => {
  test("admin can restore an archived adapter to sandbox status", async () => {
    const registry = new AdapterRegistry();
    const app = createTestApp(registry);
    const owner = await createApiKey({ label: "restore-owner", tier: "paid" });

    const sandboxPath = resolveSandboxAdapterPath(owner.record.id, "restore-test");
    await writeAdapterFile(sandboxPath);
    const adapter = await upsertSandboxAdapter({
      platform: "restore-test",
      ownerId: owner.record.id,
      filePath: sandboxPath,
    });

    await markAdapterArchived({ adapterId: adapter.id });

    const response = await app.request(
      `/adapters/restore-test/restore?owner_id=${owner.record.id}`,
      { method: "POST", headers: adminHeaders() },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("sandbox");

    const updated = await getAdapterByPlatformOwner("restore-test", owner.record.id);
    expect(updated?.status).toBe("sandbox");
    expect(updated?.archivedAt).toBeNull();
  });

  test("non-admin gets 403", async () => {
    const registry = new AdapterRegistry();
    const app = createTestApp(registry);
    const owner = await createApiKey({ label: "restore-nonadmin", tier: "paid" });

    const response = await app.request(
      `/adapters/restore-test/restore?owner_id=${owner.record.id}`,
      { method: "POST", headers: keyHeaders(owner.raw) },
    );

    expect(response.status).toBe(403);
  });

  test("restoring a non-archived adapter returns 404", async () => {
    const registry = new AdapterRegistry();
    const app = createTestApp(registry);
    const owner = await createApiKey({ label: "restore-active", tier: "paid" });

    const sandboxPath = resolveSandboxAdapterPath(owner.record.id, "active-adapter");
    await writeAdapterFile(sandboxPath);
    await upsertSandboxAdapter({
      platform: "active-adapter",
      ownerId: owner.record.id,
      filePath: sandboxPath,
    });

    const response = await app.request(
      `/adapters/active-adapter/restore?owner_id=${owner.record.id}`,
      { method: "POST", headers: adminHeaders() },
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toContain("not found");
  });

  test("after restore, adapter status is sandbox and archived_at is cleared", async () => {
    const registry = new AdapterRegistry();
    const app = createTestApp(registry);
    const owner = await createApiKey({ label: "restore-verify", tier: "paid" });

    const sandboxPath = resolveSandboxAdapterPath(owner.record.id, "verify-restore");
    await writeAdapterFile(sandboxPath);
    const adapter = await upsertSandboxAdapter({
      platform: "verify-restore",
      ownerId: owner.record.id,
      filePath: sandboxPath,
    });

    await markAdapterArchived({ adapterId: adapter.id });

    // Verify it's archived
    const archived = await getAdapterByPlatformOwner("verify-restore", owner.record.id);
    expect(archived?.status).toBe("archived");
    expect(archived?.archivedAt).not.toBeNull();

    await app.request(
      `/adapters/verify-restore/restore?owner_id=${owner.record.id}`,
      { method: "POST", headers: adminHeaders() },
    );

    const restored = await getAdapterByPlatformOwner("verify-restore", owner.record.id);
    expect(restored?.status).toBe("sandbox");
    expect(restored?.archivedAt).toBeNull();
  });
});
