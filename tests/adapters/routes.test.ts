import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

interface AdapterSourceOptions {
  includeMeta?: boolean;
  manifestName?: string;
  manifestDescription?: string;
  manifestVersion?: string;
}

function adapterSourceForPath(filePath: string, options: AdapterSourceOptions = {}): string {
  const importPath = pathToFileURL(path.resolve(process.cwd(), "src", "adapter-api.ts")).href;
  const platform = path.basename(filePath, ".ts");
  const includeMeta = options.includeMeta ?? true;

  return [
    `import { type AgpAdapter, type AdapterContext, type BusinessProfile, type ExecuteOptions, defineManifest } from '${importPath}';`,
    "",
    "export const manifest = defineManifest({",
    `  platform: '${platform}',`,
    ...(options.manifestName ? [`  name: '${options.manifestName}',`] : []),
    ...(options.manifestDescription ? [`  description: '${options.manifestDescription}',`] : []),
    ...(options.manifestVersion ? [`  version: '${options.manifestVersion}',`] : []),
    "  auth: { type: 'none', strategy: 'none' },",
    "  authenticatedDomains: [],",
    "  allowedDomains: ['localhost'],",
    "});",
    "",
    ...(includeMeta ? ["export const meta = { generatedBy: 'test' };", ""] : []),
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

async function writeAdapterFile(filePath: string, options: AdapterSourceOptions = {}): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, adapterSourceForPath(filePath, options), "utf8");
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

describe("adapter routes", () => {
  test("GET /adapters returns visible sandbox+public rows for owner and all rows for admin", async () => {
    const registry = new AdapterRegistry();
    const app = createTestApp(registry);
    const owner = await createApiKey({ label: "owner", tier: "paid" });
    const otherOwner = await createApiKey({ label: "other-owner", tier: "paid" });

    const ownerSandboxPath = resolveSandboxAdapterPath(owner.record.id, "toast");
    await writeAdapterFile(ownerSandboxPath);
    await upsertSandboxAdapter({
      platform: "toast",
      ownerId: owner.record.id,
      filePath: ownerSandboxPath,
    });
    registry.registerScoped("toast", owner.record.id, createTestFactory("owner-sandbox"), ownerSandboxPath, {
      scope: "sandbox",
    });

    const otherSandboxPath = resolveSandboxAdapterPath(otherOwner.record.id, "square");
    await writeAdapterFile(otherSandboxPath);
    await upsertSandboxAdapter({
      platform: "square",
      ownerId: otherOwner.record.id,
      filePath: otherSandboxPath,
    });
    registry.registerScoped("square", otherOwner.record.id, createTestFactory("other-sandbox"), otherSandboxPath);

    const ownerPublicSandboxPath = resolveSandboxAdapterPath(owner.record.id, "stripe");
    const publicPath = resolvePublicAdapterPath("stripe");
    await writeAdapterFile(ownerPublicSandboxPath);
    await upsertSandboxAdapter({
      platform: "stripe",
      ownerId: owner.record.id,
      filePath: ownerPublicSandboxPath,
    });
    await Bun.write(publicPath, await readFile(ownerPublicSandboxPath, "utf8"));
    await markAdapterPublic({
      adapterId: (await getAdapterByPlatformOwner("stripe", owner.record.id))!.id,
      promotedBy: "admin",
      filePath: publicPath,
    });
    registry.registerPublic("stripe", createTestFactory("public"), publicPath, { scope: "public" });

    const ownerListResponse = await app.request("/adapters", {
      headers: keyHeaders(owner.raw),
    });
    expect(ownerListResponse.status).toBe(200);
    const ownerList = (await ownerListResponse.json()) as Array<Record<string, unknown>>;
    expect(ownerList.map((entry) => `${entry.platform}:${entry.status}`)).toEqual([
      "stripe:public",
      "toast:sandbox",
    ]);
    expect(ownerList.every((entry) => entry.ownerId === owner.record.id)).toBe(true);
    expect(ownerList.every((entry) => typeof entry.adapterId === "string")).toBe(true);

    const adminListResponse = await app.request("/adapters", {
      headers: adminHeaders(),
    });
    expect(adminListResponse.status).toBe(200);
    const adminList = await adminListResponse.json();
    expect(adminList.length).toBe(3);
    expect(adminList.some((entry: Record<string, unknown>) => entry.platform === "square")).toBe(true);
  });

  test("GET /adapters includes manifest metadata when adapter has no meta export", async () => {
    const registry = new AdapterRegistry();
    const app = createTestApp(registry);
    const owner = await createApiKey({ label: "owner-manifest-meta", tier: "paid" });

    const sandboxPath = resolveSandboxAdapterPath(owner.record.id, "manifest-meta");
    const publicPath = resolvePublicAdapterPath("manifest-meta");
    await writeAdapterFile(sandboxPath, {
      includeMeta: false,
      manifestName: "Manifest Metadata Adapter",
      manifestDescription: "Adapter metadata comes from manifest export",
      manifestVersion: "1.2.3",
    });
    await upsertSandboxAdapter({
      platform: "manifest-meta",
      ownerId: owner.record.id,
      filePath: sandboxPath,
    });
    await Bun.write(publicPath, await readFile(sandboxPath, "utf8"));
    await markAdapterPublic({
      adapterId: (await getAdapterByPlatformOwner("manifest-meta", owner.record.id))!.id,
      promotedBy: "admin",
      filePath: publicPath,
    });

    await registry.loadDynamicAdapters();

    const response = await app.request("/adapters", {
      headers: keyHeaders(owner.raw),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{
      platform: string;
      meta?: { name?: string; description?: string; version?: string };
    }>;
    const manifestMetaEntry = body.find((entry) => entry.platform === "manifest-meta");
    expect(manifestMetaEntry?.meta).toEqual({
      name: "Manifest Metadata Adapter",
      description: "Adapter metadata comes from manifest export",
      version: "1.2.3",
    });
  });

  test("POST /adapters/generate stores jobs under key owner id and enforces owner visibility", async () => {
    const app = createTestApp(new AdapterRegistry());
    const ownerA = await createApiKey({ label: "ownerA", tier: "paid" });
    const ownerB = await createApiKey({ label: "ownerB", tier: "paid" });

    const created = await app.request("/adapters/generate", {
      method: "POST",
      headers: { ...keyHeaders(ownerA.raw), "content-type": "application/json" },
      body: JSON.stringify({ platform: "toast" }),
    });
    expect(created.status).toBe(202);
    const createdBody = await created.json();

    const ownerAJobs = await app.request("/adapters/jobs", { headers: keyHeaders(ownerA.raw) });
    const ownerAJobsBody = (await ownerAJobs.json()) as { jobs: Array<{ id: string }> };
    expect(ownerAJobs.status).toBe(200);
    expect(ownerAJobsBody.jobs.length).toBe(1);
    expect(ownerAJobsBody.jobs[0]?.id).toBe(createdBody.jobId);

    const ownerBJobs = await app.request("/adapters/jobs", { headers: keyHeaders(ownerB.raw) });
    expect(ownerBJobs.status).toBe(200);
    expect(await ownerBJobs.json()).toEqual({ jobs: [], has_more: false });

    const ownerAJobDetail = await app.request(`/adapters/jobs/${createdBody.jobId}`, {
      headers: keyHeaders(ownerA.raw),
    });
    expect(ownerAJobDetail.status).toBe(200);
    expect((await ownerAJobDetail.json()).ownerKeyId).toBe(ownerA.record.id);

    const ownerBJobDetail = await app.request(`/adapters/jobs/${createdBody.jobId}`, {
      headers: keyHeaders(ownerB.raw),
    });
    expect(ownerBJobDetail.status).toBe(404);
  });

  test("POST /adapters/generate returns 409 when owner already has public adapter for the platform", async () => {
    const app = createTestApp(new AdapterRegistry());
    const owner = await createApiKey({ label: "owner", tier: "paid" });

    const sandboxPath = resolveSandboxAdapterPath(owner.record.id, "stripe");
    const publicPath = resolvePublicAdapterPath("stripe");
    await writeAdapterFile(sandboxPath);
    await upsertSandboxAdapter({
      platform: "stripe",
      ownerId: owner.record.id,
      filePath: sandboxPath,
    });
    await Bun.write(publicPath, await readFile(sandboxPath, "utf8"));
    await markAdapterPublic({
      adapterId: (await getAdapterByPlatformOwner("stripe", owner.record.id))!.id,
      promotedBy: "admin",
      filePath: publicPath,
    });

    const response = await app.request("/adapters/generate", {
      method: "POST",
      headers: { ...keyHeaders(owner.raw), "content-type": "application/json" },
      body: JSON.stringify({ platform: "stripe" }),
    });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("Adapter is public");
  });

  test("POST /adapters/:platform/upload stores valid source as sandbox adapter", async () => {
    const registry = new AdapterRegistry();
    const app = createTestApp(registry);
    const owner = await createApiKey({ label: "owner-upload", tier: "paid" });
    const source = adapterSourceForPath("upload-target.ts");

    const response = await app.request("/adapters/upload-target/upload", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        source,
        description: "manual upload",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.platform).toBe("upload-target");
    expect(body.status).toBe("sandbox");
    expect(typeof body.adapterId).toBe("string");

    const stored = await getAdapterByPlatformOwner("upload-target", "admin");
    expect(stored?.status).toBe("sandbox");
    expect(stored?.sourceCode).toContain("export const manifest");
    expect(registry.getScopedEntry("upload-target", "admin")).toBeDefined();
  });

  test("POST /adapters/:platform/upload returns 400 when source is missing", async () => {
    const app = createTestApp(new AdapterRegistry());
    const owner = await createApiKey({ label: "owner-upload-missing", tier: "paid" });

    const response = await app.request("/adapters/upload-missing/upload", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ description: "missing source" }),
    });

    expect(response.status).toBe(400);
  });

  test("POST /adapters/:platform/upload rejects source with banned imports", async () => {
    const app = createTestApp(new AdapterRegistry());
    const owner = await createApiKey({ label: "owner-upload-banned", tier: "paid" });
    const source = [
      "import fs from 'fs';",
      "export const manifest = { platform: 'upload-banned', auth: { type: 'none', strategy: 'none' }, authenticatedDomains: [], allowedDomains: ['localhost'] };",
      "export default class UploadBanned {}",
    ].join("\n");

    const response = await app.request("/adapters/upload-banned/upload", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ source }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Invalid adapter source");
  });

  test("POST /adapters/:platform/upload overwrites existing sandbox for same owner and platform", async () => {
    const app = createTestApp(new AdapterRegistry());
    const owner = await createApiKey({ label: "owner-upload-overwrite", tier: "paid" });

    const firstSource = adapterSourceForPath("overwrite-target.ts");
    const secondSource = `${adapterSourceForPath("overwrite-target.ts")}\nexport const changed = true;\n`;

    const firstUpload = await app.request("/adapters/overwrite-target/upload", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ source: firstSource }),
    });
    expect(firstUpload.status).toBe(200);
    const firstBody = await firstUpload.json();

    const secondUpload = await app.request("/adapters/overwrite-target/upload", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ source: secondSource }),
    });
    expect(secondUpload.status).toBe(200);
    const secondBody = await secondUpload.json();
    expect(secondBody.adapterId).toBe(firstBody.adapterId);

    const stored = await getAdapterByPlatformOwner("overwrite-target", "admin");
    expect(stored?.sourceCode).toContain("export const changed = true;");
    expect(stored?.status).toBe("sandbox");
  });

  test("POST /adapters/:platform/upload returns 409 when another owner has public adapter", async () => {
    const app = createTestApp(new AdapterRegistry());
    const ownerA = await createApiKey({ label: "owner-a-public", tier: "paid" });
    const ownerB = await createApiKey({ label: "owner-b-upload", tier: "paid" });

    const sandboxPath = resolveSandboxAdapterPath(ownerA.record.id, "upload-public");
    const publicPath = resolvePublicAdapterPath("upload-public");
    await writeAdapterFile(sandboxPath);
    await upsertSandboxAdapter({
      platform: "upload-public",
      ownerId: ownerA.record.id,
      filePath: sandboxPath,
    });
    await Bun.write(publicPath, await readFile(sandboxPath, "utf8"));
    await markAdapterPublic({
      adapterId: (await getAdapterByPlatformOwner("upload-public", ownerA.record.id))!.id,
      promotedBy: "admin",
      filePath: publicPath,
    });

    const response = await app.request("/adapters/upload-public/upload", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ source: adapterSourceForPath("upload-public.ts") }),
    });

    expect(response.status).toBe(409);
  });

  test("POST /adapters/:platform/submit moves owner sandbox adapter to review", async () => {
    const app = createTestApp(new AdapterRegistry());
    const owner = await createApiKey({ label: "owner-submit", tier: "paid" });
    const sandboxPath = resolveSandboxAdapterPath(owner.record.id, "submit-target");
    await writeAdapterFile(sandboxPath);
    await upsertSandboxAdapter({
      platform: "submit-target",
      ownerId: owner.record.id,
      filePath: sandboxPath,
    });

    const response = await app.request("/adapters/submit-target/submit", {
      method: "POST",
      headers: { ...keyHeaders(owner.raw), "content-type": "application/json" },
      body: JSON.stringify({ message: "Please review this upload." }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("review");

    const updated = await getAdapterByPlatformOwner("submit-target", owner.record.id);
    expect(updated?.status).toBe("review");
    expect(updated?.reviewMessage).toBe("Please review this upload.");
    expect(updated?.submittedAt).not.toBeNull();
  });

  test("POST /adapters/:platform/submit returns 404 when sandbox adapter does not exist", async () => {
    const app = createTestApp(new AdapterRegistry());
    const owner = await createApiKey({ label: "owner-submit-missing", tier: "paid" });

    const response = await app.request("/adapters/missing-submit/submit", {
      method: "POST",
      headers: { ...keyHeaders(owner.raw), "content-type": "application/json" },
      body: JSON.stringify({ message: "request" }),
    });

    expect(response.status).toBe(404);
  });

  test("POST /adapters/:platform/submit returns 409 when adapter already in review", async () => {
    const app = createTestApp(new AdapterRegistry());
    const owner = await createApiKey({ label: "owner-submit-review", tier: "paid" });
    const sandboxPath = resolveSandboxAdapterPath(owner.record.id, "submit-review");
    await writeAdapterFile(sandboxPath);
    const adapter = await upsertSandboxAdapter({
      platform: "submit-review",
      ownerId: owner.record.id,
      filePath: sandboxPath,
    });
    await markAdapterReview({ adapterId: adapter.id, reviewMessage: "first pass" });

    const response = await app.request("/adapters/submit-review/submit", {
      method: "POST",
      headers: { ...keyHeaders(owner.raw), "content-type": "application/json" },
      body: JSON.stringify({ message: "second pass" }),
    });

    expect(response.status).toBe(409);
  });

  test("POST /adapters/:platform/withdraw returns review adapter to sandbox", async () => {
    const app = createTestApp(new AdapterRegistry());
    const owner = await createApiKey({ label: "owner-withdraw", tier: "paid" });
    const sandboxPath = resolveSandboxAdapterPath(owner.record.id, "withdraw-target");
    await writeAdapterFile(sandboxPath);
    const adapter = await upsertSandboxAdapter({
      platform: "withdraw-target",
      ownerId: owner.record.id,
      filePath: sandboxPath,
    });
    await markAdapterReview({ adapterId: adapter.id, reviewMessage: "ready for review" });

    const response = await app.request("/adapters/withdraw-target/withdraw", {
      method: "POST",
      headers: keyHeaders(owner.raw),
    });

    expect(response.status).toBe(200);
    const updated = await getAdapterByPlatformOwner("withdraw-target", owner.record.id);
    expect(updated?.status).toBe("sandbox");
    expect(updated?.submittedAt).toBeNull();
  });

  test("POST /adapters/:platform/withdraw by non-owner returns 404", async () => {
    const app = createTestApp(new AdapterRegistry());
    const owner = await createApiKey({ label: "owner-withdraw-origin", tier: "paid" });
    const otherOwner = await createApiKey({ label: "owner-withdraw-other", tier: "paid" });
    const sandboxPath = resolveSandboxAdapterPath(owner.record.id, "withdraw-owner");
    await writeAdapterFile(sandboxPath);
    const adapter = await upsertSandboxAdapter({
      platform: "withdraw-owner",
      ownerId: owner.record.id,
      filePath: sandboxPath,
    });
    await markAdapterReview({ adapterId: adapter.id, reviewMessage: "review me" });

    const response = await app.request("/adapters/withdraw-owner/withdraw", {
      method: "POST",
      headers: keyHeaders(otherOwner.raw),
    });

    expect(response.status).toBe(404);
  });

  test("POST /adapters/:platform/reject by admin sets sandbox status and stores feedback", async () => {
    const app = createTestApp(new AdapterRegistry());
    const owner = await createApiKey({ label: "owner-reject", tier: "paid" });
    const sandboxPath = resolveSandboxAdapterPath(owner.record.id, "reject-target");
    await writeAdapterFile(sandboxPath);
    const adapter = await upsertSandboxAdapter({
      platform: "reject-target",
      ownerId: owner.record.id,
      filePath: sandboxPath,
    });
    await markAdapterReview({ adapterId: adapter.id, reviewMessage: "review reject target" });

    const response = await app.request(`/adapters/reject-target/reject?owner_id=${owner.record.id}`, {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ reason: "Please remove undeclared domains." }),
    });

    expect(response.status).toBe(200);
    const updated = await getAdapterById(adapter.id);
    expect(updated?.status).toBe("sandbox");
    expect(updated?.reviewFeedback).toBe("Please remove undeclared domains.");
    expect(updated?.reviewedAt).not.toBeNull();
  });

  test("POST /adapters/:platform/reject requires reason", async () => {
    const app = createTestApp(new AdapterRegistry());
    const owner = await createApiKey({ label: "owner-reject-no-reason", tier: "paid" });
    const sandboxPath = resolveSandboxAdapterPath(owner.record.id, "reject-no-reason");
    await writeAdapterFile(sandboxPath);
    const adapter = await upsertSandboxAdapter({
      platform: "reject-no-reason",
      ownerId: owner.record.id,
      filePath: sandboxPath,
    });
    await markAdapterReview({ adapterId: adapter.id, reviewMessage: "missing reason test" });

    const response = await app.request(`/adapters/reject-no-reason/reject?owner_id=${owner.record.id}`, {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
  });

  test("POST /adapters/:platform/promote accepts review adapters", async () => {
    const registry = new AdapterRegistry();
    const app = createTestApp(registry);
    const owner = await createApiKey({ label: "owner-promote-review", tier: "paid" });
    const sandboxPath = resolveSandboxAdapterPath(owner.record.id, "promote-review");
    await writeAdapterFile(sandboxPath);
    const adapter = await upsertSandboxAdapter({
      platform: "promote-review",
      ownerId: owner.record.id,
      filePath: sandboxPath,
    });
    await markAdapterReview({ adapterId: adapter.id, reviewMessage: "ready for promote" });
    registry.registerScoped("promote-review", owner.record.id, createTestFactory("review"), sandboxPath);

    const response = await app.request(`/adapters/promote-review/promote?owner_id=${owner.record.id}`, {
      method: "POST",
      headers: adminHeaders(),
    });

    expect(response.status).toBe(200);
    const promoted = await getAdapterByPlatformOwner("promote-review", owner.record.id);
    expect(promoted?.status).toBe("public");
    expect(promoted?.reviewedAt).not.toBeNull();
  });

  test("non-admin cannot reject adapters", async () => {
    const app = createTestApp(new AdapterRegistry());
    const owner = await createApiKey({ label: "owner-non-admin-reject", tier: "paid" });
    const response = await app.request("/adapters/some-platform/reject", {
      method: "POST",
      headers: { ...keyHeaders(owner.raw), "content-type": "application/json" },
      body: JSON.stringify({ reason: "no scope" }),
    });
    expect(response.status).toBe(403);
  });

  test("GET /adapters/reviews returns only review adapters", async () => {
    const app = createTestApp(new AdapterRegistry());
    const ownerA = await createApiKey({ label: "owner-review-a", tier: "paid" });
    const ownerB = await createApiKey({ label: "owner-review-b", tier: "paid" });

    const aPath = resolveSandboxAdapterPath(ownerA.record.id, "reviews-target-a");
    const bPath = resolveSandboxAdapterPath(ownerB.record.id, "reviews-target-b");
    await writeAdapterFile(aPath);
    await writeAdapterFile(bPath);
    const adapterA = await upsertSandboxAdapter({
      platform: "reviews-target-a",
      ownerId: ownerA.record.id,
      filePath: aPath,
    });
    const adapterB = await upsertSandboxAdapter({
      platform: "reviews-target-b",
      ownerId: ownerB.record.id,
      filePath: bPath,
    });
    await markAdapterReview({ adapterId: adapterA.id, reviewMessage: "a review" });
    await markAdapterReview({ adapterId: adapterB.id, reviewMessage: "b review" });
    await markAdapterPublic({
      adapterId: adapterB.id,
      promotedBy: "admin",
      filePath: resolvePublicAdapterPath("reviews-target-b"),
    });

    const response = await app.request("/adapters/reviews", {
      headers: adminHeaders(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { reviews: Array<{ status?: string; platform: string }> };
    expect(body.reviews.length).toBe(1);
    expect(body.reviews[0]?.platform).toBe("reviews-target-a");
  });

  test("GET /adapters visibility includes own sandbox+review and all public for users; admin sees all", async () => {
    const app = createTestApp(new AdapterRegistry());
    const owner = await createApiKey({ label: "owner-visibility", tier: "paid" });
    const other = await createApiKey({ label: "other-visibility", tier: "paid" });

    const ownerSandboxPath = resolveSandboxAdapterPath(owner.record.id, "vis-sandbox");
    const ownerReviewPath = resolveSandboxAdapterPath(owner.record.id, "vis-review");
    const ownerPublicSandboxPath = resolveSandboxAdapterPath(owner.record.id, "vis-public");
    const otherReviewPath = resolveSandboxAdapterPath(other.record.id, "vis-other-review");
    await writeAdapterFile(ownerSandboxPath);
    await writeAdapterFile(ownerReviewPath);
    await writeAdapterFile(ownerPublicSandboxPath);
    await writeAdapterFile(otherReviewPath);

    await upsertSandboxAdapter({
      platform: "vis-sandbox",
      ownerId: owner.record.id,
      filePath: ownerSandboxPath,
    });
    const ownerReview = await upsertSandboxAdapter({
      platform: "vis-review",
      ownerId: owner.record.id,
      filePath: ownerReviewPath,
    });
    const ownerPublic = await upsertSandboxAdapter({
      platform: "vis-public",
      ownerId: owner.record.id,
      filePath: ownerPublicSandboxPath,
    });
    const otherReview = await upsertSandboxAdapter({
      platform: "vis-other-review",
      ownerId: other.record.id,
      filePath: otherReviewPath,
    });

    await markAdapterReview({ adapterId: ownerReview.id, reviewMessage: "owner review" });
    await markAdapterReview({ adapterId: otherReview.id, reviewMessage: "other review" });
    await markAdapterPublic({
      adapterId: ownerPublic.id,
      promotedBy: "admin",
      filePath: resolvePublicAdapterPath("vis-public"),
    });

    const ownerResponse = await app.request("/adapters", { headers: keyHeaders(owner.raw) });
    expect(ownerResponse.status).toBe(200);
    const ownerList = (await ownerResponse.json()) as Array<{ platform: string; status: string }>;
    expect(ownerList.map((row) => `${row.platform}:${row.status}`).sort()).toEqual(
      ["vis-public:public", "vis-review:review", "vis-sandbox:sandbox"].sort(),
    );

    const adminResponse = await app.request("/adapters", { headers: adminHeaders() });
    expect(adminResponse.status).toBe(200);
    const adminList = (await adminResponse.json()) as Array<{ platform: string; status: string }>;
    expect(adminList.some((row) => row.platform === "vis-other-review" && row.status === "review")).toBe(true);
    expect(adminList.some((row) => row.platform === "vis-sandbox" && row.status === "sandbox")).toBe(true);
  });

  test("DELETE /adapters/:platform lets owner remove own sandbox adapter", async () => {
    const registry = new AdapterRegistry();
    const app = createTestApp(registry);
    const owner = await createApiKey({ label: "owner", tier: "paid" });

    const sandboxPath = resolveSandboxAdapterPath(owner.record.id, "toast");
    await writeAdapterFile(sandboxPath);
    await upsertSandboxAdapter({
      platform: "toast",
      ownerId: owner.record.id,
      filePath: sandboxPath,
    });
    registry.registerScoped("toast", owner.record.id, createTestFactory("owner"), sandboxPath);

    const response = await app.request("/adapters/toast", {
      method: "DELETE",
      headers: keyHeaders(owner.raw),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ platform: "toast", status: "removed", scope: "sandbox" });
    expect(await getAdapterByPlatformOwner("toast", owner.record.id)).toBeNull();
    expect(registry.getScopedEntry("toast", owner.record.id)).toBeUndefined();
  });

  test("DELETE /adapters/:platform lets admin remove public adapter", async () => {
    const registry = new AdapterRegistry();
    const app = createTestApp(registry);
    const owner = await createApiKey({ label: "owner", tier: "paid" });

    const sandboxPath = resolveSandboxAdapterPath(owner.record.id, "stripe");
    const publicPath = resolvePublicAdapterPath("stripe");
    await writeAdapterFile(sandboxPath);
    await upsertSandboxAdapter({
      platform: "stripe",
      ownerId: owner.record.id,
      filePath: sandboxPath,
    });
    await Bun.write(publicPath, await readFile(sandboxPath, "utf8"));
    await markAdapterPublic({
      adapterId: (await getAdapterByPlatformOwner("stripe", owner.record.id))!.id,
      promotedBy: "admin",
      filePath: publicPath,
    });
    registry.registerPublic("stripe", createTestFactory("public"), publicPath);

    const response = await app.request("/adapters/stripe", {
      method: "DELETE",
      headers: adminHeaders(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ platform: "stripe", status: "archived", scope: "public" });
    const archived = await getAdapterByPlatformOwner("stripe", owner.record.id);
    expect(archived?.status).toBe("archived");
    expect(registry.getPublicEntry("stripe")).toBeUndefined();
  });

  test("GET /adapters/archived lists archived adapters and hard delete removes them", async () => {
    const registry = new AdapterRegistry();
    const app = createTestApp(registry);
    const owner = await createApiKey({ label: "owner-archive", tier: "paid" });

    const sandboxPath = resolveSandboxAdapterPath(owner.record.id, "archive-target");
    await writeAdapterFile(sandboxPath);
    await upsertSandboxAdapter({
      platform: "archive-target",
      ownerId: owner.record.id,
      filePath: sandboxPath,
    });
    registry.registerScoped("archive-target", owner.record.id, createTestFactory("owner"), sandboxPath);

    const archiveResponse = await app.request("/adapters/archive-target", {
      method: "DELETE",
      headers: adminHeaders(),
    });
    expect(archiveResponse.status).toBe(200);
    expect((await archiveResponse.json()).status).toBe("archived");

    const archivedResponse = await app.request("/adapters/archived", {
      headers: adminHeaders(),
    });
    expect(archivedResponse.status).toBe(200);
    const archivedBody = (await archivedResponse.json()) as Array<{ platform: string; status: string }>;
    expect(archivedBody.some((entry) => entry.platform === "archive-target" && entry.status === "archived")).toBe(true);

    const hardDeleteResponse = await app.request(`/adapters/archive-target/hard?owner_id=${owner.record.id}`, {
      method: "DELETE",
      headers: adminHeaders(),
    });
    expect(hardDeleteResponse.status).toBe(200);
    expect(await getAdapterByPlatformOwner("archive-target", owner.record.id)).toBeNull();
  });

  test("POST /adapters/:platform/promote promotes selected sandbox and archives existing public", async () => {
    const registry = new AdapterRegistry();
    const app = createTestApp(registry);
    const ownerA = await createApiKey({ label: "owner-a", tier: "paid" });
    const ownerB = await createApiKey({ label: "owner-b", tier: "paid" });

    const oldPublicSandboxPath = resolveSandboxAdapterPath(ownerA.record.id, "toast");
    const oldPublicPath = resolvePublicAdapterPath("toast");
    await writeAdapterFile(oldPublicSandboxPath);
    await upsertSandboxAdapter({
      platform: "toast",
      ownerId: ownerA.record.id,
      filePath: oldPublicSandboxPath,
    });
    await Bun.write(oldPublicPath, await readFile(oldPublicSandboxPath, "utf8"));
    await markAdapterPublic({
      adapterId: (await getAdapterByPlatformOwner("toast", ownerA.record.id))!.id,
      promotedBy: "admin",
      filePath: oldPublicPath,
    });
    registry.registerPublic("toast", createTestFactory("old-public"), oldPublicPath);

    const candidateSandboxPath = resolveSandboxAdapterPath(ownerB.record.id, "toast");
    await writeAdapterFile(candidateSandboxPath);
    await upsertSandboxAdapter({
      platform: "toast",
      ownerId: ownerB.record.id,
      filePath: candidateSandboxPath,
    });
    const candidateBeforePromote = await getAdapterByPlatformOwner("toast", ownerB.record.id);
    registry.registerScoped("toast", ownerB.record.id, createTestFactory("candidate"), candidateSandboxPath);

    const response = await app.request(`/adapters/toast/promote?owner_id=${ownerB.record.id}`, {
      method: "POST",
      headers: adminHeaders(),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      platform: "toast",
      ownerId: ownerB.record.id,
      status: "public",
      source: resolvePublicAdapterPath("toast"),
    });

    const newPublic = await getPublicAdapterByPlatform("toast");
    expect(newPublic?.ownerId).toBe(ownerB.record.id);
    expect(newPublic?.sourceCode).toBe(candidateBeforePromote?.sourceCode);
    expect(newPublic?.sourceHash).toBe(candidateBeforePromote?.sourceHash);

    const oldOwnerRow = await getAdapterByPlatformOwner("toast", ownerA.record.id);
    expect(oldOwnerRow?.status).toBe("rejected");
    expect(oldOwnerRow?.filePath.startsWith(path.join(testAdaptersDir, "_rejected"))).toBe(true);
    expect(await Bun.file(oldOwnerRow!.filePath).exists()).toBe(true);
  });

  test("POST /adapters/:platform/promote returns 409 when multiple sandbox candidates and no owner_id", async () => {
    const app = createTestApp(new AdapterRegistry());
    const ownerA = await createApiKey({ label: "owner-a", tier: "paid" });
    const ownerB = await createApiKey({ label: "owner-b", tier: "paid" });

    const pathA = resolveSandboxAdapterPath(ownerA.record.id, "square");
    const pathB = resolveSandboxAdapterPath(ownerB.record.id, "square");
    await writeAdapterFile(pathA);
    await writeAdapterFile(pathB);
    await upsertSandboxAdapter({ platform: "square", ownerId: ownerA.record.id, filePath: pathA });
    await upsertSandboxAdapter({ platform: "square", ownerId: ownerB.record.id, filePath: pathB });

    const response = await app.request("/adapters/square/promote", {
      method: "POST",
      headers: adminHeaders(),
    });

    expect(response.status).toBe(409);
  });

  test("POST /adapters/:platform/demote moves public adapter back to owner sandbox", async () => {
    const registry = new AdapterRegistry();
    const app = createTestApp(registry);
    const owner = await createApiKey({ label: "owner", tier: "paid" });

    const sandboxPath = resolveSandboxAdapterPath(owner.record.id, "stripe");
    const publicPath = resolvePublicAdapterPath("stripe");
    await writeAdapterFile(sandboxPath);
    await upsertSandboxAdapter({
      platform: "stripe",
      ownerId: owner.record.id,
      filePath: sandboxPath,
    });
    await Bun.write(publicPath, await readFile(sandboxPath, "utf8"));
    await markAdapterPublic({
      adapterId: (await getAdapterByPlatformOwner("stripe", owner.record.id))!.id,
      promotedBy: "admin",
      filePath: publicPath,
    });
    const publicBeforeDemote = await getPublicAdapterByPlatform("stripe");
    registry.registerPublic("stripe", createTestFactory("public"), publicPath);

    const response = await app.request("/adapters/stripe/demote", {
      method: "POST",
      headers: adminHeaders(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      platform: "stripe",
      ownerId: owner.record.id,
      status: "sandbox",
      source: resolveSandboxAdapterPath(owner.record.id, "stripe"),
    });

    const row = await getAdapterByPlatformOwner("stripe", owner.record.id);
    expect(row?.status).toBe("sandbox");
    expect(row?.promotedAt).toBeNull();
    expect(row?.promotedBy).toBeNull();
    expect(row?.sourceCode).toBe(publicBeforeDemote?.sourceCode);
    expect(row?.sourceHash).toBe(publicBeforeDemote?.sourceHash);
  });

  test("adapter registry scoped resolution prefers sandbox over public for the same owner", () => {
    const registry = new AdapterRegistry();
    registry.registerPublic("stripe", createTestFactory("public"), "/tmp/public.ts");
    registry.registerScoped("stripe", "owner-1", createTestFactory("sandbox"), "/tmp/sandbox.ts");

    const ownerFactory = registry.resolve("stripe", "owner-1");
    const otherFactory = registry.resolve("stripe", "owner-2");

    expect(ownerFactory).toBeDefined();
    expect(otherFactory).toBeDefined();
    expect(ownerFactory).not.toBe(otherFactory);
    expect(registry.get("stripe")).toBe(otherFactory);
    expect(registry.unregisterScoped("stripe", "owner-1")).toBe(true);
    expect(registry.resolve("stripe", "owner-1")).toBe(otherFactory);
  });

  test("promote/demote routes require admin scope", async () => {
    const app = createTestApp(new AdapterRegistry());
    const owner = await createApiKey({ label: "owner", tier: "paid" });

    const promote = await app.request("/adapters/stripe/promote", {
      method: "POST",
      headers: keyHeaders(owner.raw),
    });
    expect(promote.status).toBe(403);

    const demote = await app.request("/adapters/stripe/demote", {
      method: "POST",
      headers: keyHeaders(owner.raw),
    });
    expect(demote.status).toBe(403);
  });

  test("GET /adapters and /adapters/jobs require auth", async () => {
    const app = createTestApp(new AdapterRegistry());
    const adaptersResponse = await app.request("/adapters");
    expect(adaptersResponse.status).toBe(401);

    const jobsResponse = await app.request("/adapters/jobs");
    expect(jobsResponse.status).toBe(401);
  });

  test("GET /adapters/jobs admin sees all jobs", async () => {
    const app = createTestApp(new AdapterRegistry());
    const ownerA = await createApiKey({ label: "ownerA", tier: "paid" });
    const ownerB = await createApiKey({ label: "ownerB", tier: "paid" });

    await app.request("/adapters/generate", {
      method: "POST",
      headers: { ...keyHeaders(ownerA.raw), "content-type": "application/json" },
      body: JSON.stringify({ platform: "toast" }),
    });

    await app.request("/adapters/generate", {
      method: "POST",
      headers: { ...keyHeaders(ownerB.raw), "content-type": "application/json" },
      body: JSON.stringify({ platform: "stripe" }),
    });

    const response = await app.request("/adapters/jobs", { headers: adminHeaders() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { jobs: Array<{ id: string }>; has_more: boolean };
    expect(body.jobs.length).toBe(2);
    expect(body.has_more).toBe(false);
  });
});
