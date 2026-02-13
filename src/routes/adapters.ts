import { copyFile, mkdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import type { AdapterEntry, AdapterRegistry } from "../core/adapter-registry";
import {
  countActiveByPlatform,
  deleteAdapterById,
  getActiveAdapterByPlatform,
  getActiveAdapterByPlatformOwner,
  getAdapterByPlatformOwner,
  listAllAdapters,
  listArchivedAdapters,
  listPromotableAdaptersByPlatform,
  listReviewAdapters,
  listReviewAdaptersByPlatform,
  getPublicAdapterByPlatform,
  listVisibleAdapters,
  markAdapterArchived,
  markAdapterPublic,
  markAdapterRejected,
  markAdapterRejectedWithFeedback,
  markAdapterReview,
  markAdapterSandbox,
  upsertSandboxAdapter,
} from "../db/adapters";
import { getDb } from "../db/client";
import { createJob, getJob, listJobs } from "../jobs/generation-queue";
import { apiKeyAuthMiddleware, requireScope } from "../middleware/auth";
import {
  resolvePublicAdapterPath,
  resolveRejectedAdapterPath,
  resolveRuntimeInteractionProfilePath,
  resolveSandboxAdapterPath,
} from "../utils/adapter-paths";
import { internalServerError } from "../utils/http-error";

const generateSchema = z.object({
  platform: z.string().trim().min(1),
  docsUrl: z.string().url().optional(),
  provider: z.enum(["codex", "claude-code", "openai-api", "anthropic-api"]).optional(),
  model: z.string().trim().min(1).optional(),
});

const jobStatusSchema = z.enum(["queued", "running", "complete", "failed"]);
const jobListQuerySchema = z.object({
  status: jobStatusSchema.optional(),
  limit: z.string().trim().optional(),
  before: z.string().trim().optional(),
  before_id: z.string().trim().optional(),
});

const promoteQuerySchema = z.object({
  owner_id: z.string().trim().min(1).optional(),
});

const uploadSchema = z.object({
  source: z
    .string({ error: "source is required" })
    .min(1, "source is required")
    .refine((value) => Buffer.byteLength(value, "utf8") <= 100 * 1024, {
      message: "source must be 100KB or less",
    }),
  description: z.string().trim().max(512).optional(),
});

const submitSchema = z.object({
  message: z.string().trim().max(1000).optional(),
});

const rejectSchema = z.object({
  reason: z.string().trim().min(1),
});

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GENERATION_DAILY_LIMIT = 5;
const DEFAULT_JOB_LIST_LIMIT = 25;
const MAX_JOB_LIST_LIMIT = 50;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const PLATFORM_IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BANNED_IMPORT_PATTERN =
  /import[\s\S]*?from\s*["'](?:node:)?(?:fs|child_process|net|dgram|cluster|worker_threads)["']/i;
const MANIFEST_EXPORT_PATTERN = /export\s+const\s+manifest\b|export\s*{\s*manifest(?:\s+as\s+\w+)?\s*}/;
const DEFAULT_EXPORT_PATTERN = /export\s+default\b/;
const tsTranspiler = new Bun.Transpiler({ loader: "ts" });

function normalizePlatform(platform: string): string {
  return platform.trim().toLowerCase();
}

function isValidPlatformIdentifier(platform: string): boolean {
  return PLATFORM_IDENTIFIER_PATTERN.test(platform.trim());
}

function validateUploadedSource(source: string): string | null {
  if (!MANIFEST_EXPORT_PATTERN.test(source)) {
    return "Adapter source must export manifest (export const manifest or export { manifest }).";
  }

  if (!DEFAULT_EXPORT_PATTERN.test(source)) {
    return "Adapter source must include a default export.";
  }

  if (BANNED_IMPORT_PATTERN.test(source)) {
    return "Adapter source contains banned runtime imports.";
  }

  try {
    tsTranspiler.transformSync(source);
  } catch {
    return "Adapter source failed TypeScript syntax validation.";
  }

  return null;
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseBeforeCursor(before: string | undefined): string | null {
  if (!before?.trim()) {
    return null;
  }

  const normalized = before.trim();
  if (!ISO_TIMESTAMP_PATTERN.test(normalized)) {
    return null;
  }

  const parsedTime = Date.parse(normalized);
  if (Number.isNaN(parsedTime)) {
    return null;
  }

  return normalized;
}

function resolveLoadedEntry(
  registry: AdapterRegistry,
  row: { platform: string; status: string; ownerId: string },
): AdapterEntry | undefined {
  if (row.status === "public") {
    return registry.getPublicEntry(row.platform);
  }

  return registry.getScopedEntry(row.platform, row.ownerId);
}

function mergeEntryMeta(
  loadedEntry: AdapterEntry | undefined,
): { name: unknown; description: unknown; version: unknown } | undefined {
  const entryMeta = loadedEntry?.meta;
  const entryManifest = loadedEntry?.manifest;
  if (!entryMeta && !entryManifest) {
    return undefined;
  }

  return {
    name: entryMeta?.name ?? entryManifest?.name,
    description: entryMeta?.description ?? entryManifest?.description,
    version: entryMeta?.version ?? entryManifest?.version,
  };
}

function retryAfterIsoFromOldest(oldestCreatedAt: string | null): string {
  if (oldestCreatedAt) {
    const oldestMs = Date.parse(oldestCreatedAt);
    if (!Number.isNaN(oldestMs)) {
      return new Date(oldestMs + DAY_MS).toISOString();
    }
  }

  return new Date(Date.now() + DAY_MS).toISOString();
}

function isAdmin(c: {
  get(name: "apiKeyTier"): "free" | "paid" | "admin";
  get(name: "apiKeyScopes"): string[];
}): boolean {
  const tier = c.get("apiKeyTier");
  const scopes = c.get("apiKeyScopes");
  return tier === "admin" || scopes.includes("*");
}

function resolveOwnerIdentity(c: {
  get(name: "apiKeyId"): string | undefined;
}): string {
  return c.get("apiKeyId") ?? "admin";
}

function logInternalRouteError(c: Context, error: unknown): Response {
  const requestId = c.get("requestId") ?? "unknown";
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${requestId}] Adapter route error:`, message, error);
  return internalServerError(c);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

async function moveFile(sourcePath: string, destinationPath: string): Promise<void> {
  if (sourcePath === destinationPath) {
    return;
  }

  await mkdir(path.dirname(destinationPath), { recursive: true });

  try {
    await rename(sourcePath, destinationPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "EXDEV") {
      throw error;
    }

    await copyFile(sourcePath, destinationPath);
    await unlink(sourcePath);
  }
}

async function removeInteractionProfileIfUnused(platform: string): Promise<void> {
  const remainingCount = await countActiveByPlatform(platform);
  if (remainingCount > 0) {
    return;
  }

  await rm(resolveRuntimeInteractionProfilePath(platform), { force: true });
}

export function createAdapterRoutes(registry: AdapterRegistry): Hono {
  const adapterApp = new Hono();

  adapterApp.get("/adapters", apiKeyAuthMiddleware, async (c) => {
    const ownerId = c.get("apiKeyId");
    const admin = isAdmin(c);

    const rows = admin
      ? await listAllAdapters()
      : await listVisibleAdapters(ownerId ?? "admin");

    const entries = rows.map((row) => {
      const loadedEntry = resolveLoadedEntry(registry, row);
      const mergedMeta = mergeEntryMeta(loadedEntry);

      return {
        platform: row.platform,
        status: row.status,
        owner: Boolean(ownerId && row.ownerId === ownerId),
        ownerId: row.ownerId,
        adapterId: row.id,
        source: row.filePath,
        meta: mergedMeta,
        reviewMessage: row.reviewMessage,
        submittedAt: row.submittedAt,
        reviewedAt: row.reviewedAt,
        reviewFeedback: row.reviewFeedback,
        sourceCode: admin || (ownerId ? row.ownerId === ownerId : false) ? row.sourceCode : undefined,
      };
    });

    return c.json(entries);
  });

  adapterApp.get("/adapters/archived", apiKeyAuthMiddleware, requireScope("admin"), async (c) => {
    const ownerId = c.get("apiKeyId");
    const rows = await listArchivedAdapters();
    const entries = rows.map((row) => {
      const loadedEntry = resolveLoadedEntry(registry, row);
      const mergedMeta = mergeEntryMeta(loadedEntry);

      return {
        platform: row.platform,
        status: row.status,
        owner: Boolean(ownerId && row.ownerId === ownerId),
        ownerId: row.ownerId,
        adapterId: row.id,
        source: row.filePath,
        meta: mergedMeta,
        archivedAt: row.archivedAt,
        reviewMessage: row.reviewMessage,
        submittedAt: row.submittedAt,
        reviewedAt: row.reviewedAt,
        reviewFeedback: row.reviewFeedback,
        sourceCode: row.sourceCode,
      };
    });

    return c.json(entries);
  });

  adapterApp.post("/adapters/generate", apiKeyAuthMiddleware, requireScope("generate"), async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "Invalid request", message: "Request body must be valid JSON." }, 400);
    }

    const parsed = generateSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid request",
          details: z.treeifyError(parsed.error),
        },
        400,
      );
    }

    const platform = normalizePlatform(parsed.data.platform);
    const ownerIdentity = resolveOwnerIdentity(c);
    const existingForOwner = await getAdapterByPlatformOwner(platform, ownerIdentity);
    if (existingForOwner?.status === "public") {
      return c.json(
        {
          error: "Adapter is public",
          message: `Adapter '${platform}' is currently public for owner '${ownerIdentity}'. Demote before generating a new sandbox adapter.`,
        },
        409,
      );
    }

    const cutoffIso = new Date(Date.now() - DAY_MS).toISOString();
    const dailyLimit = parsePositiveInteger(
      process.env.AGENR_GENERATION_DAILY_LIMIT,
      DEFAULT_GENERATION_DAILY_LIMIT,
    );

    const usageResult = await getDb().execute({
      sql: `SELECT created_at
        FROM generation_jobs
        WHERE owner_key_id = ?
        AND created_at >= ?
        ORDER BY created_at ASC`,
      args: [ownerIdentity, cutoffIso],
    });

    if (usageResult.rows.length >= dailyLimit) {
      const oldestRow = usageResult.rows[0] as Record<string, unknown> | undefined;
      const oldestCreatedAt = typeof oldestRow?.["created_at"] === "string" ? oldestRow["created_at"] : null;

      return c.json(
        {
          error: "Generation limit exceeded",
          message: `Maximum ${dailyLimit} adapter generations per 24 hours.`,
          retryAfter: retryAfterIsoFromOldest(oldestCreatedAt),
        },
        429,
      );
    }

    const job = await createJob({
      platform,
      docsUrl: parsed.data.docsUrl,
      provider: parsed.data.provider,
      model: parsed.data.model,
      ownerKeyId: ownerIdentity,
    });

    return c.json(
      {
        jobId: job.id,
        platform: job.platform,
        status: job.status,
        poll: `/adapters/jobs/${job.id}`,
      },
      202,
    );
  });

  adapterApp.get("/adapters/jobs/:id", apiKeyAuthMiddleware, async (c) => {
    const job = await getJob(c.req.param("id"));
    if (!job) {
      return c.json({ error: "Job not found" }, 404);
    }

    if (!isAdmin(c) && job.ownerKeyId !== c.get("apiKeyId")) {
      return c.json({ error: "Job not found" }, 404);
    }

    return c.json(job);
  });

  adapterApp.get("/adapters/jobs", apiKeyAuthMiddleware, async (c) => {
    const parsed = jobListQuerySchema.safeParse({
      status: c.req.query("status"),
      limit: c.req.query("limit"),
      before: c.req.query("before"),
      before_id: c.req.query("before_id"),
    });

    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid request",
          details: z.treeifyError(parsed.error),
        },
        400,
      );
    }

    const limit = Math.min(parsePositiveInteger(parsed.data.limit, DEFAULT_JOB_LIST_LIMIT), MAX_JOB_LIST_LIMIT);
    const before = parseBeforeCursor(parsed.data.before);
    if (parsed.data.before !== undefined && before === null) {
      return c.json(
        {
          error: "Invalid request",
          message: "before must be an ISO timestamp.",
        },
        400,
      );
    }

    const jobs = await listJobs({
      status: parsed.data.status,
      ownerKeyId: isAdmin(c) ? undefined : c.get("apiKeyId"),
      beforeCreatedAt: before ?? undefined,
      beforeId: parsed.data.before_id ?? undefined,
      limit: limit + 1,
    });

    const hasMore = jobs.length > limit;
    const pagedJobs = hasMore ? jobs.slice(0, limit) : jobs;

    return c.json(
      {
        jobs: pagedJobs.map((job) => ({
          id: job.id,
          platform: job.platform,
          status: job.status,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
          error: job.error,
        })),
        has_more: hasMore,
      },
    );
  });

  adapterApp.get("/adapters/reviews", apiKeyAuthMiddleware, requireScope("admin"), async (c) => {
    const reviews = await listReviewAdapters();

    return c.json({
      reviews: reviews.map((row) => {
        const loadedEntry = registry.getScopedEntry(row.platform, row.ownerId);
        return {
          adapterId: row.id,
          platform: row.platform,
          ownerId: row.ownerId,
          reviewMessage: row.reviewMessage,
          submittedAt: row.submittedAt,
          reviewFeedback: row.reviewFeedback,
          sourceCode: row.sourceCode,
          meta: loadedEntry?.meta,
        };
      }),
    });
  });

  adapterApp.post("/adapters/:platform/upload", apiKeyAuthMiddleware, requireScope("admin"), async (c) => {
    const rawPlatform = c.req.param("platform");
    if (!isValidPlatformIdentifier(rawPlatform)) {
      return c.json(
        {
          error: "Invalid request",
          message: "Platform must be lowercase alphanumeric plus hyphens.",
        },
        400,
      );
    }

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "Invalid request", message: "Request body must be valid JSON." }, 400);
    }

    const parsed = uploadSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid request",
          details: z.treeifyError(parsed.error),
        },
        400,
      );
    }

    const platform = normalizePlatform(rawPlatform);
    const ownerIdentity = resolveOwnerIdentity(c);
    const source = parsed.data.source;

    const sourceValidationError = validateUploadedSource(source);
    if (sourceValidationError) {
      return c.json(
        {
          error: "Invalid adapter source",
          message: sourceValidationError,
        },
        400,
      );
    }

    const publicAdapter = await getPublicAdapterByPlatform(platform);
    if (publicAdapter && publicAdapter.ownerId !== ownerIdentity) {
      return c.json(
        {
          error: "Platform already has a public adapter",
          message: `Platform '${platform}' already has a public adapter owned by another user.`,
        },
        409,
      );
    }

    const existingOwned = await getAdapterByPlatformOwner(platform, ownerIdentity);
    if (existingOwned?.status === "public") {
      return c.json(
        {
          error: "Adapter is public",
          message: `Adapter '${platform}' is currently public for owner '${ownerIdentity}'. Demote before uploading a new sandbox adapter.`,
        },
        409,
      );
    }

    const sandboxPath = resolveSandboxAdapterPath(ownerIdentity, platform);
    try {
      await mkdir(path.dirname(sandboxPath), { recursive: true });
      await writeFile(sandboxPath, source, "utf8");
      await registry.hotLoadScoped(platform, ownerIdentity, sandboxPath);
    } catch (error) {
      return c.json(
        {
          error: "Invalid adapter source",
          message: "Uploaded source could not be loaded as an adapter.",
        },
        400,
      );
    }

    try {
      const adapter = await upsertSandboxAdapter({
        platform,
        ownerId: ownerIdentity,
        filePath: sandboxPath,
        sourceCode: source,
      });

      return c.json({
        platform,
        status: "sandbox",
        adapterId: adapter.id,
      });
    } catch (error) {
      registry.unregisterScoped(platform, ownerIdentity);
      if (error instanceof Error && error.message.includes("promoted to public")) {
        return c.json(
          {
            error: "Adapter is public",
            message: error.message,
          },
          409,
        );
      }

      return logInternalRouteError(c, error);
    }
  });

  adapterApp.post("/adapters/:platform/submit", apiKeyAuthMiddleware, async (c) => {
    const rawPlatform = c.req.param("platform");
    if (!isValidPlatformIdentifier(rawPlatform)) {
      return c.json(
        {
          error: "Invalid request",
          message: "Platform must be lowercase alphanumeric plus hyphens.",
        },
        400,
      );
    }

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      payload = {};
    }

    const parsed = submitSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid request",
          details: z.treeifyError(parsed.error),
        },
        400,
      );
    }

    const platform = normalizePlatform(rawPlatform);
    const ownerId = resolveOwnerIdentity(c);
    const adapter = await getAdapterByPlatformOwner(platform, ownerId);
    if (!adapter) {
      return c.json({ error: "Sandbox adapter not found" }, 404);
    }

    if (adapter.status === "review") {
      return c.json({ error: "Adapter already in review" }, 409);
    }

    if (adapter.status === "public") {
      return c.json(
        {
          error: "Adapter is public",
          message: "Public adapters cannot be submitted. Demote first.",
        },
        409,
      );
    }

    if (adapter.status === "rejected") {
      return c.json(
        {
          error: "Invalid adapter status",
          message: "Rejected adapters cannot be submitted.",
        },
        409,
      );
    }

    await markAdapterReview({
      adapterId: adapter.id,
      reviewMessage: parsed.data.message,
    });

    return c.json({
      platform,
      status: "review",
      adapterId: adapter.id,
    });
  });

  adapterApp.post("/adapters/:platform/reject", apiKeyAuthMiddleware, requireScope("admin"), async (c) => {
    const rawPlatform = c.req.param("platform");
    if (!isValidPlatformIdentifier(rawPlatform)) {
      return c.json(
        {
          error: "Invalid request",
          message: "Platform must be lowercase alphanumeric plus hyphens.",
        },
        400,
      );
    }

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "Invalid request", message: "Request body must be valid JSON." }, 400);
    }

    const parsedBody = rejectSchema.safeParse(payload);
    if (!parsedBody.success) {
      return c.json(
        {
          error: "Invalid request",
          details: z.treeifyError(parsedBody.error),
        },
        400,
      );
    }

    const parsedQuery = promoteQuerySchema.safeParse({
      owner_id: c.req.query("owner_id"),
    });

    if (!parsedQuery.success) {
      return c.json(
        {
          error: "Invalid request",
          details: z.treeifyError(parsedQuery.error),
        },
        400,
      );
    }

    const platform = normalizePlatform(rawPlatform);
    const reviewCandidates = await listReviewAdaptersByPlatform(platform);
    if (reviewCandidates.length === 0) {
      return c.json({ error: "Review adapter not found" }, 404);
    }

    const ownerIdFilter = parsedQuery.data.owner_id;
    const candidate = ownerIdFilter
      ? reviewCandidates.find((item) => item.ownerId === ownerIdFilter)
      : reviewCandidates.length === 1
        ? reviewCandidates[0]
        : null;

    if (!candidate) {
      if (ownerIdFilter) {
        return c.json(
          { error: "Review adapter not found", message: `No review adapter for owner '${ownerIdFilter}'.` },
          404,
        );
      }

      return c.json(
        {
          error: "Ambiguous review candidate",
          message: "Multiple review adapters exist for this platform. Specify ?owner_id=<owner>.",
          owners: reviewCandidates.map((item) => item.ownerId),
        },
        409,
      );
    }

    await markAdapterRejectedWithFeedback({
      adapterId: candidate.id,
      feedback: parsedBody.data.reason,
    });

    return c.json({
      platform,
      status: "sandbox",
      reason: parsedBody.data.reason.trim(),
    });
  });

  adapterApp.post("/adapters/:platform/withdraw", apiKeyAuthMiddleware, async (c) => {
    const rawPlatform = c.req.param("platform");
    if (!isValidPlatformIdentifier(rawPlatform)) {
      return c.json(
        {
          error: "Invalid request",
          message: "Platform must be lowercase alphanumeric plus hyphens.",
        },
        400,
      );
    }

    const platform = normalizePlatform(rawPlatform);
    const ownerId = resolveOwnerIdentity(c);
    const adapter = await getAdapterByPlatformOwner(platform, ownerId);
    if (!adapter || adapter.status !== "review") {
      return c.json({ error: "Review adapter not found" }, 404);
    }

    await markAdapterSandbox({
      adapterId: adapter.id,
      filePath: adapter.filePath,
    });

    return c.json({
      platform,
      status: "sandbox",
    });
  });

  adapterApp.delete("/adapters/:platform/hard", apiKeyAuthMiddleware, requireScope("admin"), async (c) => {
    const platform = normalizePlatform(c.req.param("platform"));
    const parsedOwner = promoteQuerySchema.safeParse({
      owner_id: c.req.query("owner_id"),
    });

    if (!parsedOwner.success) {
      return c.json(
        {
          error: "Invalid request",
          details: z.treeifyError(parsedOwner.error),
        },
        400,
      );
    }

    const ownerIdFilter = parsedOwner.data.owner_id;
    let adapter = ownerIdFilter
      ? await getAdapterByPlatformOwner(platform, ownerIdFilter)
      : null;

    if (!adapter) {
      const candidates = (await listAllAdapters({ includeArchived: true })).filter(
        (row) => row.platform === platform,
      );
      if (candidates.length === 0) {
        return c.json({ error: "Adapter not found" }, 404);
      }

      if (candidates.length > 1) {
        return c.json(
          {
            error: "Ambiguous adapter candidate",
            message: "Multiple adapters exist for this platform. Specify ?owner_id=<owner>.",
            owners: candidates.map((candidate) => candidate.ownerId),
          },
          409,
        );
      }

      adapter = candidates[0] ?? null;
    }

    if (!adapter) {
      return c.json({ error: "Adapter not found" }, 404);
    }

    try {
      await rm(adapter.filePath, { force: true });
      await deleteAdapterById(adapter.id);

      if (adapter.status === "public") {
        registry.unregisterPublic(platform);
      } else {
        registry.unregisterScoped(platform, adapter.ownerId);
      }

      await removeInteractionProfileIfUnused(platform);
    } catch (error) {
      return logInternalRouteError(c, error);
    }

    return c.json({ platform, status: "removed", scope: adapter.status });
  });

  adapterApp.delete("/adapters/:platform", apiKeyAuthMiddleware, async (c) => {
    const platform = normalizePlatform(c.req.param("platform"));
    const admin = isAdmin(c);
    const ownerId = c.get("apiKeyId");
    const parsedOwner = promoteQuerySchema.safeParse({
      owner_id: c.req.query("owner_id"),
    });

    if (!parsedOwner.success) {
      return c.json(
        {
          error: "Invalid request",
          details: z.treeifyError(parsedOwner.error),
        },
        400,
      );
    }

    const ownerIdFilter = parsedOwner.data.owner_id;
    const adapter = admin
      ? ownerIdFilter
        ? await getAdapterByPlatformOwner(platform, ownerIdFilter)
        : await getActiveAdapterByPlatform(platform)
      : ownerId
        ? await getActiveAdapterByPlatformOwner(platform, ownerId)
        : null;
    if (!adapter) {
      return c.json({ error: "Adapter not found" }, 404);
    }

    if (admin && adapter.status === "archived") {
      return c.json({ error: "Adapter already archived" }, 409);
    }

    if (adapter.status === "public" && !admin) {
      return c.json(
        {
          error: "Forbidden",
          message: "Forbidden: admin scope required to delete public adapters",
        },
        403,
      );
    }

    try {
      await rm(adapter.filePath, { force: true });
      if (admin) {
        await markAdapterArchived({ adapterId: adapter.id });
      } else {
        await deleteAdapterById(adapter.id);
      }

      if (adapter.status === "public") {
        registry.unregisterPublic(platform);
      } else {
        registry.unregisterScoped(platform, adapter.ownerId);
      }

      await removeInteractionProfileIfUnused(platform);
    } catch (error) {
      return logInternalRouteError(c, error);
    }

    return c.json({ platform, status: admin ? "archived" : "removed", scope: adapter.status });
  });

  adapterApp.post("/adapters/:platform/promote", apiKeyAuthMiddleware, requireScope("admin"), async (c) => {
    const platform = normalizePlatform(c.req.param("platform"));
    const parsedQuery = promoteQuerySchema.safeParse({
      owner_id: c.req.query("owner_id"),
    });

    if (!parsedQuery.success) {
      return c.json(
        {
          error: "Invalid request",
          details: z.treeifyError(parsedQuery.error),
        },
        400,
      );
    }

    const promotableCandidates = await listPromotableAdaptersByPlatform(platform);
    if (promotableCandidates.length === 0) {
      return c.json({ error: "Promotable adapter not found" }, 404);
    }

    const ownerIdFilter = parsedQuery.data.owner_id;
    const candidate = ownerIdFilter
      ? promotableCandidates.find((item) => item.ownerId === ownerIdFilter)
      : promotableCandidates.length === 1
        ? promotableCandidates[0]
        : null;

    if (!candidate) {
      if (ownerIdFilter) {
        return c.json(
          { error: "Promotable adapter not found", message: `No promotable adapter for owner '${ownerIdFilter}'.` },
          404,
        );
      }

      return c.json(
        {
          error: "Ambiguous promotion candidate",
          message: "Multiple promotable adapters exist for this platform. Specify ?owner_id=<owner>.",
          owners: promotableCandidates.map((item) => item.ownerId),
        },
        409,
      );
    }

    const existingPublic = await getPublicAdapterByPlatform(platform);
    if (existingPublic && existingPublic.id !== candidate.id) {
      const rejectedPath = resolveRejectedAdapterPath(platform, existingPublic.id);
      let rejectedFilePath = existingPublic.filePath;

      try {
        if (await fileExists(existingPublic.filePath)) {
          await moveFile(existingPublic.filePath, rejectedPath);
          rejectedFilePath = rejectedPath;
        }

        await markAdapterRejected({ adapterId: existingPublic.id, filePath: rejectedFilePath });
        registry.unregisterPublic(platform);
      } catch (error) {
        return logInternalRouteError(c, error);
      }
    }

    const publicPath = resolvePublicAdapterPath(platform);
    try {
      if (!(await fileExists(candidate.filePath))) {
        return logInternalRouteError(
          c,
          new Error(`Promotable adapter file missing for platform '${platform}'`),
        );
      }

      await moveFile(candidate.filePath, publicPath);
      await markAdapterPublic({
        adapterId: candidate.id,
        promotedBy: c.get("apiKeyId") ?? "admin",
        filePath: publicPath,
      });
      registry.unregisterScoped(platform, candidate.ownerId);
      await registry.hotLoadPublic(platform, publicPath);
    } catch (error) {
      return logInternalRouteError(c, error);
    }

    return c.json({
      platform,
      ownerId: candidate.ownerId,
      status: "public",
      source: publicPath,
    });
  });

  adapterApp.post("/adapters/:platform/demote", apiKeyAuthMiddleware, requireScope("admin"), async (c) => {
    const platform = normalizePlatform(c.req.param("platform"));
    const publicAdapter = await getPublicAdapterByPlatform(platform);
    if (!publicAdapter) {
      return c.json({ error: "Public adapter not found" }, 404);
    }

    const sandboxPath = resolveSandboxAdapterPath(publicAdapter.ownerId, platform);

    try {
      if (!(await fileExists(publicAdapter.filePath))) {
        return logInternalRouteError(
          c,
          new Error(`Public adapter file missing for platform '${platform}'`),
        );
      }

      await moveFile(publicAdapter.filePath, sandboxPath);
      await markAdapterSandbox({
        adapterId: publicAdapter.id,
        filePath: sandboxPath,
      });
      registry.unregisterPublic(platform);
      await registry.hotLoadScoped(platform, publicAdapter.ownerId, sandboxPath);
    } catch (error) {
      return logInternalRouteError(c, error);
    }

    return c.json({
      platform,
      ownerId: publicAdapter.ownerId,
      status: "sandbox",
      source: sandboxPath,
    });
  });

  adapterApp.post("/adapters/:platform/restore", apiKeyAuthMiddleware, requireScope("admin"), async (c) => {
    const platform = normalizePlatform(c.req.param("platform"));
    const parsedQuery = promoteQuerySchema.safeParse({
      owner_id: c.req.query("owner_id"),
    });

    if (!parsedQuery.success) {
      return c.json(
        {
          error: "Invalid request",
          details: z.treeifyError(parsedQuery.error),
        },
        400,
      );
    }

    const ownerIdFilter = parsedQuery.data.owner_id;
    const adapter = ownerIdFilter
      ? await getAdapterByPlatformOwner(platform, ownerIdFilter)
      : null;

    if (!adapter || adapter.status !== "archived") {
      return c.json({ error: "Archived adapter not found" }, 404);
    }

    if (!adapter.sourceCode) {
      return c.json(
        {
          error: "Source unavailable",
          message: "Cannot restore adapter — source code was not preserved.",
        },
        400,
      );
    }

    const sandboxPath = resolveSandboxAdapterPath(adapter.ownerId, platform);

    try {
      await mkdir(path.dirname(sandboxPath), { recursive: true });
      await writeFile(sandboxPath, adapter.sourceCode, "utf8");
      await markAdapterSandbox({
        adapterId: adapter.id,
        filePath: sandboxPath,
      });
      await registry.hotLoadScoped(platform, adapter.ownerId, sandboxPath);
    } catch (error) {
      return logInternalRouteError(c, error);
    }

    return c.json({
      platform,
      ownerId: adapter.ownerId,
      status: "sandbox",
      source: sandboxPath,
    });
  });


  return adapterApp;
}
