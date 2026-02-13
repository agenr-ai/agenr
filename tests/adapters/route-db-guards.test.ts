import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createClient, type Client } from "@libsql/client";
import { Hono } from "hono";

import { AdapterRegistry } from "../../src/core/adapter-registry";
import {
  getAdapterById,
  getAdapterByPlatformOwner,
  getPublicAdapterByPlatform,
  markAdapterPublic,
  markAdapterReview,
  upsertSandboxAdapter,
} from "../../src/db/adapters";
import { createApiKey } from "../../src/db/api-keys";
import { getDb, setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { createAdapterRoutes } from "../../src/routes/adapters";
import {
  resolvePublicAdapterPath,
  resolveSandboxAdapterPath,
} from "../../src/utils/adapter-paths";

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

function createTestFactory(resultTag: string) {
  return () => ({
    discover: async () => ({ ok: true, tag: resultTag }),
    query: async () => ({ ok: true, tag: resultTag }),
    execute: async () => ({ ok: true, tag: resultTag }),
  });
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

describe("adapter route db guards", () => {
  test("non-admin delete of another owner's public adapter returns not found", async () => {
    const app = createTestApp(new AdapterRegistry());
    const ownerA = await createApiKey({ label: "ownerA", tier: "paid" });
    const ownerB = await createApiKey({ label: "ownerB", tier: "paid" });

    const sandboxPath = resolveSandboxAdapterPath(ownerA.record.id, "toast");
    const publicPath = resolvePublicAdapterPath("toast");
    await writeAdapterFile(sandboxPath);
    await upsertSandboxAdapter({
      platform: "toast",
      ownerId: ownerA.record.id,
      filePath: sandboxPath,
    });
    await writeFile(publicPath, await readFile(sandboxPath, "utf8"));
    await markAdapterPublic({
      adapterId: (await getAdapterByPlatformOwner("toast", ownerA.record.id))!.id,
      promotedBy: "admin",
      filePath: publicPath,
    });

    const response = await app.request("/adapters/toast", {
      method: "DELETE",
      headers: keyHeaders(ownerB.raw),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Adapter not found",
    });
    expect(await getPublicAdapterByPlatform("toast")).not.toBeNull();
  });

  test("non-admin cannot delete another owner's sandbox adapter", async () => {
    const app = createTestApp(new AdapterRegistry());
    const ownerA = await createApiKey({ label: "ownerA", tier: "paid" });
    const ownerB = await createApiKey({ label: "ownerB", tier: "paid" });

    const sandboxPath = resolveSandboxAdapterPath(ownerA.record.id, "square");
    await writeAdapterFile(sandboxPath);
    await upsertSandboxAdapter({
      platform: "square",
      ownerId: ownerA.record.id,
      filePath: sandboxPath,
    });

    const response = await app.request("/adapters/square", {
      method: "DELETE",
      headers: keyHeaders(ownerB.raw),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Adapter not found",
    });
    expect(await getAdapterByPlatformOwner("square", ownerA.record.id)).not.toBeNull();
  });

  test("delete route returns sanitized 500 payload when filesystem removal throws", async () => {
    const app = createTestApp(new AdapterRegistry());
    const owner = await createApiKey({ label: "owner", tier: "paid" });
    const sandboxPath = resolveSandboxAdapterPath(owner.record.id, "toast");
    await mkdir(sandboxPath, { recursive: true });
    await upsertSandboxAdapter({
      platform: "toast",
      ownerId: owner.record.id,
      filePath: sandboxPath,
      sourceCode: "export default class TestAdapter {}",
    });

    const response = await app.request("/adapters/toast", {
      method: "DELETE",
      headers: keyHeaders(owner.raw),
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Internal server error");
    expect(typeof body.requestId).toBe("string");
    expect(JSON.stringify(body).toLowerCase().includes("eisdir")).toBe(false);
    expect(JSON.stringify(body)).not.toContain(sandboxPath);
  });

  test("promote route returns sanitized 500 payload when sandbox file is missing", async () => {
    const app = createTestApp(new AdapterRegistry());
    const owner = await createApiKey({ label: "owner", tier: "paid" });
    const sandboxPath = resolveSandboxAdapterPath(owner.record.id, "stripe");
    await upsertSandboxAdapter({
      platform: "stripe",
      ownerId: owner.record.id,
      filePath: sandboxPath,
      sourceCode: "export default class TestAdapter {}",
    });

    const response = await app.request(`/adapters/stripe/promote?owner_id=${owner.record.id}`, {
      method: "POST",
      headers: adminHeaders(),
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Internal server error");
    expect(typeof body.requestId).toBe("string");
    expect(JSON.stringify(body)).not.toContain(sandboxPath);
  });

  test("admin can delete sandbox adapters", async () => {
    const registry = new AdapterRegistry();
    const app = createTestApp(registry);
    const owner = await createApiKey({ label: "owner", tier: "paid" });

    const sandboxPath = resolveSandboxAdapterPath(owner.record.id, "mytime");
    await writeAdapterFile(sandboxPath);
    await upsertSandboxAdapter({
      platform: "mytime",
      ownerId: owner.record.id,
      filePath: sandboxPath,
    });
    registry.registerScoped("mytime", owner.record.id, createTestFactory("sandbox"), sandboxPath);

    const response = await app.request("/adapters/mytime", {
      method: "DELETE",
      headers: adminHeaders(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ platform: "mytime", status: "archived", scope: "sandbox" });
    expect((await getAdapterByPlatformOwner("mytime", owner.record.id))?.status).toBe("archived");
    expect(registry.getScopedEntry("mytime", owner.record.id)).toBeUndefined();
  });

  test("GET /adapters/jobs owner filter is applied in db query path", async () => {
    const ownerA = await createApiKey({ label: "ownerA", tier: "paid" });
    const ownerB = await createApiKey({ label: "ownerB", tier: "paid" });

    await getDb().execute({
      sql: `INSERT INTO generation_jobs (
        id, platform, docs_url, provider, model, status, owner_key_id, logs, result, error, created_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        crypto.randomUUID(),
        "toast",
        null,
        null,
        null,
        "queued",
        ownerA.record.id,
        "[]",
        null,
        null,
        new Date().toISOString(),
        null,
        null,
      ],
    });
    await getDb().execute({
      sql: `INSERT INTO generation_jobs (
        id, platform, docs_url, provider, model, status, owner_key_id, logs, result, error, created_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        crypto.randomUUID(),
        "stripe",
        null,
        null,
        null,
        "queued",
        ownerB.record.id,
        "[]",
        null,
        null,
        new Date().toISOString(),
        null,
        null,
      ],
    });

    const app = createTestApp(new AdapterRegistry());
    const response = await app.request("/adapters/jobs", { headers: keyHeaders(ownerA.raw) });
    const jobs = (await response.json()) as { jobs: Array<{ platform: string }>; has_more: boolean };

    expect(response.status).toBe(200);
    expect(jobs.jobs.length).toBe(1);
    expect(jobs.jobs[0]?.platform).toBe("toast");
    expect(jobs.has_more).toBe(false);
  });
});
