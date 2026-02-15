import os from "node:os";
import path from "node:path";
import * as clack from "@clack/prompts";
import { readConfig } from "../config.js";
import { consolidateRules } from "../consolidate/rules.js";
import { closeDb, DEFAULT_DB_PATH, getDb } from "../db/client.js";
import { runMigrations } from "../db/schema.js";

export interface ConsolidateCommandOptions {
  rulesOnly?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  json?: boolean;
  db?: string;
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

function renderTextReport(stats: {
  backupPath: string;
  expiredCount: number;
  mergedCount: number;
  orphanedRelationsCleaned: number;
  entriesBefore: number;
  entriesAfter: number;
}, dryRun: boolean): string {
  const header = dryRun
    ? "+--  AGENR -- Knowledge Consolidation (dry run -- no changes made)"
    : "+--  AGENR -- Knowledge Consolidation";

  return [
    header,
    "|",
    `|  Backup: ${stats.backupPath}`,
    "|",
    "|  Phase 1: Rule-Based Cleanup",
    `|  +- Expired entries pruned: ${stats.expiredCount}`,
    `|  +- Near-exact duplicates merged: ${stats.mergedCount}`,
    `|  +- Orphaned relations cleaned: ${stats.orphanedRelationsCleaned}`,
    "|",
    "|  Summary",
    `|  +- Before: ${stats.entriesBefore} active entries`,
    `|  +- After:  ${stats.entriesAfter} active entries`,
    "|",
    "+--  Done",
  ].join("\n");
}

export async function runConsolidateCommand(
  options: ConsolidateCommandOptions,
): Promise<{ exitCode: number }> {
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

    if (options.rulesOnly !== true) {
      throw new Error("Only --rules-only mode is supported in this phase.");
    }

    const stats = await consolidateRules(db, dbFilePath, {
      dryRun: options.dryRun,
      verbose: options.verbose,
      onLog: options.verbose ? (message) => clack.log.info(message, clackOutput) : undefined,
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
      return { exitCode: 0 };
    }

    clack.log.info(renderTextReport(stats, options.dryRun === true), clackOutput);
    return { exitCode: 0 };
  } finally {
    closeDb(db);
  }
}
