import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { InValue } from "@libsql/client";
import * as clack from "@clack/prompts";
import { readConfig } from "../config.js";
import { forgettingScore, isProtected } from "../consolidate/rules.js";
import { runConsolidationOrchestrator, type ConsolidationOrchestratorReport } from "../consolidate/orchestrate.js";
import { showFlaggedMerges } from "../consolidate/verify.js";
import { closeDb, DEFAULT_DB_PATH, getDb, walCheckpoint } from "../db/client.js";
import { acquireDbLock, releaseDbLock } from "../db/lockfile.js";
import { initSchema } from "../db/schema.js";
import { mapRawStoredEntry } from "../db/stored-entry.js";
import { resolveEmbeddingApiKey } from "../embeddings/client.js";
import { createLlmClient } from "../llm/client.js";
import { formatWarn } from "../ui.js";
import { installSignalHandlers, isShutdownRequested, onShutdown } from "../shutdown.js";
import { normalizeKnowledgePlatform } from "../platform.js";
import { buildProjectFilter, hasAnyProjectParts, parseProjectList } from "../project.js";
import { parseDaysBetween, toNumber, toStringValue } from "../utils/entry-utils.js";
import { KNOWLEDGE_PLATFORMS } from "../types.js";
import type { KnowledgePlatform, StoredEntry } from "../types.js";

export interface ConsolidateCommandOptions {
  rulesOnly?: boolean;
  dryRun?: boolean;
  forget?: boolean;
  report?: boolean;
  verbose?: boolean;
  json?: boolean;
  db?: string;
  platform?: string;
  project?: string | string[];
  excludeProject?: string | string[];
  minCluster?: number;
  simThreshold?: number;
  maxClusterSize?: number;
  type?: string;
  showFlagged?: boolean;
  idempotencyDays?: number;
  batch?: number;
  resume?: boolean;
}

export interface ConsolidateCommandDeps {
  readConfigFn: typeof readConfig;
  getDbFn: typeof getDb;
  closeDbFn: typeof closeDb;
  initSchemaFn: typeof initSchema;
  createLlmClientFn: typeof createLlmClient;
  resolveEmbeddingApiKeyFn: typeof resolveEmbeddingApiKey;
  showFlaggedMergesFn: typeof showFlaggedMerges;
  runConsolidationOrchestratorFn: typeof runConsolidationOrchestrator;
}

interface ConsolidateLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

interface TodoAgeBuckets {
  d0To7: number;
  d7To30: number;
  d30To90: number;
  d90Plus: number;
}

interface ConsolidatePreRunStats {
  todoAges: TodoAgeBuckets;
  neverRecalled: number;
  contradictionBySubject: Array<{ subject: string; count: number }>;
  estimatedLlmTokens: number;
  estimatedLlmCostUsd: number;
}

interface ForgettingCandidate {
  entry: StoredEntry;
  score: number;
  ageDays: number;
  protected: boolean;
}

interface ForgettingAssessment {
  trigger: ForgettingTriggerMetrics;
  candidateCount: number;
  protectedCount: number;
  estimatedFreedBytes: number;
  threshold: number;
  shouldRun: boolean;
  candidates: ForgettingCandidate[];
}

export interface ForgettingTriggerMetrics {
  dbFileSizeBytes: number | null;
  activeEntryCount: number;
  lowScoreOldEntryCount: number;
}

const MB = 1024 * 1024;
const FORGETTING_FILE_SIZE_TRIGGER_BYTES = 200 * MB;
const FORGETTING_ACTIVE_ENTRY_TRIGGER = 10_000;
const FORGETTING_LOW_SCORE_TRIGGER_COUNT = 50;
const ESTIMATED_TOKENS_PER_CLUSTER = 3500;
const ESTIMATED_USD_PER_1M_TOKENS = 10;

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

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function formatApproxMb(bytes: number): string {
  const mb = Math.max(0, bytes) / MB;
  if (mb < 1) {
    return "<1MB";
  }
  return `${Math.round(mb)}MB`;
}

function estimateFreedBytes(candidateCount: number, activeCount: number, fileSizeBytes: number | null): number {
  if (!fileSizeBytes || fileSizeBytes <= 0 || activeCount <= 0 || candidateCount <= 0) {
    return 0;
  }
  return Math.round(fileSizeBytes * (candidateCount / activeCount));
}

function mapRowToStoredEntry(row: Record<string, unknown>): StoredEntry {
  return mapRawStoredEntry(row, { tags: [] });
}

function renderPreRunReport(stats: ConsolidatePreRunStats): string {
  const lines: string[] = [
    "Consolidation Report (pre-run)",
    `- Todos by age: 0-7d=${formatNumber(stats.todoAges.d0To7)}, 7-30d=${formatNumber(stats.todoAges.d7To30)}, 30-90d=${formatNumber(stats.todoAges.d30To90)}, 90d+=${formatNumber(stats.todoAges.d90Plus)}`,
    `- Entries never recalled: ${formatNumber(stats.neverRecalled)}`,
    "- Contradictions by subject:",
  ];

  if (stats.contradictionBySubject.length === 0) {
    lines.push("  (none)");
  } else {
    for (const row of stats.contradictionBySubject.slice(0, 10)) {
      lines.push(`  ${row.subject}: ${formatNumber(row.count)}`);
    }
  }

  lines.push(
    `- Estimated LLM cost (full run): ~${formatNumber(stats.estimatedLlmTokens)} tokens x $${ESTIMATED_USD_PER_1M_TOKENS.toFixed(2)}/1M ~= $${stats.estimatedLlmCostUsd.toFixed(2)}`,
  );
  return lines.join("\n");
}

function buildScopedFilter(
  platform: KnowledgePlatform | null,
  project?: string[],
  excludeProject?: string[],
): { clause: string; args: InValue[] } {
  const projectSql = buildProjectFilter({ column: "project", project, excludeProject });
  const args: InValue[] = [];
  if (platform) {
    args.push(platform);
  }
  args.push(...projectSql.args);
  const clause = `${platform ? "AND platform = ?" : ""} ${projectSql.clause}`.trim();
  return { clause: clause ? ` ${clause}` : "", args };
}

async function getDbFileSizeBytes(dbFilePath: string): Promise<number | null> {
  if (dbFilePath === ":memory:") {
    return null;
  }
  try {
    const stat = await fs.stat(dbFilePath);
    return stat.size;
  } catch {
    return null;
  }
}

export function shouldAutoTriggerForgetting(metrics: ForgettingTriggerMetrics): boolean {
  return (
    (metrics.dbFileSizeBytes ?? 0) > FORGETTING_FILE_SIZE_TRIGGER_BYTES ||
    metrics.activeEntryCount > FORGETTING_ACTIVE_ENTRY_TRIGGER ||
    metrics.lowScoreOldEntryCount > FORGETTING_LOW_SCORE_TRIGGER_COUNT
  );
}

async function collectPreRunStats(
  db: ReturnType<typeof getDb>,
  platform: KnowledgePlatform | null,
  project?: string[],
  excludeProject?: string[],
  activeEntryCount?: number,
): Promise<ConsolidatePreRunStats> {
  const scoped = buildScopedFilter(platform, project, excludeProject);
  const now = new Date();

  const todosResult = await db.execute({
    sql: `
      SELECT created_at
      FROM entries
      WHERE superseded_by IS NULL
        AND (retired IS NULL OR retired = 0)
        AND type = 'todo'
        ${scoped.clause}
    `,
    args: scoped.args,
  });

  const todoAges: TodoAgeBuckets = {
    d0To7: 0,
    d7To30: 0,
    d30To90: 0,
    d90Plus: 0,
  };
  for (const row of todosResult.rows) {
    const age = parseDaysBetween(now, toStringValue(row.created_at));
    if (age <= 7) {
      todoAges.d0To7 += 1;
    } else if (age <= 30) {
      todoAges.d7To30 += 1;
    } else if (age <= 90) {
      todoAges.d30To90 += 1;
    } else {
      todoAges.d90Plus += 1;
    }
  }

  const neverRecalledResult = await db.execute({
    sql: `
      SELECT COUNT(*) AS count
      FROM entries
      WHERE superseded_by IS NULL
        AND (retired IS NULL OR retired = 0)
        AND COALESCE(recall_count, 0) = 0
        ${scoped.clause}
    `,
    args: scoped.args,
  });
  const neverRecalled = Number.isFinite(toNumber(neverRecalledResult.rows[0]?.count))
    ? toNumber(neverRecalledResult.rows[0]?.count)
    : 0;

  const contradictionsResult = await db.execute({
    sql: `
      SELECT subject, COUNT(*) AS count
      FROM entries
      WHERE superseded_by IS NULL
        AND (retired IS NULL OR retired = 0)
        AND contradictions > 0
        ${scoped.clause}
      GROUP BY subject
      ORDER BY count DESC, subject ASC
      LIMIT 20
    `,
    args: scoped.args,
  });

  const contradictionBySubject = contradictionsResult.rows
    .map((row) => ({
      subject: toStringValue(row.subject),
      count: Number.isFinite(toNumber(row.count)) ? toNumber(row.count) : 0,
    }))
    .filter((row) => row.subject.length > 0 && row.count > 0);

  let activeCount = activeEntryCount ?? 0;
  if (activeEntryCount === undefined) {
    const activeResult = await db.execute({
      sql: `
      SELECT COUNT(*) AS count
      FROM entries
      WHERE superseded_by IS NULL
        AND (retired IS NULL OR retired = 0)
        ${scoped.clause}
    `,
      args: scoped.args,
    });
    activeCount = Number.isFinite(toNumber(activeResult.rows[0]?.count))
      ? toNumber(activeResult.rows[0]?.count)
      : 0;
  }

  const estimatedClusters = Math.ceil(activeCount / 6);
  const estimatedLlmTokens = estimatedClusters * ESTIMATED_TOKENS_PER_CLUSTER;
  const estimatedLlmCostUsd = (estimatedLlmTokens / 1_000_000) * ESTIMATED_USD_PER_1M_TOKENS;

  return {
    todoAges,
    neverRecalled,
    contradictionBySubject,
    estimatedLlmTokens,
    estimatedLlmCostUsd,
  };
}

async function collectForgettingCandidates(
  db: ReturnType<typeof getDb>,
  now: Date,
  threshold: number,
  maxAgeDays: number,
  protectPatterns: string[],
  platform: KnowledgePlatform | null,
  project?: string[],
  excludeProject?: string[],
): Promise<ForgettingCandidate[]> {
  const scoped = buildScopedFilter(platform, project, excludeProject);
  const cutoffDate = new Date(now.getTime() - maxAgeDays * 86_400_000).toISOString();
  const args: InValue[] = [cutoffDate, ...scoped.args];
  const result = await db.execute({
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
        quality_score,
        superseded_by
      FROM entries
      WHERE superseded_by IS NULL
        AND (retired IS NULL OR retired = 0)
        AND created_at <= ?
        ${scoped.clause}
    `,
    args,
  });

  const candidates: ForgettingCandidate[] = [];
  for (const row of result.rows) {
    const entry = mapRowToStoredEntry(row as Record<string, unknown>);
    const ageDays = parseDaysBetween(now, entry.created_at);
    if (ageDays <= maxAgeDays) {
      continue;
    }

    const score = forgettingScore(entry, now);
    if (score >= threshold) {
      continue;
    }

    const protectedEntry = isProtected(entry, protectPatterns);
    candidates.push({
      entry,
      score,
      ageDays,
      protected: protectedEntry,
    });
  }

  candidates.sort((a, b) => a.score - b.score || b.ageDays - a.ageDays);
  return candidates;
}

function renderTextReport(stats: ConsolidationOrchestratorReport, dryRun: boolean): string {
  const header = dryRun
    ? "+--  AGENR -- Knowledge Consolidation (dry run -- no changes made)"
    : "+--  AGENR -- Knowledge Consolidation";

  const lines = [
    header,
    "|",
    `|  Backup: ${stats.backupPath}`,
    "|",
    "|  Phase 0: Rule-Based Cleanup",
    `|  +- Expired entries pruned: ${formatNumber(stats.expiredCount)}`,
    `|  +- Near-exact duplicates merged: ${formatNumber(stats.mergedCount)}`,
    `|  +- Orphaned relations cleaned: ${formatNumber(stats.orphanedRelationsCleaned)}`,
    "|",
    "|  Phase 1: Type-Scoped Consolidation",
    `|  +- Clusters processed: ${formatNumber(stats.phase1.totals.clustersProcessed)} / ${formatNumber(stats.phase1.totals.clustersFound)}`,
    `|  +- Clusters merged: ${formatNumber(stats.phase1.totals.clustersMerged)}`,
    `|  +- Flagged for review: ${formatNumber(stats.phase1.totals.mergesFlagged)}`,
    `|  +- LLM calls: ${formatNumber(stats.phase1.totals.llmCalls)}`,
    `|  +- LLM dedup checks: ${formatNumber(stats.phase1.totals.llmDedupCalls)} (${formatNumber(stats.phase1.totals.llmDedupMatches)} matched)`,
  ];

  for (const typeStats of stats.phase1.types) {
    lines.push(
      `|     * ${typeStats.type}: ${formatNumber(typeStats.clustersProcessed)}/${formatNumber(typeStats.clustersFound)} clusters processed`,
    );
  }

  if (stats.phase2) {
    lines.push(
      "|",
      "|  Phase 2: Cross-Subject Catch-All",
      `|  +- Clusters processed: ${formatNumber(stats.phase2.clustersProcessed)} / ${formatNumber(stats.phase2.clustersFound)}`,
      `|  +- Clusters merged: ${formatNumber(stats.phase2.clustersMerged)}`,
      `|  +- Flagged for review: ${formatNumber(stats.phase2.mergesFlagged)}`,
      `|  +- LLM calls: ${formatNumber(stats.phase2.llmCalls)}`,
      `|  +- LLM dedup checks: ${formatNumber(stats.phase2.llmDedupCalls)} (${formatNumber(stats.phase2.llmDedupMatches)} matched)`,
    );
  }

  if (stats.phase3) {
    lines.push(
      "|",
      "|  Phase 3: Post-Merge Dedup",
      `|  +- Clusters processed: ${formatNumber(stats.phase3.clustersProcessed)} / ${formatNumber(stats.phase3.clustersFound)}`,
      `|  +- Clusters merged: ${formatNumber(stats.phase3.clustersMerged)}`,
      `|  +- LLM calls: ${formatNumber(stats.phase3.llmCalls)}`,
      `|  +- LLM dedup checks: ${formatNumber(stats.phase3.llmDedupCalls)} (${formatNumber(stats.phase3.llmDedupMatches)} matched)`,
    );
  }

  lines.push(
    "|",
    "|  Summary",
    `|  +- Before: ${formatNumber(stats.entriesBefore)} active entries`,
    `|  +- After rules: ${formatNumber(stats.entriesAfterRules)} active entries`,
    `|  +- Final: ${formatNumber(stats.entriesAfter)} active entries`,
    `|  +- Clusters estimated: ${formatNumber(stats.estimate.totalClusters)}`,
    `|  +- Clusters processed this run: ${formatNumber(stats.progress.processedClusters)}`,
    stats.progress.partial
      ? `|  +- Status: partial (remaining ${formatNumber(stats.progress.remainingClusters)} clusters)`
      : "|  +- Status: completed",
    `|  +- LLM dedup checks (total): ${formatNumber(stats.summary.totalLlmDedupCalls)} (${formatNumber(stats.summary.totalLlmDedupMatches)} matched)`,
    `|  +- Consolidated ${formatNumber(stats.entriesBefore)} -> ${formatNumber(stats.entriesAfter)} entries (${formatNumber(stats.summary.totalCanonicalEntriesCreated)} canonical entries created, ${formatNumber(stats.expiredCount)} expirations)`,
    "|",
    "+--  Done",
  );

  return lines.join("\n");
}

function createLogger(jsonMode: boolean): ConsolidateLogger {
  const useClack = process.stderr.isTTY && !jsonMode;
  if (!useClack) {
    return {
      info: (message: string) => process.stderr.write(`${message}\n`),
      warn: (message: string) => process.stderr.write(`${message}\n`),
    };
  }

  const clackOutput = { output: process.stderr };
  return {
    info: (message: string) => clack.log.info(message, clackOutput),
    warn: (message: string) => clack.log.warn(message, clackOutput),
  };
}

async function assessForgetting(
  db: ReturnType<typeof getDb>,
  dbFilePath: string,
  now: Date,
  threshold: number,
  maxAgeDays: number,
  protectPatterns: string[],
  platform: KnowledgePlatform | null,
  project?: string[],
  excludeProject?: string[],
): Promise<ForgettingAssessment> {
  const scoped = buildScopedFilter(platform, project, excludeProject);
    const activeResult = await db.execute({
      sql: `
        SELECT COUNT(*) AS count
        FROM entries
        WHERE superseded_by IS NULL
        AND (retired IS NULL OR retired = 0)
        ${scoped.clause}
      `,
      args: scoped.args,
    });

  const activeEntryCount = Number.isFinite(toNumber(activeResult.rows[0]?.count))
    ? toNumber(activeResult.rows[0]?.count)
    : 0;
  const dbFileSizeBytes = await getDbFileSizeBytes(dbFilePath);
  const candidates = await collectForgettingCandidates(
    db,
    now,
    threshold,
    maxAgeDays,
    protectPatterns,
    platform,
    project,
    excludeProject,
  );
  const protectedCount = candidates.filter((item) => item.protected).length;
  const lowScoreOldEntryCount = candidates.length;
  const trigger: ForgettingTriggerMetrics = {
    dbFileSizeBytes,
    activeEntryCount,
    lowScoreOldEntryCount,
  };
  const candidateCount = candidates.filter((item) => !item.protected).length;
  return {
    trigger,
    candidateCount,
    protectedCount,
    estimatedFreedBytes: estimateFreedBytes(candidateCount, activeEntryCount, dbFileSizeBytes),
    threshold,
    shouldRun: shouldAutoTriggerForgetting(trigger),
    candidates,
  };
}

const DELETE_BATCH_SIZE = 900;
const INCREMENTAL_VACUUM_STEPS = 200;
const MAX_INCREMENTAL_VACUUM_LOOPS = 20;

async function runIncrementalVacuumIfEnabled(db: ReturnType<typeof getDb>, logger?: ConsolidateLogger): Promise<void> {
  const autoVacuumResult = await db.execute("PRAGMA auto_vacuum");
  const autoVacuumMode = Number.isFinite(toNumber(autoVacuumResult.rows[0]?.auto_vacuum))
    ? toNumber(autoVacuumResult.rows[0]?.auto_vacuum)
    : toNumber(Object.values(autoVacuumResult.rows[0] ?? {})[0]);

  // SQLite: 0=NONE, 1=FULL, 2=INCREMENTAL.
  if (autoVacuumMode !== 2) {
    logger?.info("Auto-vacuum is not incremental; skipping VACUUM in this command. Run maintenance vacuum separately.");
    return;
  }

  for (let loop = 0; loop < MAX_INCREMENTAL_VACUUM_LOOPS; loop += 1) {
    const freelistResult = await db.execute("PRAGMA freelist_count");
    const freePages = Number.isFinite(toNumber(freelistResult.rows[0]?.freelist_count))
      ? toNumber(freelistResult.rows[0]?.freelist_count)
      : toNumber(Object.values(freelistResult.rows[0] ?? {})[0]);
    if (freePages <= 0) {
      break;
    }
    const pages = Math.min(INCREMENTAL_VACUUM_STEPS, freePages);
    await db.execute(`PRAGMA incremental_vacuum(${pages})`);
  }
}

async function runForgettingDeletion(
  db: ReturnType<typeof getDb>,
  dbFilePath: string,
  candidates: ForgettingCandidate[],
  logger?: ConsolidateLogger,
): Promise<void> {
  const deletable = candidates.filter((item) => !item.protected);
  if (deletable.length === 0) {
    process.stdout.write("Retired 0 entries (score below threshold), freed ~0MB\n");
    return;
  }
  const retirementReason = "forgetting score below threshold";

  const beforeBytes = await getDbFileSizeBytes(dbFilePath);
  await db.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  await db.execute("BEGIN");
  try {
    for (let i = 0; i < deletable.length; i += DELETE_BATCH_SIZE) {
      const chunk = deletable.slice(i, i + DELETE_BATCH_SIZE);
      for (const candidate of chunk) {
        process.stdout.write(`[forget] [${candidate.entry.type}] ${candidate.entry.subject}\n`);
      }
      const placeholders = chunk.map(() => "?").join(", ");
      const now = new Date().toISOString();
      await db.execute({
        sql: `
          UPDATE entries
          SET retired = 1,
              retired_at = ?,
              retired_reason = ?
          WHERE id IN (${placeholders})
        `,
        args: [now, retirementReason, ...chunk.map((candidate) => candidate.entry.id)],
      });
    }
    await db.execute("COMMIT");
  } catch (error) {
    try {
      await db.execute("ROLLBACK");
    } catch {
      // Ignore rollback failures and rethrow the root error.
    }
    throw error;
  }

  await runIncrementalVacuumIfEnabled(db, logger);
  const afterBytes = await getDbFileSizeBytes(dbFilePath);
  const freedBytes =
    typeof beforeBytes === "number" && typeof afterBytes === "number"
      ? Math.max(0, beforeBytes - afterBytes)
      : 0;
  process.stdout.write(
    `Retired ${formatNumber(deletable.length)} entries (score below threshold), freed ~${formatApproxMb(freedBytes)}\n`,
  );
}

export async function runConsolidateCommand(
  options: ConsolidateCommandOptions,
  deps: Partial<ConsolidateCommandDeps> = {},
): Promise<{ exitCode: number }> {
  installSignalHandlers();

  const resolvedDeps: ConsolidateCommandDeps = {
    readConfigFn: deps.readConfigFn ?? readConfig,
    getDbFn: deps.getDbFn ?? getDb,
    closeDbFn: deps.closeDbFn ?? closeDb,
    initSchemaFn: deps.initSchemaFn ?? initSchema,
    createLlmClientFn: deps.createLlmClientFn ?? createLlmClient,
    resolveEmbeddingApiKeyFn: deps.resolveEmbeddingApiKeyFn ?? resolveEmbeddingApiKey,
    showFlaggedMergesFn: deps.showFlaggedMergesFn ?? showFlaggedMerges,
    runConsolidationOrchestratorFn: deps.runConsolidationOrchestratorFn ?? runConsolidationOrchestrator,
  };

  if (options.showFlagged) {
    await resolvedDeps.showFlaggedMergesFn();
    return { exitCode: 0 };
  }

  const logger = createLogger(options.json === true);
  const config = resolvedDeps.readConfigFn(process.env);
  const forgettingConfig = config?.forgetting ?? {
    protect: [],
    scoreThreshold: 0.05,
    maxAgeDays: 60,
    enabled: true,
  };
  const configuredPath = options.db?.trim() || config?.db?.path || DEFAULT_DB_PATH;
  const dbFilePath = resolveDbFilePath(configuredPath);
  const platformRaw = options.platform?.trim();
  const platform = platformRaw ? normalizeKnowledgePlatform(platformRaw) : null;
  if (platformRaw && !platform) {
    throw new Error(`--platform must be one of: ${KNOWLEDGE_PLATFORMS.join(", ")}`);
  }

  const parsedProject = parseProjectList(options.project);
  const parsedExcludeProject = parseProjectList(options.excludeProject);

  if (hasAnyProjectParts(options.project) && parsedProject.length === 0) {
    throw new Error("--project must be a non-empty string (or comma-separated list).");
  }
  if (hasAnyProjectParts(options.excludeProject) && parsedExcludeProject.length === 0) {
    throw new Error("--exclude-project must be a non-empty string (or comma-separated list).");
  }

  const project = parsedProject.length > 0 ? parsedProject : undefined;
  const excludeProject = parsedExcludeProject.length > 0 ? parsedExcludeProject : undefined;

  // Consolidation operates on a single resolved project set; combining include + exclude is ambiguous.
  if (project && excludeProject) {
    throw new Error("Use either --project or --exclude-project, not both.");
  }

  if (dbFilePath === ":memory:") {
    throw new Error("Consolidation requires a file-backed database so a backup can be created.");
  }

  acquireDbLock();
  onShutdown(async () => {
    releaseDbLock();
  });

  const db = resolvedDeps.getDbFn(configuredPath);

  try {
    await resolvedDeps.initSchemaFn(db);

    const scoped = buildScopedFilter(platform, project, excludeProject);
    const activeBeforeResult = await db.execute({
      sql: `
        SELECT COUNT(*) AS count
        FROM entries
        WHERE superseded_by IS NULL
          AND (retired IS NULL OR retired = 0)
          ${scoped.clause}
      `,
      args: scoped.args,
    });
    const activeBefore = Number.isFinite(toNumber(activeBeforeResult.rows[0]?.count))
      ? toNumber(activeBeforeResult.rows[0]?.count)
      : 0;

    if (options.report) {
      const preRun = await collectPreRunStats(db, platform, project, excludeProject, activeBefore);
      logger.info(renderPreRunReport(preRun));

      if (options.dryRun) {
        return { exitCode: isShutdownRequested() ? 130 : 0 };
      }
    }

    const llmClient = options.rulesOnly ? undefined : resolvedDeps.createLlmClientFn({ env: process.env });
    const embeddingApiKey = options.rulesOnly ? undefined : resolvedDeps.resolveEmbeddingApiKeyFn(config, process.env);

    const report = await resolvedDeps.runConsolidationOrchestratorFn(
      db,
      dbFilePath,
      llmClient,
      embeddingApiKey,
      {
        rulesOnly: options.rulesOnly,
        dryRun: options.dryRun,
        verbose: options.verbose,
        platform: platform ?? undefined,
        project,
        excludeProject,
        minCluster: options.minCluster,
        simThreshold: options.simThreshold,
        maxClusterSize: options.maxClusterSize,
        type: options.type,
        idempotencyDays: options.idempotencyDays,
        batch: options.batch,
        resume: options.resume,
        onLog: (message) => logger.info(message),
        onWarn: (message) => logger.warn(formatWarn(message)),
      },
    );

    const now = new Date();
    const scoreThreshold =
      typeof forgettingConfig.scoreThreshold === "number" ? forgettingConfig.scoreThreshold : 0.05;
    const maxAgeDays = typeof forgettingConfig.maxAgeDays === "number" ? forgettingConfig.maxAgeDays : 60;
    const protectPatterns = Array.isArray(forgettingConfig.protect) ? forgettingConfig.protect : [];
    const forgettingEnabled = forgettingConfig.enabled !== false;

    const forgettingAssessment = await assessForgetting(
      db,
      dbFilePath,
      now,
      scoreThreshold,
      maxAgeDays,
      protectPatterns,
      platform,
      project,
      excludeProject,
    );

    const runForgetting = options.forget === true || (forgettingEnabled && forgettingAssessment.shouldRun);
    if (runForgetting) {
      const candidates = forgettingAssessment.candidates;
      if (options.forget === true && options.dryRun !== true) {
        await runForgettingDeletion(db, dbFilePath, candidates, logger);
      } else {
        logger.info(
          `Forgetting candidates: ${formatNumber(candidates.filter((candidate) => !candidate.protected).length)} entries (score < ${scoreThreshold})`,
        );
        logger.info(`Would free ~${formatApproxMb(forgettingAssessment.estimatedFreedBytes)}`);
        if (options.forget === true && options.dryRun === true) {
          logger.info("Run without --dry-run to delete");
        } else {
          logger.info("Run with --forget to delete");
        }
      }
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return { exitCode: isShutdownRequested() ? 130 : 0 };
    }

    logger.info(renderTextReport(report, options.dryRun === true));
    return { exitCode: isShutdownRequested() ? 130 : 0 };
  } finally {
    if (!options.dryRun) {
      try {
        await walCheckpoint(db);
      } catch (error) {
        logger.warn(`[consolidate] WAL checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    releaseDbLock();
    resolvedDeps.closeDbFn(db);
  }
}
