import { getDb } from "../db/client";
import { logger } from "../utils/logger";

export type GenerationJobStatus = "queued" | "running" | "complete" | "failed";
export const ORPHANED_JOB_ERROR = "Orphaned by server restart";

export interface CreateJobParams {
  platform: string;
  docsUrl?: string;
  provider?: string;
  model?: string;
  ownerKeyId?: string;
}

export interface GenerationJob {
  id: string;
  platform: string;
  docsUrl: string | null;
  provider: string | null;
  model: string | null;
  status: GenerationJobStatus;
  ownerKeyId: string | null;
  logs: string[];
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface GenerationJobFilter {
  status?: string;
  ownerKeyId?: string;
  limit?: number;
  beforeCreatedAt?: string;
  beforeId?: string;
}

function normalizePlatform(platform: string): string {
  return platform.trim().toLowerCase();
}

function parseLogs(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function parseResult(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toGenerationJob(row: Record<string, unknown>): GenerationJob | null {
  const id = row["id"];
  const platform = row["platform"];
  const status = row["status"];
  const createdAt = row["created_at"];

  if (
    typeof id !== "string" ||
    typeof platform !== "string" ||
    (status !== "queued" && status !== "running" && status !== "complete" && status !== "failed") ||
    typeof createdAt !== "string"
  ) {
    return null;
  }

  return {
    id,
    platform,
    docsUrl: typeof row["docs_url"] === "string" ? row["docs_url"] : null,
    provider: typeof row["provider"] === "string" ? row["provider"] : null,
    model: typeof row["model"] === "string" ? row["model"] : null,
    status,
    ownerKeyId: typeof row["owner_key_id"] === "string" ? row["owner_key_id"] : null,
    logs: parseLogs(row["logs"]),
    result: parseResult(row["result"]),
    error: typeof row["error"] === "string" ? row["error"] : null,
    createdAt,
    startedAt: typeof row["started_at"] === "string" ? row["started_at"] : null,
    completedAt: typeof row["completed_at"] === "string" ? row["completed_at"] : null,
  };
}

function normalizeLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return 20;
  }

  return Math.min(value, 100);
}

export async function createJob(params: CreateJobParams): Promise<GenerationJob> {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const db = getDb();

  await db.execute({
    sql: `INSERT INTO generation_jobs (
      id,
      platform,
      docs_url,
      provider,
      model,
      status,
      owner_key_id,
      logs,
      result,
      error,
      created_at,
      started_at,
      completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      normalizePlatform(params.platform),
      params.docsUrl ?? null,
      params.provider ?? null,
      params.model ?? null,
      "queued",
      params.ownerKeyId ?? null,
      "[]",
      null,
      null,
      createdAt,
      null,
      null,
    ],
  });

  const job = await getJob(id);
  if (!job) {
    throw new Error(`Failed to create generation job '${id}'.`);
  }

  return job;
}

export async function claimNextJob(): Promise<GenerationJob | null> {
  const db = getDb();
  const now = new Date().toISOString();

  const result = await db.execute({
    sql: `UPDATE generation_jobs
      SET status = 'running', started_at = ?
      WHERE id = (
        SELECT id FROM generation_jobs
        WHERE status = 'queued'
        ORDER BY created_at ASC
        LIMIT 1
      )
      AND status = 'queued'
      RETURNING
        id,
        platform,
        docs_url,
        provider,
        model,
        status,
        owner_key_id,
        logs,
        result,
        error,
        created_at,
        started_at,
        completed_at`,
    args: [now],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }

  return toGenerationJob(row);
}

export async function appendJobLog(jobId: string, message: string): Promise<void> {
  const db = getDb();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await db.execute({
      sql: "SELECT logs FROM generation_jobs WHERE id = ?",
      args: [jobId],
    });

    const row = current.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      return;
    }

    const currentRawLogs = typeof row["logs"] === "string" ? row["logs"] : "[]";
    const logs = parseLogs(currentRawLogs);
    logs.push(message);

    const updated = await db.execute({
      sql: `UPDATE generation_jobs
        SET logs = ?
        WHERE id = ? AND logs = ?
        RETURNING id`,
      args: [JSON.stringify(logs), jobId, currentRawLogs],
    });

    if (updated.rows.length > 0) {
      return;
    }
  }

  throw new Error(`Failed to append log to generation job '${jobId}' after retries.`);
}

export async function completeJob(jobId: string, result: Record<string, unknown>): Promise<void> {
  const db = getDb();
  const completedAt = new Date().toISOString();

  await db.execute({
    sql: `UPDATE generation_jobs
      SET status = 'complete', result = ?, error = NULL, completed_at = ?
      WHERE id = ?`,
    args: [JSON.stringify(result), completedAt, jobId],
  });
}

export async function failJob(jobId: string, error: string): Promise<void> {
  const db = getDb();
  const completedAt = new Date().toISOString();

  await db.execute({
    sql: `UPDATE generation_jobs
      SET status = 'failed', error = ?, completed_at = ?
      WHERE id = ?`,
    args: [error, completedAt, jobId],
  });
}

export async function recoverStaleJobs(): Promise<number> {
  const db = getDb();
  const completedAt = new Date().toISOString();

  const result = await db.execute({
    sql: `UPDATE generation_jobs
      SET status = 'failed', error = ?, completed_at = ?
      WHERE status = 'running'
      RETURNING id`,
    args: [ORPHANED_JOB_ERROR, completedAt],
  });

  for (const row of result.rows) {
    const jobId = row["id"];
    if (typeof jobId === "string") {
      logger.info("generation_queue_stale_job_recovered", { jobId });
    }
  }

  return result.rows.length;
}

export async function getJob(jobId: string): Promise<GenerationJob | null> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT
      id,
      platform,
      docs_url,
      provider,
      model,
      status,
      owner_key_id,
      logs,
      result,
      error,
      created_at,
      started_at,
      completed_at
    FROM generation_jobs
    WHERE id = ?`,
    args: [jobId],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }

  return toGenerationJob(row);
}

export async function listJobs(filter: GenerationJobFilter = {}): Promise<GenerationJob[]> {
  const db = getDb();
  const conditions: string[] = [];
  const args: Array<string | number> = [];

  if (filter.status) {
    conditions.push("status = ?");
    args.push(filter.status);
  }

  if (filter.ownerKeyId) {
    conditions.push("owner_key_id = ?");
    args.push(filter.ownerKeyId);
  }

  if (filter.beforeCreatedAt) {
    if (filter.beforeId) {
      conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
      args.push(filter.beforeCreatedAt, filter.beforeCreatedAt, filter.beforeId);
    } else {
      conditions.push("created_at < ?");
      args.push(filter.beforeCreatedAt);
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = normalizeLimit(filter.limit);

  const result = await db.execute({
    sql: `SELECT
      id,
      platform,
      docs_url,
      provider,
      model,
      status,
      owner_key_id,
      logs,
      result,
      error,
      created_at,
      started_at,
      completed_at
    FROM generation_jobs
    ${whereClause}
    ORDER BY created_at DESC, id DESC
    LIMIT ?`,
    args: [...args, limit],
  });

  return result.rows
    .map((row) => toGenerationJob(row as Record<string, unknown>))
    .filter((job): job is GenerationJob => job !== null);
}
