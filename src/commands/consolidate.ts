import os from "node:os";
import path from "node:path";
import * as clack from "@clack/prompts";
import { readConfig } from "../config.js";
import { buildClusters } from "../consolidate/cluster.js";
import { acquireLock, releaseLock } from "../consolidate/lock.js";
import { mergeCluster } from "../consolidate/merge.js";
import { consolidateRules, type ConsolidationStats } from "../consolidate/rules.js";
import { showFlaggedMerges } from "../consolidate/verify.js";
import { closeDb, DEFAULT_DB_PATH, getDb, walCheckpoint } from "../db/client.js";
import { rebuildVectorIndex } from "../db/vector-index.js";
import { runMigrations } from "../db/schema.js";
import { resolveEmbeddingApiKey } from "../embeddings/client.js";
import { createLlmClient } from "../llm/client.js";
import { formatWarn } from "../ui.js";

export interface ConsolidateCommandOptions {
  rulesOnly?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  json?: boolean;
  db?: string;
  minCluster?: number;
  simThreshold?: number;
  type?: string;
  showFlagged?: boolean;
  idempotencyDays?: number;
}

interface Phase2Stats {
  clustersFound: number;
  clustersMerged: number;
  mergesFlagged: number;
  llmCalls: number;
  entriesConsolidatedFrom: number;
  canonicalEntriesCreated: number;
}

interface ConsolidateReport extends ConsolidationStats {
  phase2?: Phase2Stats;
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

function renderTextReport(stats: ConsolidateReport, dryRun: boolean): string {
  const header = dryRun
    ? "+--  AGENR -- Knowledge Consolidation (dry run -- no changes made)"
    : "+--  AGENR -- Knowledge Consolidation";

  const lines = [
    header,
    "|",
    `|  Backup: ${stats.backupPath}`,
    "|",
    "|  Phase 1: Rule-Based Cleanup",
    `|  +- Expired entries pruned: ${stats.expiredCount}`,
    `|  +- Near-exact duplicates merged: ${stats.mergedCount}`,
    `|  +- Orphaned relations cleaned: ${stats.orphanedRelationsCleaned}`,
  ];

  if (stats.phase2) {
    lines.push(
      "|",
      "|  Phase 2: LLM-Assisted Consolidation",
      `|  +- Clusters found: ${stats.phase2.clustersFound}`,
      `|  +- Clusters merged: ${stats.phase2.clustersMerged}`,
      `|  +- Entries consolidated: ${stats.phase2.entriesConsolidatedFrom} -> ${stats.phase2.canonicalEntriesCreated} canonical entries`,
      `|  +- Merges flagged for review: ${stats.phase2.mergesFlagged}`,
      `|  +- LLM calls: ${stats.phase2.llmCalls}`,
    );
  }

  lines.push(
    "|",
    "|  Summary",
    `|  +- Before: ${stats.entriesBefore} active entries`,
    `|  +- After:  ${stats.entriesAfter} active entries`,
    "|",
    "+--  Done",
  );

  return lines.join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runConsolidateCommand(
  options: ConsolidateCommandOptions,
): Promise<{ exitCode: number }> {
  if (options.showFlagged) {
    await showFlaggedMerges();
    return { exitCode: 0 };
  }

  const config = readConfig(process.env);
  const configuredPath = options.db?.trim() || config?.db?.path || DEFAULT_DB_PATH;
  const dbFilePath = resolveDbFilePath(configuredPath);

  if (dbFilePath === ":memory:") {
    throw new Error("Consolidation requires a file-backed database so a backup can be created.");
  }

  const db = getDb(configuredPath);
  const clackOutput = { output: process.stderr };

  try {
    await runMigrations(db);

    acquireLock();
    try {
      const report: ConsolidateReport = await consolidateRules(db, dbFilePath, {
        dryRun: options.dryRun,
        verbose: options.verbose,
        onLog: options.verbose ? (message) => clack.log.info(message, clackOutput) : undefined,
      });

      if (!options.rulesOnly) {
        const llmClient = createLlmClient({ env: process.env });
        const embeddingApiKey = resolveEmbeddingApiKey(config, process.env);

        const clusters = await buildClusters(db, {
          simThreshold: options.simThreshold,
          minCluster: options.minCluster,
          typeFilter: options.type,
          idempotencyDays: options.idempotencyDays,
          verbose: options.verbose,
          onLog: options.verbose ? (message) => clack.log.info(message, clackOutput) : undefined,
        });

        const phase2: Phase2Stats = {
          clustersFound: clusters.length,
          clustersMerged: 0,
          mergesFlagged: 0,
          llmCalls: 0,
          entriesConsolidatedFrom: 0,
          canonicalEntriesCreated: 0,
        };

        for (const cluster of clusters) {
          phase2.llmCalls += 1;
          const outcome = await mergeCluster(db, cluster, llmClient, embeddingApiKey, {
            dryRun: options.dryRun,
            verbose: options.verbose,
            onLog: options.verbose ? (message) => clack.log.info(message, clackOutput) : undefined,
          });

          if (outcome.flagged) {
            phase2.mergesFlagged += 1;
            continue;
          }

          phase2.clustersMerged += 1;
          phase2.entriesConsolidatedFrom += cluster.entries.length;
          phase2.canonicalEntriesCreated += 1;
        }

        report.phase2 = phase2;

        if (!options.dryRun) {
          try {
            await rebuildVectorIndex(db, {
              onLog: options.verbose ? (message) => clack.log.info(message, clackOutput) : undefined,
            });
          } catch (error) {
            clack.log.warn(
              formatWarn(`Vector index rebuild failed: ${errorMessage(error)}`),
              clackOutput,
            );
          }
        }
      }

      if (!options.dryRun) {
        try {
          await walCheckpoint(db);
        } catch (error) {
          clack.log.warn(formatWarn(`WAL checkpoint failed: ${errorMessage(error)}`), clackOutput);
        }
      }

      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return { exitCode: 0 };
      }

      clack.log.info(renderTextReport(report, options.dryRun === true), clackOutput);
      return { exitCode: 0 };
    } finally {
      releaseLock();
    }
  } finally {
    closeDb(db);
  }
}
