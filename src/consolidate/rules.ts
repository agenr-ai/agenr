import fs from "node:fs/promises";
import path from "node:path";
import type { Client, InValue } from "@libsql/client";
import { rebuildVectorIndex } from "../db/vector-index.js";
import { recency } from "../db/recall.js";
import { createRelation } from "../db/relations.js";
import { buildProjectFilter } from "../project.js";
import { parseDaysBetween, toNumber, toStringValue } from "../utils/entry-utils.js";
import { UnionFind, cosineSim, type ActiveEmbeddedEntry, validateCluster } from "./util.js";
import type { KnowledgePlatform } from "../types.js";
import type { StoredEntry } from "../types.js";

const EXPIRE_THRESHOLD = 0.05;
const MERGE_SIMILARITY_THRESHOLD = 0.95;
const MAX_ACTIVE_EMBEDDED_ENTRIES = 20_000;
const MERGE_NEIGHBOR_LIMIT = 50;
const MAX_CLUSTER_SIZE = 12;
const DIAMETER_FLOOR = MERGE_SIMILARITY_THRESHOLD - 0.02; // 0.93 for Tier 1

export interface ConsolidationStats {
  entriesBefore: number;
  entriesAfter: number;
  expiredCount: number;
  mergedCount: number;
  orphanedRelationsCleaned: number;
  backupPath: string;
}

export interface ConsolidateRulesOptions {
  dryRun?: boolean;
  verbose?: boolean;
  platform?: KnowledgePlatform;
  project?: string | null;
  excludeProject?: string[];
  onLog?: (message: string) => void;
  rebuildIndex?: boolean;
  skipBackup?: boolean;
  backupPath?: string;
  skipOrphanCleanup?: boolean;
}

function toProjectValue(value: InValue | undefined): string | null {
  const s = toStringValue(value).trim();
  return s ? s.toLowerCase() : null;
}

function mapBufferToVector(value: InValue | undefined): number[] {
  if (value instanceof ArrayBuffer) {
    return Array.from(new Float32Array(value));
  }

  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return Array.from(
      new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / Float32Array.BYTES_PER_ELEMENT)),
    );
  }

  return [];
}

function normalizeSubject(value: string): string {
  return value.trim().toLowerCase();
}

function collapsePreview(text: string, maxLength = 80): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength - 3)}...`;
}

export function forgettingScore(entry: StoredEntry, now: Date): number {
  const ageDays = parseDaysBetween(now, entry.created_at);
  const recallCount = entry.recall_count ?? 0;

  const halfLife = 90;
  const ageDecay = Math.pow(0.5, ageDays / halfLife);
  const recallBonus = Math.min(recallCount * 0.05, 0.3);

  const importanceFloor =
    entry.importance >= 8
      ? 0.4
      : entry.importance >= 6
        ? 0.15
        : 0;

  const raw = ageDecay + recallBonus;
  return Math.max(raw, importanceFloor);
}

/**
 * Matches subject against a protect pattern.
 * Only trailing wildcard is supported (e.g. "project-*" matches "project-agenr").
 * Mid-string and prefix globs (e.g. "*suffix", "foo*bar") are NOT supported.
 * Matching is case-insensitive.
 */
export function matchesPattern(subject: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    return subject.toLowerCase().startsWith(pattern.slice(0, -1).toLowerCase());
  }
  return subject.toLowerCase() === pattern.toLowerCase();
}

export function isProtected(entry: StoredEntry, protectPatterns: string[]): boolean {
  if (entry.importance >= 10) {
    return true;
  }
  return protectPatterns.some((pattern) => matchesPattern(entry.subject, pattern));
}

export async function countActiveEntries(
  db: Client,
  platform?: KnowledgePlatform,
  project?: string | null,
  excludeProject?: string[],
): Promise<number> {
  const args: unknown[] = [];
  if (platform) {
    args.push(platform);
  }
  const projectSql = buildProjectFilter({
    column: "project",
    project: project === undefined ? undefined : project === null ? null : [project],
    excludeProject,
    strict: project !== undefined && project !== null,
  });
  args.push(...projectSql.args);

  const result = await db.execute({
    sql: `
      SELECT COUNT(*) AS count
      FROM entries
      WHERE superseded_by IS NULL
        AND retired = 0
        ${platform ? "AND platform = ?" : ""}
        ${projectSql.clause}
    `,
    args,
  });
  const count = toNumber(result.rows[0]?.count);
  return Number.isFinite(count) ? count : 0;
}

async function countOrphanedRelations(db: Client): Promise<number> {
  const result = await db.execute({
    sql: `
      SELECT COUNT(*) AS count
      FROM relations
      WHERE relation_type <> 'supersedes'
        AND (
          source_id IN (SELECT id FROM entries WHERE superseded_by IS NOT NULL)
          OR target_id IN (SELECT id FROM entries WHERE superseded_by IS NOT NULL)
        )
    `,
    args: [],
  });
  const count = toNumber(result.rows[0]?.count);
  return Number.isFinite(count) ? count : 0;
}

async function expireDecayedEntries(
  db: Client,
  now: Date,
  options: {
    dryRun: boolean;
    verbose: boolean;
    platform?: KnowledgePlatform;
    project?: string | null;
    excludeProject?: string[];
    onLog: (message: string) => void;
  },
): Promise<number> {
  const args: unknown[] = [];
  if (options.platform) {
    args.push(options.platform);
  }
  const projectSql = buildProjectFilter({
    column: "project",
    project:
      options.project === undefined ? undefined : options.project === null ? null : [options.project],
    excludeProject: options.excludeProject,
    strict: options.project !== undefined && options.project !== null,
  });
  args.push(...projectSql.args);

  const result = await db.execute({
    sql: `
    SELECT id, content, expiry, created_at
    FROM entries
    WHERE superseded_by IS NULL
      AND retired = 0
      AND expiry = 'temporary'
      ${options.platform ? "AND platform = ?" : ""}
      ${projectSql.clause}
    `,
    args,
  });

  let expiredCount = 0;
  for (const row of result.rows) {
    const id = toStringValue(row.id);
    const content = toStringValue(row.content);
    const expiry = toStringValue(row.expiry);
    const createdAt = toStringValue(row.created_at);
    if (!id || !expiry) {
      continue;
    }

    const daysOld = parseDaysBetween(now, createdAt);
    const score = recency(daysOld, expiry);
    if (score >= EXPIRE_THRESHOLD) {
      continue;
    }

    expiredCount += 1;
    if (options.verbose) {
      options.onLog(`[expire] id=${id} tier=${expiry} score=${score.toFixed(4)} content="${collapsePreview(content)}"`);
    }

    if (!options.dryRun) {
      await db.execute({
        sql: "UPDATE entries SET superseded_by = 'EXPIRED' WHERE id = ?",
        args: [id],
      });
    }
  }

  return expiredCount;
}

function rankKeeper(a: ActiveEmbeddedEntry, b: ActiveEmbeddedEntry): number {
  const scoreA = a.confirmations + a.recallCount;
  const scoreB = b.confirmations + b.recallCount;
  if (scoreB !== scoreA) {
    return scoreB - scoreA;
  }

  const createdA = Date.parse(a.createdAt);
  const createdB = Date.parse(b.createdAt);
  const safeA = Number.isFinite(createdA) ? createdA : 0;
  const safeB = Number.isFinite(createdB) ? createdB : 0;
  return safeB - safeA;
}


async function mergeNearExactDuplicates(
  db: Client,
  options: {
    dryRun: boolean;
    verbose: boolean;
    platform?: KnowledgePlatform;
    project?: string | null;
    excludeProject?: string[];
    onLog: (message: string) => void;
  },
): Promise<number> {
  const countArgs: unknown[] = [];
  if (options.platform) {
    countArgs.push(options.platform);
  }
  const projectSql = buildProjectFilter({
    column: "project",
    project:
      options.project === undefined ? undefined : options.project === null ? null : [options.project],
    excludeProject: options.excludeProject,
    strict: options.project !== undefined && options.project !== null,
  });
  countArgs.push(...projectSql.args);

  const countResult = await db.execute({
    sql: `
    SELECT COUNT(*) AS count
    FROM entries
    WHERE superseded_by IS NULL
      AND retired = 0
      AND embedding IS NOT NULL
      ${options.platform ? "AND platform = ?" : ""}
      ${projectSql.clause}
    `,
    args: countArgs,
  });
  const activeEmbeddedCount = toNumber(countResult.rows[0]?.count);
  const activeEmbedded = Number.isFinite(activeEmbeddedCount) ? activeEmbeddedCount : 0;

  if (activeEmbedded > MAX_ACTIVE_EMBEDDED_ENTRIES) {
    options.onLog(
      `[merge] Skipped near-exact merge: ${activeEmbedded} active embedded entries exceeds ${MAX_ACTIVE_EMBEDDED_ENTRIES}.`,
    );
    return 0;
  }

  const args: unknown[] = [];
  if (options.platform) {
    args.push(options.platform);
  }
  args.push(...projectSql.args);

  const result = await db.execute({
    sql: `
    SELECT id, type, subject, content, project, importance, embedding, confirmations, recall_count, created_at
    FROM entries
    WHERE superseded_by IS NULL
      AND retired = 0
      AND embedding IS NOT NULL
      ${options.platform ? "AND platform = ?" : ""}
      ${projectSql.clause}
    `,
    args,
  });

  const entries: ActiveEmbeddedEntry[] = result.rows
    .map((row) => ({
      id: toStringValue(row.id),
      type: toStringValue(row.type),
      subject: toStringValue(row.subject),
      content: toStringValue(row.content),
      project: toProjectValue(row.project),
      importance: Number.isFinite(toNumber(row.importance)) ? toNumber(row.importance) : 5,
      embedding: mapBufferToVector(row.embedding),
      confirmations: Number.isFinite(toNumber(row.confirmations)) ? toNumber(row.confirmations) : 0,
      recallCount: Number.isFinite(toNumber(row.recall_count)) ? toNumber(row.recall_count) : 0,
      createdAt: toStringValue(row.created_at),
    }))
    .filter((entry) => entry.id.length > 0 && entry.embedding.length > 0);

  if (entries.length < 2) {
    return 0;
  }

  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const unionFind = new UnionFind();
  for (const entry of entries) {
    unionFind.add(entry.id);
  }

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    for (let j = i + 1; j < entries.length; j += 1) {
      const candidate = entries[j];

      const similarity = cosineSim(entry.embedding, candidate.embedding);
      if (similarity <= MERGE_SIMILARITY_THRESHOLD) {
        continue;
      }

      if (entry.type !== candidate.type) {
        continue;
      }
      if (normalizeSubject(entry.subject) !== normalizeSubject(candidate.subject)) {
        continue;
      }
      if ((entry.project ?? null) !== (candidate.project ?? null)) {
        continue;
      }

      unionFind.union(entry.id, candidate.id);
    }
  }

  const groups = new Map<string, ActiveEmbeddedEntry[]>();
  for (const entry of entries) {
    const root = unionFind.find(entry.id);
    const current = groups.get(root) ?? [];
    current.push(entry);
    groups.set(root, current);
  }

  let mergedCount = 0;

  for (const rawGroup of groups.values()) {
    if (rawGroup.length < 2) {
      continue;
    }

    // Validate cluster: enforce diameter floor + max size to prevent chaining
    const validatedGroup = validateCluster(rawGroup, MAX_CLUSTER_SIZE, DIAMETER_FLOOR);
    if (validatedGroup.length < 2) {
      continue;
    }

    const sorted = [...validatedGroup].sort(rankKeeper);
    const keeper = sorted[0];
    if (!keeper) {
      continue;
    }

    const sources = sorted.slice(1);
    mergedCount += sources.length;

    if (options.verbose) {
      options.onLog(
        `[merge] keeper=${keeper.id} sources=${sources.map((source) => source.id).join(",")} subject="${collapsePreview(keeper.subject, 40)}"`,
      );
    }

    if (options.dryRun) {
      continue;
    }

    const totalConfirmations = sorted.reduce((sum, entry) => sum + entry.confirmations, 0);
    const maxImportance = sorted.reduce((max, entry) => Math.max(max, entry.importance ?? 5), 0);
    const oldestCreatedAt = sorted.reduce((oldest, entry) => {
      const t = Date.parse(entry.createdAt);
      const o = Date.parse(oldest);
      return Number.isFinite(t) && t < (Number.isFinite(o) ? o : Infinity) ? entry.createdAt : oldest;
    }, keeper.createdAt);
    for (const source of sources) {
      await db.execute({
        sql: `
          INSERT INTO entry_sources (
            merged_entry_id,
            source_entry_id,
            original_confirmations,
            original_recall_count,
            original_created_at
          )
          VALUES (?, ?, ?, ?, ?)
        `,
        args: [keeper.id, source.id, source.confirmations, source.recallCount, source.createdAt],
      });

      await db.execute({
        sql: "UPDATE entries SET superseded_by = ? WHERE id = ?",
        args: [keeper.id, source.id],
      });

      await createRelation(db, keeper.id, source.id, "supersedes");

      await db.execute({
        sql: `
          INSERT OR IGNORE INTO tags (entry_id, tag)
          SELECT ?, tag
          FROM tags
          WHERE entry_id = ?
        `,
        args: [keeper.id, source.id],
      });
    }

    await db.execute({
      sql: `
        UPDATE entries
        SET merged_from = ?,
            consolidated_at = datetime('now'),
            confirmations = ?,
            importance = CASE WHEN importance < ? THEN ? ELSE importance END,
            created_at = CASE WHEN created_at > ? THEN ? ELSE created_at END
        WHERE id = ?
      `,
      args: [sources.length, totalConfirmations, maxImportance, maxImportance, oldestCreatedAt, oldestCreatedAt, keeper.id],
    });
  }

  return mergedCount;
}

async function cleanOrphanedRelations(db: Client, dryRun: boolean): Promise<number> {
  const orphanedCount = await countOrphanedRelations(db);
  if (dryRun || orphanedCount === 0) {
    return orphanedCount;
  }

  await db.execute({
    sql: `
      DELETE FROM relations
      WHERE relation_type <> 'supersedes'
        AND (
          source_id IN (SELECT id FROM entries WHERE superseded_by IS NOT NULL)
          OR target_id IN (SELECT id FROM entries WHERE superseded_by IS NOT NULL)
        )
    `,
    args: [],
  });

  return orphanedCount;
}

/**
 * Insert a sentinel entry with id=EXPIRED so that entries can set
 * superseded_by=EXPIRED without violating the foreign key constraint.
 * This entry supersedes itself and is always filtered from recall.
 */
async function ensureExpiredSentinel(db: Client): Promise<void> {
  await db.execute({
    sql: `
      INSERT OR IGNORE INTO entries (
        id,
        type,
        subject,
        content,
        importance,
        expiry,
        source_file,
        source_context,
        created_at,
        updated_at,
        superseded_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      "EXPIRED",
      "fact",
      "System",
      "System sentinel for expired entries",
      1,
      "core",
      "agenr",
      "consolidate-rules",
      new Date().toISOString(),
      new Date().toISOString(),
      "EXPIRED",
    ],
  });
}

export async function consolidateRules(
  db: Client,
  dbPath: string,
  options: ConsolidateRulesOptions = {},
): Promise<ConsolidationStats> {
  const dryRun = options.dryRun === true;
  const verbose = options.verbose === true;
  const rebuildIndex = options.rebuildIndex !== false;
  const onLog = options.onLog ?? (() => undefined);
  const platform = options.platform;
  const project = options.project;
  const excludeProject = options.excludeProject;
  const skipBackup = options.skipBackup === true;
  const skipOrphanCleanup = options.skipOrphanCleanup === true;

  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  const backupPath = skipBackup ? (options.backupPath ?? "") : `${dbPath}.pre-consolidate-${timestamp}`;

  if (!skipBackup) {
    if (dryRun) {
      if (verbose) {
        onLog(`[backup] (dry-run) would checkpoint WAL and copy ${dbPath} -> ${backupPath}`);
      }
    } else {
      // Checkpoint WAL into main DB before backup so the copy is self-contained.
      // Use TRUNCATE mode to reset the WAL file after checkpoint.
      try {
        await db.execute("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch (error) {
        throw new Error(
          `Cannot create safe backup: WAL checkpoint failed (${error instanceof Error ? error.message : String(error)}). ` +
            "Close other agenr processes (watch, MCP) and retry.",
        );
      }

      await fs.copyFile(dbPath, backupPath);
      if (verbose) {
        onLog(`[backup] ${backupPath}`);
      }
    }
  }

  const entriesBefore = await countActiveEntries(db, platform, project, excludeProject);
  const now = new Date();

  let expiredCount = 0;
  let mergedCount = 0;
  let orphanedRelationsCleaned = 0;

  if (dryRun) {
    expiredCount = await expireDecayedEntries(db, now, { dryRun, verbose, onLog, platform, project, excludeProject });
    mergedCount = await mergeNearExactDuplicates(db, { dryRun, verbose, onLog, platform, project, excludeProject });
    orphanedRelationsCleaned = skipOrphanCleanup ? 0 : await cleanOrphanedRelations(db, true);
  } else {
    await db.execute("BEGIN");
    try {
      await ensureExpiredSentinel(db);
      expiredCount = await expireDecayedEntries(db, now, { dryRun, verbose, onLog, platform, project, excludeProject });
      mergedCount = await mergeNearExactDuplicates(db, { dryRun, verbose, onLog, platform, project, excludeProject });
      orphanedRelationsCleaned = skipOrphanCleanup ? 0 : await cleanOrphanedRelations(db, false);
      await db.execute("COMMIT");
    } catch (error) {
      try {
        await db.execute("ROLLBACK");
      } catch {
        // Ignore rollback failures and rethrow the root error.
      }
      throw error;
    }
  }

  if (!dryRun && rebuildIndex) {
    // Rebuild vector index to prevent corruption from bulk mutations.
    try {
      await rebuildVectorIndex(db, { onLog });
    } catch (error) {
      if (verbose) {
        onLog(
          `[consolidate] Vector index rebuild failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  if (!skipBackup && !dryRun) {
    // Clean up old backups, keeping only the 3 most recent.
    const backupDir = path.dirname(dbPath);
    const backupBase = path.basename(dbPath);
    const backupPrefix = `${backupBase}.pre-consolidate-`;
    try {
      const files = await fs.readdir(backupDir);
      const backups = files
        .filter((fileName) => fileName.startsWith(backupPrefix))
        .sort()
        .reverse();
      for (const oldBackup of backups.slice(3)) {
        await fs.unlink(path.join(backupDir, oldBackup));
        if (verbose) {
          onLog(`[backup] removed old backup: ${oldBackup}`);
        }
      }
    } catch {
      // Best-effort cleanup; ignore errors.
    }
  }

  const entriesAfter = await countActiveEntries(db, platform, project, excludeProject);

  return {
    entriesBefore,
    entriesAfter,
    expiredCount,
    mergedCount,
    orphanedRelationsCleaned,
    backupPath,
  };
}

export { UnionFind, cosineSim, validateCluster };
export type { ActiveEmbeddedEntry };
