import os from "node:os";
import path from "node:path";
import * as clack from "@clack/prompts";
import { readConfig } from "../config.js";
import { runConsolidationOrchestrator, type ConsolidationOrchestratorReport } from "../consolidate/orchestrate.js";
import { showFlaggedMerges } from "../consolidate/verify.js";
import { closeDb, DEFAULT_DB_PATH, getDb, walCheckpoint } from "../db/client.js";
import { initSchema } from "../db/schema.js";
import { resolveEmbeddingApiKey } from "../embeddings/client.js";
import { createLlmClient } from "../llm/client.js";
import { formatWarn } from "../ui.js";
import { installSignalHandlers, isShutdownRequested } from "../shutdown.js";

export interface ConsolidateCommandOptions {
  rulesOnly?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  json?: boolean;
  db?: string;
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
  const configuredPath = options.db?.trim() || config?.db?.path || DEFAULT_DB_PATH;
  const dbFilePath = resolveDbFilePath(configuredPath);

  if (dbFilePath === ":memory:") {
    throw new Error("Consolidation requires a file-backed database so a backup can be created.");
  }

  const db = resolvedDeps.getDbFn(configuredPath);

  try {
    await resolvedDeps.initSchemaFn(db);

    const llmClient = options.rulesOnly ? undefined : resolvedDeps.createLlmClientFn({ env: process.env });
    const embeddingApiKey = options.rulesOnly ? undefined : resolvedDeps.resolveEmbeddingApiKeyFn(config, process.env);

    const report = await resolvedDeps.runConsolidationOrchestratorFn(db, dbFilePath, llmClient, embeddingApiKey, {
      rulesOnly: options.rulesOnly,
      dryRun: options.dryRun,
      verbose: options.verbose,
      minCluster: options.minCluster,
      simThreshold: options.simThreshold,
      maxClusterSize: options.maxClusterSize,
      type: options.type,
      idempotencyDays: options.idempotencyDays,
      batch: options.batch,
      resume: options.resume,
      onLog: (message) => logger.info(message),
      onWarn: (message) => logger.warn(formatWarn(message)),
    });

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
    resolvedDeps.closeDbFn(db);
  }
}
