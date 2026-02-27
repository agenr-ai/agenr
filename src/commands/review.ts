import { readConfig } from "../config.js";
import { closeDb, getDb, initDb } from "../db/client.js";
import { retireEntries } from "../db/retirements.js";
import {
  getPendingReviewById,
  getPendingReviews,
  rehabilitateEntry,
  resolveReview,
  type PendingReviewItem,
} from "../db/review-queue.js";
import { parseDaysBetween } from "../utils/entry-utils.js";

export interface ReviewCommandOptions {
  db?: string;
  limit?: number;
}

export interface ReviewCommandDeps {
  readConfigFn: typeof readConfig;
  getDbFn: typeof getDb;
  initDbFn: typeof initDb;
  closeDbFn: typeof closeDb;
  retireEntriesFn: typeof retireEntries;
  nowFn: () => Date;
}

function summarize(text: string, maxLength = 40): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function resolveEntryLabel(item: PendingReviewItem): string {
  const subject = item.entrySubject.trim();
  if (subject) {
    return summarize(subject, 40);
  }
  return summarize(item.entryContent, 40) || "(missing entry)";
}

function formatAge(iso: string, now: Date): string {
  const ageDays = parseDaysBetween(now, iso);
  if (ageDays < 1 / 24) {
    return "<1h";
  }
  if (ageDays < 1) {
    return `${Math.max(1, Math.round(ageDays * 24))}h`;
  }
  return `${Math.round(ageDays)}d`;
}

function pad(value: string, width: number): string {
  if (value.length >= width) {
    return value;
  }
  return `${value}${" ".repeat(width - value.length)}`;
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => {
    const rowMax = rows.reduce((max, row) => Math.max(max, row[index]?.length ?? 0), 0);
    return Math.max(header.length, rowMax);
  });

  const headerLine = headers.map((header, index) => pad(header, widths[index] ?? header.length)).join(" | ");
  const separator = widths.map((width) => "-".repeat(width)).join("-+-");
  const body = rows.map((row) => row.map((cell, index) => pad(cell, widths[index] ?? cell.length)).join(" | "));

  return [headerLine, separator, ...body].join("\n");
}

export async function runReviewCommand(
  options: ReviewCommandOptions = {},
  deps: Partial<ReviewCommandDeps> = {},
): Promise<{ exitCode: number }> {
  const resolvedDeps: ReviewCommandDeps = {
    readConfigFn: deps.readConfigFn ?? readConfig,
    getDbFn: deps.getDbFn ?? getDb,
    initDbFn: deps.initDbFn ?? initDb,
    closeDbFn: deps.closeDbFn ?? closeDb,
    retireEntriesFn: deps.retireEntriesFn ?? retireEntries,
    nowFn: deps.nowFn ?? (() => new Date()),
  };

  const config = resolvedDeps.readConfigFn(process.env);
  const dbPath = options.db?.trim() || config?.db?.path;
  const db = resolvedDeps.getDbFn(dbPath);

  try {
    await resolvedDeps.initDbFn(db);
    const pending = await getPendingReviews(db, options.limit ?? 20);
    if (pending.length === 0) {
      process.stdout.write("No pending review items.\n");
      return { exitCode: 0 };
    }

    const now = resolvedDeps.nowFn();
    const rows = pending.map((item) => [
      item.id,
      resolveEntryLabel(item),
      item.reason,
      summarize(item.detail, 60),
      item.suggestedAction,
      formatAge(item.createdAt, now),
    ]);

    process.stdout.write(
      `${renderTable(["id", "entry", "reason", "detail", "action", "age"], rows)}\n`,
    );
    return { exitCode: 0 };
  } finally {
    resolvedDeps.closeDbFn(db);
  }
}

export async function runReviewDismissCommand(
  reviewId: string,
  options: ReviewCommandOptions = {},
  deps: Partial<ReviewCommandDeps> = {},
): Promise<{ exitCode: number }> {
  const resolvedDeps: ReviewCommandDeps = {
    readConfigFn: deps.readConfigFn ?? readConfig,
    getDbFn: deps.getDbFn ?? getDb,
    initDbFn: deps.initDbFn ?? initDb,
    closeDbFn: deps.closeDbFn ?? closeDb,
    retireEntriesFn: deps.retireEntriesFn ?? retireEntries,
    nowFn: deps.nowFn ?? (() => new Date()),
  };

  const normalizedId = reviewId.trim();
  if (!normalizedId) {
    throw new Error("review id is required");
  }

  const config = resolvedDeps.readConfigFn(process.env);
  const dbPath = options.db?.trim() || config?.db?.path;
  const db = resolvedDeps.getDbFn(dbPath);

  try {
    await resolvedDeps.initDbFn(db);
    const updated = await resolveReview(db, normalizedId, "dismissed");
    if (!updated) {
      process.stdout.write(`No pending review found for id: ${normalizedId}\n`);
      return { exitCode: 1 };
    }
    const review = await getPendingReviewById(db, normalizedId);
    if (review) {
      await rehabilitateEntry(db, review.entryId);
    }

    process.stdout.write(`Dismissed review ${normalizedId}.\n`);
    return { exitCode: 0 };
  } finally {
    resolvedDeps.closeDbFn(db);
  }
}

export async function runReviewRetireCommand(
  reviewId: string,
  options: ReviewCommandOptions = {},
  deps: Partial<ReviewCommandDeps> = {},
): Promise<{ exitCode: number }> {
  const resolvedDeps: ReviewCommandDeps = {
    readConfigFn: deps.readConfigFn ?? readConfig,
    getDbFn: deps.getDbFn ?? getDb,
    initDbFn: deps.initDbFn ?? initDb,
    closeDbFn: deps.closeDbFn ?? closeDb,
    retireEntriesFn: deps.retireEntriesFn ?? retireEntries,
    nowFn: deps.nowFn ?? (() => new Date()),
  };

  const normalizedId = reviewId.trim();
  if (!normalizedId) {
    throw new Error("review id is required");
  }

  const config = resolvedDeps.readConfigFn(process.env);
  const dbPath = options.db?.trim() || config?.db?.path;
  const db = resolvedDeps.getDbFn(dbPath);

  try {
    await resolvedDeps.initDbFn(db);
    const review = await getPendingReviewById(db, normalizedId);
    if (!review) {
      process.stdout.write(`Review item not found: ${normalizedId}\n`);
      return { exitCode: 1 };
    }
    if (review.status !== "pending") {
      process.stdout.write(`Review item is already ${review.status}: ${normalizedId}\n`);
      return { exitCode: 1 };
    }

    const retired = await resolvedDeps.retireEntriesFn({
      entryId: review.entryId,
      reason: `review_queue:${normalizedId}:${review.reason}`,
      writeLedger: false,
      db,
      dbPath,
    });

    const resolved = await resolveReview(db, normalizedId, "resolved");
    if (!resolved) {
      process.stdout.write(`Failed to resolve review item: ${normalizedId}\n`);
      return { exitCode: 1 };
    }

    process.stdout.write(
      `Retired ${retired.count} entr${retired.count === 1 ? "y" : "ies"} and resolved review ${normalizedId}.\n`,
    );
    return { exitCode: 0 };
  } finally {
    resolvedDeps.closeDbFn(db);
  }
}
