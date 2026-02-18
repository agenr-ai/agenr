import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readConfig } from "../config.js";
import { forgettingScore, isProtected } from "../consolidate/rules.js";
import { closeDb, DEFAULT_DB_PATH, getDb } from "../db/client.js";
import type { StoredEntry } from "../types.js";

export interface HealthCommandOptions {
  db?: string;
}

export interface HealthCommandDeps {
  readConfigFn: typeof readConfig;
  getDbFn: typeof getDb;
  closeDbFn: typeof closeDb;
  statFn: typeof fs.stat;
  nowFn: () => Date;
}

interface HealthStats {
  total: number;
  todos: number;
  preferences: number;
  fileSizeBytes: number | null;
  oldestDate: string | null;
  newestDate: string | null;
  recency: {
    last7: number;
    last30: number;
    d30To90: number;
    d90Plus: number;
  };
  recall: {
    never: number;
    oneToFive: number;
    fivePlus: number;
  };
  forgetting: {
    candidates: number;
    protected: number;
    estimatedFreedBytes: number;
    threshold: number;
  };
  consolidation: {
    contradictionFlags: number;
    staleTodos: number;
  };
}

const MB = 1024 * 1024;

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim()) {
    return Number(value);
  }
  return Number.NaN;
}

function toStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function resolveUserPath(inputPath: string): string {
  if (!inputPath.startsWith("~")) {
    return inputPath;
  }
  return path.join(os.homedir(), inputPath.slice(1));
}

function resolveDbFilePath(rawPath: string): string {
  if (rawPath.startsWith("file:")) {
    return rawPath.slice("file:".length);
  }
  if (rawPath === ":memory:") {
    return rawPath;
  }
  return resolveUserPath(rawPath);
}

function parseDaysBetween(now: Date, pastIso: string): number {
  const parsed = new Date(pastIso);
  if (Number.isNaN(parsed.getTime())) {
    return 0;
  }
  const days = (now.getTime() - parsed.getTime()) / (1000 * 60 * 60 * 24);
  if (!Number.isFinite(days)) {
    return 0;
  }
  return Math.max(days, 0);
}

function asStoredEntry(row: Record<string, unknown>): StoredEntry {
  const scopeRaw = toStringValue(row.scope).trim();
  const platformRaw = toStringValue(row.platform).trim();
  const projectRaw = toStringValue(row.project).trim();
  const canonicalKey = toStringValue(row.canonical_key).trim();

  return {
    id: toStringValue(row.id),
    type: toStringValue(row.type) as StoredEntry["type"],
    subject: toStringValue(row.subject),
    content: toStringValue(row.content),
    ...(canonicalKey ? { canonical_key: canonicalKey } : {}),
    importance: Number.isFinite(toNumber(row.importance)) ? Math.max(1, Math.min(10, Math.round(toNumber(row.importance)))) : 5,
    expiry: toStringValue(row.expiry) as StoredEntry["expiry"],
    scope: (scopeRaw || "private") as StoredEntry["scope"],
    ...(platformRaw ? { platform: platformRaw as StoredEntry["platform"] } : {}),
    ...(projectRaw ? { project: projectRaw.toLowerCase() } : {}),
    tags: [],
    source: {
      file: toStringValue(row.source_file),
      context: toStringValue(row.source_context),
    },
    created_at: toStringValue(row.created_at),
    updated_at: toStringValue(row.updated_at),
    last_recalled_at: toStringValue(row.last_recalled_at) || undefined,
    recall_count: Number.isFinite(toNumber(row.recall_count)) ? toNumber(row.recall_count) : 0,
    confirmations: Number.isFinite(toNumber(row.confirmations)) ? toNumber(row.confirmations) : 0,
    contradictions: Number.isFinite(toNumber(row.contradictions)) ? toNumber(row.contradictions) : 0,
    superseded_by: toStringValue(row.superseded_by) || undefined,
  };
}

function formatInt(value: number): string {
  return value.toLocaleString("en-US");
}

function formatPct(count: number, total: number): string {
  if (total <= 0) {
    return "0%";
  }
  return `${Math.round((count / total) * 100)}%`;
}

function formatFileSize(bytes: number | null): string {
  if (bytes === null) {
    return "n/a";
  }
  if (bytes <= 0) {
    return "0MB";
  }
  return `${Math.round(bytes / MB)}MB`;
}

function formatDateLabel(iso: string | null, now: Date): string {
  if (!iso) {
    return "n/a";
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return "n/a";
  }
  const day = parsed.toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  if (day === today) {
    return "today";
  }
  return day;
}

async function getFileSizeBytes(statFn: typeof fs.stat, dbFilePath: string): Promise<number | null> {
  if (dbFilePath === ":memory:") {
    return null;
  }
  try {
    const stat = await statFn(dbFilePath);
    return stat.size;
  } catch {
    return null;
  }
}

function estimateFreedBytes(candidateCount: number, totalEntries: number, fileSizeBytes: number | null): number {
  if (!fileSizeBytes || fileSizeBytes <= 0 || totalEntries <= 0 || candidateCount <= 0) {
    return 0;
  }
  return Math.round(fileSizeBytes * (candidateCount / totalEntries));
}

async function collectHealthStats(
  db: ReturnType<typeof getDb>,
  now: Date,
  fileSizeBytes: number | null,
  forgettingThreshold: number,
  forgettingMaxAgeDays: number,
  protectPatterns: string[],
): Promise<HealthStats> {
  const rowsResult = await db.execute({
    sql: `
      SELECT
        id,
        type,
        subject,
        canonical_key,
        content,
        importance,
        expiry,
        scope,
        platform,
        project,
        source_file,
        source_context,
        created_at,
        updated_at,
        last_recalled_at,
        recall_count,
        confirmations,
        contradictions,
        superseded_by
      FROM entries
      WHERE superseded_by IS NULL
    `,
    args: [],
  });

  let total = 0;
  let todos = 0;
  let preferences = 0;
  let oldestDate: string | null = null;
  let newestDate: string | null = null;
  let recencyLast7 = 0;
  let recencyLast30 = 0;
  let recency30To90 = 0;
  let recency90Plus = 0;
  let neverRecalled = 0;
  let recalledOneToFive = 0;
  let recalledFivePlus = 0;
  let forgettingCandidates = 0;
  let forgettingProtected = 0;
  let contradictionFlags = 0;
  let staleTodos = 0;

  for (const raw of rowsResult.rows) {
    const entry = asStoredEntry(raw as Record<string, unknown>);
    total += 1;

    if (entry.type === "todo") {
      todos += 1;
    }
    if (entry.type === "preference") {
      preferences += 1;
    }

    if (!oldestDate || entry.created_at < oldestDate) {
      oldestDate = entry.created_at;
    }
    if (!newestDate || entry.created_at > newestDate) {
      newestDate = entry.created_at;
    }

    const ageDays = parseDaysBetween(now, entry.created_at);
    if (ageDays <= 7) {
      recencyLast7 += 1;
    } else if (ageDays <= 30) {
      recencyLast30 += 1;
    } else if (ageDays <= 90) {
      recency30To90 += 1;
    } else {
      recency90Plus += 1;
    }

    if (entry.recall_count <= 0) {
      neverRecalled += 1;
    } else if (entry.recall_count <= 5) {
      recalledOneToFive += 1;
    } else {
      recalledFivePlus += 1;
    }

    if (entry.contradictions > 0) {
      contradictionFlags += 1;
    }
    if (entry.type === "todo" && ageDays > 30 && entry.recall_count <= 0) {
      staleTodos += 1;
    }

    if (ageDays > forgettingMaxAgeDays) {
      const score = forgettingScore(entry, now);
      if (score < forgettingThreshold) {
        if (isProtected(entry, protectPatterns)) {
          forgettingProtected += 1;
        } else {
          forgettingCandidates += 1;
        }
      }
    }
  }

  return {
    total,
    todos,
    preferences,
    fileSizeBytes,
    oldestDate,
    newestDate,
    recency: {
      last7: recencyLast7,
      last30: recencyLast30,
      d30To90: recency30To90,
      d90Plus: recency90Plus,
    },
    recall: {
      never: neverRecalled,
      oneToFive: recalledOneToFive,
      fivePlus: recalledFivePlus,
    },
    forgetting: {
      candidates: forgettingCandidates,
      protected: forgettingProtected,
      estimatedFreedBytes: estimateFreedBytes(forgettingCandidates, total, fileSizeBytes),
      threshold: forgettingThreshold,
    },
    consolidation: {
      contradictionFlags,
      staleTodos,
    },
  };
}

function renderHealthOutput(stats: HealthStats, now: Date): string {
  const overTarget = (stats.fileSizeBytes ?? 0) > 200 * MB;
  const fileSizeNote = overTarget ? " (⚠ over 200MB target)" : "";

  const lines: string[] = [
    "DB Health ────────────────────────────────",
    `Entries: ${formatInt(stats.total)} total | ${formatInt(stats.todos)} todos | ${formatInt(stats.preferences)} preferences`,
    `File size: ${formatFileSize(stats.fileSizeBytes)}${fileSizeNote}`,
    `Oldest: ${formatDateLabel(stats.oldestDate, now)} | Newest: ${formatDateLabel(stats.newestDate, now)}`,
    "",
    "Recency Distribution",
    `- Last 7 days:  ${formatInt(stats.recency.last7)} entries (${formatPct(stats.recency.last7, stats.total)})`,
    `- Last 30 days: ${formatInt(stats.recency.last30)} entries (${formatPct(stats.recency.last30, stats.total)})`,
    `- 30-90 days:   ${formatInt(stats.recency.d30To90)} entries (${formatPct(stats.recency.d30To90, stats.total)})`,
    `- 90+ days:     ${formatInt(stats.recency.d90Plus)} entries (${formatPct(stats.recency.d90Plus, stats.total)})`,
    "",
    "Recall Activity",
    `- Never recalled: ${formatInt(stats.recall.never)} entries (${formatPct(stats.recall.never, stats.total)})`,
    `- Recalled 1-5x:  ${formatInt(stats.recall.oneToFive)} entries (${formatPct(stats.recall.oneToFive, stats.total)})`,
    `- Recalled 5+x:   ${formatInt(stats.recall.fivePlus)} entries (${formatPct(stats.recall.fivePlus, stats.total)})`,
    "",
    "Forgetting Candidates",
    `- score < ${stats.forgetting.threshold}:  ${formatInt(stats.forgetting.candidates)} entries (would free ~${formatFileSize(stats.forgetting.estimatedFreedBytes)})`,
    `- Protected:      ${formatInt(stats.forgetting.protected)} entries`,
    "",
    "Consolidation Health",
    `- Contradiction flags: ${formatInt(stats.consolidation.contradictionFlags)} entries`,
    `- Stale todos (>30d old, not recalled): ${formatInt(stats.consolidation.staleTodos)}`,
    "",
  ];

  return lines.join("\n");
}

export async function runHealthCommand(
  options: HealthCommandOptions = {},
  deps: Partial<HealthCommandDeps> = {},
): Promise<{ exitCode: number }> {
  const resolvedDeps: HealthCommandDeps = {
    readConfigFn: deps.readConfigFn ?? readConfig,
    getDbFn: deps.getDbFn ?? getDb,
    closeDbFn: deps.closeDbFn ?? closeDb,
    statFn: deps.statFn ?? fs.stat,
    nowFn: deps.nowFn ?? (() => new Date()),
  };

  const config = resolvedDeps.readConfigFn(process.env);
  const configuredPath = options.db?.trim() || config?.db?.path || DEFAULT_DB_PATH;
  const dbFilePath = resolveDbFilePath(configuredPath);
  const forgettingThreshold =
    typeof config?.forgetting?.scoreThreshold === "number" ? config.forgetting.scoreThreshold : 0.05;
  const forgettingMaxAgeDays =
    typeof config?.forgetting?.maxAgeDays === "number" ? config.forgetting.maxAgeDays : 60;
  const protectPatterns = Array.isArray(config?.forgetting?.protect) ? config.forgetting.protect : [];
  const now = resolvedDeps.nowFn();
  const db = resolvedDeps.getDbFn(configuredPath);

  try {
    const fileSizeBytes = await getFileSizeBytes(resolvedDeps.statFn, dbFilePath);
    const stats = await collectHealthStats(
      db,
      now,
      fileSizeBytes,
      forgettingThreshold,
      forgettingMaxAgeDays,
      protectPatterns,
    );
    process.stdout.write(renderHealthOutput(stats, now));
    return { exitCode: 0 };
  } finally {
    resolvedDeps.closeDbFn(db);
  }
}

