import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { toNumber, toRowsAffected, toStringValue } from "../utils/entry-utils.js";

export const REVIEW_REASONS = ["low_quality", "contradicted", "stale", "manual"] as const;
export const REVIEW_ACTIONS = ["retire", "review", "merge"] as const;
export const REVIEW_STATUSES = ["pending", "dismissed", "resolved"] as const;

export type ReviewReason = (typeof REVIEW_REASONS)[number];
export type ReviewSuggestedAction = (typeof REVIEW_ACTIONS)[number];
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export interface PendingReviewItem {
  id: string;
  entryId: string;
  reason: ReviewReason;
  detail: string;
  suggestedAction: ReviewSuggestedAction;
  status: ReviewStatus;
  createdAt: string;
  resolvedAt: string;
  entrySubject: string;
  entryContent: string;
}

function ensureReason(reason: string): ReviewReason {
  if ((REVIEW_REASONS as readonly string[]).includes(reason)) {
    return reason as ReviewReason;
  }
  throw new Error(`Invalid review reason: ${reason}`);
}

function ensureAction(action: string): ReviewSuggestedAction {
  if ((REVIEW_ACTIONS as readonly string[]).includes(action)) {
    return action as ReviewSuggestedAction;
  }
  throw new Error(`Invalid review suggested action: ${action}`);
}

export async function flagForReview(
  db: Client,
  entryId: string,
  reason: ReviewReason,
  detail: string | null,
  suggestedAction: ReviewSuggestedAction,
): Promise<{ created: boolean; id: string | null }> {
  const normalizedEntryId = entryId.trim();
  const normalizedReason = ensureReason(reason);
  const normalizedAction = ensureAction(suggestedAction);

  if (!normalizedEntryId) {
    throw new Error("entryId is required");
  }

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const inserted = await db.execute({
    sql: `
      INSERT INTO review_queue (
        id,
        entry_id,
        reason,
        detail,
        suggested_action,
        status,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
      ON CONFLICT DO NOTHING
    `,
    args: [id, normalizedEntryId, normalizedReason, detail, normalizedAction, createdAt],
  });

  if (toRowsAffected(inserted.rowsAffected) === 0) {
    return {
      created: false,
      id: null,
    };
  }

  return { created: true, id };
}

export async function getPendingReviews(db: Client, limit = 20): Promise<PendingReviewItem[]> {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;

  const result = await db.execute({
    sql: `
      SELECT
        review_queue.id,
        review_queue.entry_id,
        review_queue.reason,
        review_queue.detail,
        review_queue.suggested_action,
        review_queue.status,
        review_queue.created_at,
        review_queue.resolved_at,
        entries.subject,
        entries.content
      FROM review_queue
      LEFT JOIN entries ON entries.id = review_queue.entry_id
      WHERE review_queue.status = 'pending'
      ORDER BY review_queue.created_at ASC
      LIMIT ?
    `,
    args: [safeLimit],
  });

  return result.rows.map((row) => ({
    id: toStringValue((row as { id?: unknown }).id),
    entryId: toStringValue((row as { entry_id?: unknown }).entry_id),
    reason: ensureReason(toStringValue((row as { reason?: unknown }).reason)),
    detail: toStringValue((row as { detail?: unknown }).detail),
    suggestedAction: ensureAction(toStringValue((row as { suggested_action?: unknown }).suggested_action)),
    status: (toStringValue((row as { status?: unknown }).status) || "pending") as ReviewStatus,
    createdAt: toStringValue((row as { created_at?: unknown }).created_at),
    resolvedAt: toStringValue((row as { resolved_at?: unknown }).resolved_at),
    entrySubject: toStringValue((row as { subject?: unknown }).subject),
    entryContent: toStringValue((row as { content?: unknown }).content),
  }));
}

export async function resolveReview(
  db: Client,
  reviewId: string,
  status: "dismissed" | "resolved",
): Promise<boolean> {
  const normalizedReviewId = reviewId.trim();
  if (!normalizedReviewId) {
    return false;
  }

  const resolvedAt = new Date().toISOString();
  const result = await db.execute({
    sql: `
      UPDATE review_queue
      SET status = ?,
          resolved_at = ?
      WHERE id = ?
        AND status = 'pending'
    `,
    args: [status, resolvedAt, normalizedReviewId],
  });

  return toRowsAffected(result.rowsAffected) > 0;
}

export async function checkAndFlagLowQuality(
  db: Client,
  entryId: string,
  qualityScore: number,
  recallCount: number,
): Promise<void> {
  if (!Number.isFinite(qualityScore) || !Number.isFinite(recallCount)) {
    return;
  }
  if (qualityScore >= 0.2 || recallCount < 10) {
    return;
  }

  const roundedQuality = Math.max(0, Math.min(1, qualityScore));
  const detail = `quality_score ${roundedQuality.toFixed(3)} after ${Math.floor(recallCount)} recalls`;
  await flagForReview(db, entryId, "low_quality", detail, "retire");
}

export async function getPendingReviewById(db: Client, reviewId: string): Promise<PendingReviewItem | null> {
  const normalizedReviewId = reviewId.trim();
  if (!normalizedReviewId) {
    return null;
  }

  const result = await db.execute({
    sql: `
      SELECT
        review_queue.id,
        review_queue.entry_id,
        review_queue.reason,
        review_queue.detail,
        review_queue.suggested_action,
        review_queue.status,
        review_queue.created_at,
        review_queue.resolved_at,
        entries.subject,
        entries.content
      FROM review_queue
      LEFT JOIN entries ON entries.id = review_queue.entry_id
      WHERE review_queue.id = ?
      LIMIT 1
    `,
    args: [normalizedReviewId],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }

  return {
    id: toStringValue(row.id),
    entryId: toStringValue(row.entry_id),
    reason: ensureReason(toStringValue(row.reason)),
    detail: toStringValue(row.detail),
    suggestedAction: ensureAction(toStringValue(row.suggested_action)),
    status: (toStringValue(row.status) || "pending") as ReviewStatus,
    createdAt: toStringValue(row.created_at),
    resolvedAt: toStringValue(row.resolved_at),
    entrySubject: toStringValue(row.subject),
    entryContent: toStringValue(row.content),
  };
}

export async function getPendingReviewCountsByReason(
  db: Client,
): Promise<Array<{ reason: ReviewReason; count: number }>> {
  const result = await db.execute({
    sql: `
      SELECT reason, COUNT(*) AS count
      FROM review_queue
      WHERE status = 'pending'
      GROUP BY reason
      ORDER BY count DESC, reason ASC
    `,
    args: [],
  });

  return result.rows.map((row) => ({
    reason: ensureReason(toStringValue((row as { reason?: unknown }).reason)),
    count: toNumber((row as { count?: unknown }).count),
  }));
}

export async function getOldestPendingReviewCreatedAt(db: Client): Promise<string | null> {
  const result = await db.execute({
    sql: `
      SELECT MIN(created_at) AS oldest_created_at
      FROM review_queue
      WHERE status = 'pending'
    `,
    args: [],
  });

  const oldest = toStringValue((result.rows[0] as { oldest_created_at?: unknown } | undefined)?.oldest_created_at);
  return oldest || null;
}

export async function rehabilitateEntry(db: Client, entryId: string, floor = 0.3): Promise<void> {
  const normalizedEntryId = entryId.trim();
  if (!normalizedEntryId || !Number.isFinite(floor)) {
    return;
  }

  await db.execute({
    sql: `
      UPDATE entries
      SET quality_score = MAX(COALESCE(quality_score, 0.5), ?)
      WHERE id = ?
    `,
    args: [floor, normalizedEntryId],
  });
}
