import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { getDb } from "./client";

export type AdapterStatus = "sandbox" | "review" | "public" | "rejected" | "archived";

export interface AdapterRecord {
  id: string;
  platform: string;
  ownerId: string;
  status: AdapterStatus;
  filePath: string;
  sourceCode: string | null;
  sourceHash: string | null;
  createdAt: string;
  promotedAt: string | null;
  promotedBy: string | null;
  reviewMessage: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewFeedback: string | null;
  archivedAt: string | null;
}

interface UpsertSandboxAdapterParams {
  platform: string;
  ownerId: string;
  filePath: string;
  sourceCode?: string;
}

interface SeedBundledAdapterParams {
  platform: string;
  filePath: string;
  sourceCode: string;
}

interface UpdateBundledAdapterParams {
  adapterId: string;
  filePath: string;
  sourceCode: string;
}

interface MarkAdapterPublicParams {
  adapterId: string;
  promotedBy: string;
  filePath?: string;
}

interface MarkAdapterSandboxParams {
  adapterId: string;
  filePath: string;
}

interface MarkAdapterRejectedParams {
  adapterId: string;
  filePath?: string;
}

interface MarkAdapterReviewParams {
  adapterId: string;
  reviewMessage?: string;
}

interface MarkAdapterRejectedWithFeedbackParams {
  adapterId: string;
  feedback: string;
}

interface MarkAdapterArchivedParams {
  adapterId: string;
}

const ADAPTER_COLUMNS = `
  id,
  platform,
  owner_id,
  status,
  file_path,
  source_code,
  source_hash,
  created_at,
  promoted_at,
  promoted_by,
  review_message,
  submitted_at,
  reviewed_at,
  review_feedback,
  archived_at
`;
const MANIFEST_VERSION_REGEX = /version:\s*["']([^"']+)["']/;

function normalizePlatform(platform: string): string {
  return platform.trim().toLowerCase();
}

function parseStatus(value: unknown): AdapterStatus | null {
  if (value === "sandbox" || value === "review" || value === "public" || value === "rejected" || value === "archived") {
    return value;
  }

  return null;
}

function resolveSourceCode(filePath: string, sourceCode: string | undefined): string | null {
  if (typeof sourceCode === "string") {
    return sourceCode;
  }

  if (!existsSync(filePath)) {
    return null;
  }

  return readFileSync(filePath, "utf8");
}

function hashSourceCode(sourceCode: string | null): string | null {
  if (sourceCode === null) {
    return null;
  }

  return createHash("sha256").update(sourceCode).digest("hex");
}

function extractManifestVersion(sourceCode: string | null): string | null {
  if (sourceCode === null) {
    return null;
  }

  const match = sourceCode.match(MANIFEST_VERSION_REGEX);
  if (!match) {
    return null;
  }

  const version = match[1]?.trim();
  return version ? version : null;
}

function toAdapterRecord(row: Record<string, unknown>): AdapterRecord | null {
  const id = row["id"];
  const platform = row["platform"];
  const ownerId = row["owner_id"];
  const status = parseStatus(row["status"]);
  const filePath = row["file_path"];
  const createdAt = row["created_at"];

  if (
    typeof id !== "string" ||
    typeof platform !== "string" ||
    typeof ownerId !== "string" ||
    !status ||
    typeof filePath !== "string" ||
    typeof createdAt !== "string"
  ) {
    return null;
  }

  return {
    id,
    platform,
    ownerId,
    status,
    filePath,
    sourceCode: typeof row["source_code"] === "string" ? row["source_code"] : null,
    sourceHash: typeof row["source_hash"] === "string" ? row["source_hash"] : null,
    createdAt,
    promotedAt: typeof row["promoted_at"] === "string" ? row["promoted_at"] : null,
    promotedBy: typeof row["promoted_by"] === "string" ? row["promoted_by"] : null,
    reviewMessage: typeof row["review_message"] === "string" ? row["review_message"] : null,
    submittedAt: typeof row["submitted_at"] === "string" ? row["submitted_at"] : null,
    reviewedAt: typeof row["reviewed_at"] === "string" ? row["reviewed_at"] : null,
    reviewFeedback: typeof row["review_feedback"] === "string" ? row["review_feedback"] : null,
    archivedAt: typeof row["archived_at"] === "string" ? row["archived_at"] : null,
  };
}

function readCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : 0;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : 0;
  }

  return 0;
}

export async function getAdapterById(id: string): Promise<AdapterRecord | null> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT ${ADAPTER_COLUMNS}
      FROM adapters
      WHERE id = ?`,
    args: [id],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }

  return toAdapterRecord(row);
}

export async function getAdapterByPlatformOwner(
  platform: string,
  ownerId: string,
): Promise<AdapterRecord | null> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT ${ADAPTER_COLUMNS}
      FROM adapters
      WHERE platform = ? AND owner_id = ?`,
    args: [normalizePlatform(platform), ownerId],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }

  return toAdapterRecord(row);
}

export async function getPublicAdapterByPlatform(platform: string): Promise<AdapterRecord | null> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT ${ADAPTER_COLUMNS}
      FROM adapters
      WHERE platform = ? AND status = 'public'`,
    args: [normalizePlatform(platform)],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }

  return toAdapterRecord(row);
}

export async function getBundledAdapterState(
  platform: string,
): Promise<{ id: string; version: string | null; ownerId: string | null } | null> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT id, source_code, owner_id
      FROM adapters
      WHERE platform = ? AND status = 'public'
      LIMIT 1`,
    args: [normalizePlatform(platform)],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }

  const id = row["id"];
  if (typeof id !== "string") {
    return null;
  }

  const sourceCode = typeof row["source_code"] === "string" ? row["source_code"] : null;
  const ownerId = typeof row["owner_id"] === "string" ? row["owner_id"] : null;
  return {
    id,
    version: extractManifestVersion(sourceCode),
    ownerId,
  };
}

export async function getActiveAdapterByPlatform(platform: string): Promise<AdapterRecord | null> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT ${ADAPTER_COLUMNS}
      FROM adapters
      WHERE platform = ?
      AND status IN ('public', 'sandbox', 'review')
    ORDER BY
      CASE status
        WHEN 'public' THEN 0
        ELSE 1
      END ASC,
      created_at DESC
    LIMIT 1`,
    args: [normalizePlatform(platform)],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }

  return toAdapterRecord(row);
}

export async function getActiveAdapterByPlatformOwner(
  platform: string,
  ownerId: string,
): Promise<AdapterRecord | null> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT ${ADAPTER_COLUMNS}
      FROM adapters
      WHERE platform = ?
        AND owner_id = ?
        AND status IN ('public', 'sandbox', 'review')
      ORDER BY
        CASE status
          WHEN 'public' THEN 0
          ELSE 1
        END ASC,
        created_at DESC
      LIMIT 1`,
    args: [normalizePlatform(platform), ownerId],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }

  return toAdapterRecord(row);
}

export async function listSandboxAdaptersByPlatform(platform: string): Promise<AdapterRecord[]> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT ${ADAPTER_COLUMNS}
      FROM adapters
      WHERE platform = ? AND status = 'sandbox'
      ORDER BY created_at DESC`,
    args: [normalizePlatform(platform)],
  });

  return result.rows
    .map((row) => toAdapterRecord(row as Record<string, unknown>))
    .filter((row): row is AdapterRecord => row !== null);
}

export async function listVisibleAdapters(ownerId: string): Promise<AdapterRecord[]> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT ${ADAPTER_COLUMNS}
      FROM adapters
      WHERE status IN ('sandbox', 'review', 'public')
      AND (status = 'public' OR owner_id = ?)
      ORDER BY platform ASC, status ASC, created_at DESC`,
    args: [ownerId],
  });

  return result.rows
    .map((row) => toAdapterRecord(row as Record<string, unknown>))
    .filter((row): row is AdapterRecord => row !== null);
}

export async function listActiveAdapters(): Promise<AdapterRecord[]> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT ${ADAPTER_COLUMNS}
      FROM adapters
      WHERE status IN ('sandbox', 'review', 'public')
      ORDER BY platform ASC, status ASC, created_at DESC`,
  });

  return result.rows
    .map((row) => toAdapterRecord(row as Record<string, unknown>))
    .filter((row): row is AdapterRecord => row !== null);
}

export async function getAdaptersWithSource(): Promise<AdapterRecord[]> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT ${ADAPTER_COLUMNS}
      FROM adapters
      WHERE status IN ('sandbox', 'review', 'public')
        AND source_code IS NOT NULL
      ORDER BY platform ASC, status ASC, created_at DESC`,
  });

  return result.rows
    .map((row) => toAdapterRecord(row as Record<string, unknown>))
    .filter((row): row is AdapterRecord => row !== null);
}

export async function upsertSandboxAdapter(
  params: UpsertSandboxAdapterParams,
): Promise<AdapterRecord> {
  const platform = normalizePlatform(params.platform);
  const ownerId = params.ownerId.trim();
  const filePath = params.filePath.trim();
  const createdAt = new Date().toISOString();

  if (!ownerId) {
    throw new Error("Cannot upsert sandbox adapter without an owner id.");
  }

  if (!filePath) {
    throw new Error("Cannot upsert sandbox adapter without a file path.");
  }

  const sourceCode = resolveSourceCode(filePath, params.sourceCode);
  const sourceHash = hashSourceCode(sourceCode);

  const existing = await getAdapterByPlatformOwner(platform, ownerId);
  const db = getDb();

  if (existing) {
    if (existing.status === "public") {
      throw new Error(
        `Owner '${ownerId}' already has platform '${platform}' promoted to public. Demote before generating a new sandbox adapter.`,
      );
    }

    await db.execute({
      sql: `UPDATE adapters
        SET status = 'sandbox',
            file_path = ?,
            source_code = ?,
            source_hash = ?,
            created_at = ?,
            promoted_at = NULL,
            promoted_by = NULL,
            submitted_at = NULL,
            archived_at = NULL
        WHERE id = ?`,
      args: [filePath, sourceCode, sourceHash, createdAt, existing.id],
    });

    const updated = await getAdapterById(existing.id);
    if (!updated) {
      throw new Error(`Failed to update adapter '${existing.id}'.`);
    }

    return updated;
  }

  const id = crypto.randomUUID();
  await db.execute({
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
      promoted_by,
      review_message,
      submitted_at,
      reviewed_at,
      review_feedback,
      archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, platform, ownerId, "sandbox", filePath, sourceCode, sourceHash, createdAt, null, null, null, null, null, null, null],
  });

  const inserted = await getAdapterById(id);
  if (!inserted) {
    throw new Error(`Failed to create adapter '${id}'.`);
  }

  return inserted;
}

export async function seedBundledAdapter(
  params: SeedBundledAdapterParams,
): Promise<{ adapterId: string }> {
  const db = getDb();
  const id = crypto.randomUUID();
  const platform = normalizePlatform(params.platform);
  const filePath = params.filePath.trim();
  const sourceCode = params.sourceCode;
  const sourceHash = hashSourceCode(sourceCode);
  const now = new Date().toISOString();

  if (!filePath) {
    throw new Error("Cannot seed bundled adapter without a file path.");
  }

  await db.execute({
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
      promoted_by,
      review_message,
      submitted_at,
      reviewed_at,
      review_feedback,
      archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      platform,
      "system",
      "public",
      filePath,
      sourceCode,
      sourceHash,
      now,
      now,
      "system",
      null,
      null,
      null,
      null,
      null,
    ],
  });

  return { adapterId: id };
}

export async function updateBundledAdapter(
  params: UpdateBundledAdapterParams,
): Promise<{ adapterId: string }> {
  const db = getDb();
  const filePath = params.filePath.trim();
  const sourceCode = params.sourceCode;
  const sourceHash = hashSourceCode(sourceCode);
  const promotedAt = new Date().toISOString();

  if (!filePath) {
    throw new Error("Cannot update bundled adapter without a file path.");
  }

  await db.execute({
    sql: `UPDATE adapters
      SET status = 'public',
          file_path = ?,
          source_code = ?,
          source_hash = ?,
          promoted_at = ?,
          promoted_by = 'system',
          archived_at = NULL
      WHERE id = ?`,
    args: [filePath, sourceCode, sourceHash, promotedAt, params.adapterId],
  });

  return { adapterId: params.adapterId };
}

export async function markAdapterPublic(params: MarkAdapterPublicParams): Promise<void> {
  const db = getDb();
  const promotedAt = new Date().toISOString();
  await db.execute({
    sql: `UPDATE adapters
      SET status = 'public',
          file_path = COALESCE(?, file_path),
          promoted_at = ?,
          promoted_by = ?,
          reviewed_at = CASE WHEN status = 'review' THEN ? ELSE reviewed_at END,
          archived_at = NULL
      WHERE id = ?`,
    args: [params.filePath ?? null, promotedAt, params.promotedBy, promotedAt, params.adapterId],
  });
}

export async function markAdapterSandbox(params: MarkAdapterSandboxParams): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `UPDATE adapters
      SET status = 'sandbox',
          file_path = ?,
          promoted_at = NULL,
          promoted_by = NULL,
          submitted_at = NULL,
          archived_at = NULL
      WHERE id = ?`,
    args: [params.filePath, params.adapterId],
  });
}

export async function markAdapterRejected(params: MarkAdapterRejectedParams): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `UPDATE adapters
      SET status = 'rejected',
          file_path = COALESCE(?, file_path),
          promoted_at = NULL,
          promoted_by = NULL,
          submitted_at = NULL,
          archived_at = NULL
      WHERE id = ?`,
    args: [params.filePath ?? null, params.adapterId],
  });
}

export async function markAdapterReview(params: MarkAdapterReviewParams): Promise<void> {
  const db = getDb();
  const submittedAt = new Date().toISOString();
  await db.execute({
    sql: `UPDATE adapters
      SET status = 'review',
          review_message = ?,
          submitted_at = ?,
          reviewed_at = NULL,
          review_feedback = NULL,
          archived_at = NULL
      WHERE id = ?`,
    args: [params.reviewMessage?.trim() || null, submittedAt, params.adapterId],
  });
}

export async function markAdapterRejectedWithFeedback(
  params: MarkAdapterRejectedWithFeedbackParams,
): Promise<void> {
  const db = getDb();
  const reviewedAt = new Date().toISOString();
  await db.execute({
    sql: `UPDATE adapters
      SET status = 'sandbox',
          review_feedback = ?,
          reviewed_at = ?,
          submitted_at = NULL,
          promoted_at = NULL,
          promoted_by = NULL,
          archived_at = NULL
      WHERE id = ?`,
    args: [params.feedback.trim(), reviewedAt, params.adapterId],
  });
}

export async function markAdapterArchived(params: MarkAdapterArchivedParams): Promise<void> {
  const db = getDb();
  const archivedAt = new Date().toISOString();
  await db.execute({
    sql: `UPDATE adapters
      SET status = 'archived',
          archived_at = ?,
          promoted_at = NULL,
          promoted_by = NULL,
          submitted_at = NULL
      WHERE id = ?`,
    args: [archivedAt, params.adapterId],
  });
}

export async function listReviewAdapters(): Promise<AdapterRecord[]> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT ${ADAPTER_COLUMNS}
      FROM adapters
      WHERE status = 'review'
      ORDER BY submitted_at ASC, created_at ASC`,
  });

  return result.rows
    .map((row) => toAdapterRecord(row as Record<string, unknown>))
    .filter((row): row is AdapterRecord => row !== null);
}

export async function listReviewAdaptersByPlatform(platform: string): Promise<AdapterRecord[]> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT ${ADAPTER_COLUMNS}
      FROM adapters
      WHERE platform = ? AND status = 'review'
      ORDER BY submitted_at ASC, created_at ASC`,
    args: [normalizePlatform(platform)],
  });

  return result.rows
    .map((row) => toAdapterRecord(row as Record<string, unknown>))
    .filter((row): row is AdapterRecord => row !== null);
}

export async function listPromotableAdaptersByPlatform(platform: string): Promise<AdapterRecord[]> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT ${ADAPTER_COLUMNS}
      FROM adapters
      WHERE platform = ? AND status IN ('sandbox', 'review')
      ORDER BY
        CASE status
          WHEN 'review' THEN 0
          ELSE 1
        END ASC,
        submitted_at ASC,
        created_at DESC`,
    args: [normalizePlatform(platform)],
  });

  return result.rows
    .map((row) => toAdapterRecord(row as Record<string, unknown>))
    .filter((row): row is AdapterRecord => row !== null);
}

export async function listAllAdapters(options: { includeArchived?: boolean } = {}): Promise<AdapterRecord[]> {
  const db = getDb();
  const includeArchived = options.includeArchived === true;
  const result = await db.execute({
    sql: `SELECT ${ADAPTER_COLUMNS}
      FROM adapters
      ${includeArchived ? "" : "WHERE status != 'archived'"}
      ORDER BY platform ASC, status ASC, created_at DESC`,
  });

  return result.rows
    .map((row) => toAdapterRecord(row as Record<string, unknown>))
    .filter((row): row is AdapterRecord => row !== null);
}

export async function listArchivedAdapters(): Promise<AdapterRecord[]> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT ${ADAPTER_COLUMNS}
      FROM adapters
      WHERE status = 'archived'
      ORDER BY archived_at DESC, created_at DESC`,
  });

  return result.rows
    .map((row) => toAdapterRecord(row as Record<string, unknown>))
    .filter((row): row is AdapterRecord => row !== null);
}

export async function listArchivedAdaptersByPlatform(platform: string): Promise<AdapterRecord[]> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT ${ADAPTER_COLUMNS}
      FROM adapters
      WHERE status = 'archived' AND platform = ?
      ORDER BY archived_at DESC, created_at DESC`,
    args: [normalizePlatform(platform)],
  });

  return result.rows
    .map((row) => toAdapterRecord(row as Record<string, unknown>))
    .filter((row): row is AdapterRecord => row !== null);
}

export async function deleteAdapterById(id: string): Promise<boolean> {
  const db = getDb();
  const existing = await getAdapterById(id);
  if (!existing) {
    return false;
  }

  await db.execute({
    sql: "DELETE FROM adapters WHERE id = ?",
    args: [id],
  });

  return true;
}

export async function countActiveByPlatform(platform: string): Promise<number> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT COUNT(*) AS count
      FROM adapters
      WHERE platform = ?
        AND status IN ('sandbox', 'review', 'public')`,
    args: [normalizePlatform(platform)],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? readCount(row["count"]) : 0;
}
