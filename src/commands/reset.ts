import fs from "node:fs/promises";
import path from "node:path";
import type { Client } from "@libsql/client";
import { readConfig } from "../config.js";
import { REVIEW_QUEUE_PATH } from "../consolidate/verify.js";
import { backupDb, closeDb, DEFAULT_DB_PATH, getDb } from "../db/client.js";
import { resetDb } from "../db/schema.js";
import { resolveConfigDir } from "../watch/state.js";

export interface ResetCommandOptions {
  db?: string;
  confirmReset?: boolean;
}

export interface ResetCommandDeps {
  resolveDbPathFn: (options: ResetCommandOptions) => string;
  backupDbFn: (dbPath: string) => Promise<string>;
  resetDbFn: (db: Client) => Promise<void>;
  getDbFn: (dbPath: string) => Client;
  closeDbFn: (db: Client) => void;
  deleteFileFn: (filePath: string) => Promise<void>;
  stdoutLine: (msg: string) => void;
  stderrLine: (msg: string) => void;
}

export interface ResetCommandResult {
  exitCode: number;
}

function stdoutLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

function stderrLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

function resolveDbPath(options: ResetCommandOptions): string {
  return options.db?.trim() || readConfig(process.env)?.db?.path || DEFAULT_DB_PATH;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildPreResetBackupPath(dbPath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  return path.join(path.dirname(dbPath), `${path.basename(dbPath)}.backup-pre-reset-${timestamp}Z`);
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function deleteSideFile(filePath: string, deps: ResetCommandDeps): Promise<void> {
  try {
    await deps.deleteFileFn(filePath);
  } catch (error) {
    if (isEnoent(error)) {
      return;
    }
    deps.stderrLine(`Warning: failed to delete ${filePath}: ${errorMessage(error)}`);
  }
}

function resolveDeps(deps?: Partial<ResetCommandDeps>): ResetCommandDeps {
  return {
    resolveDbPathFn: deps?.resolveDbPathFn ?? resolveDbPath,
    backupDbFn: deps?.backupDbFn ?? backupDb,
    resetDbFn: deps?.resetDbFn ?? resetDb,
    getDbFn: deps?.getDbFn ?? getDb,
    closeDbFn: deps?.closeDbFn ?? closeDb,
    deleteFileFn: deps?.deleteFileFn ?? (async (filePath: string) => fs.unlink(filePath)),
    stdoutLine: deps?.stdoutLine ?? stdoutLine,
    stderrLine: deps?.stderrLine ?? stderrLine,
  };
}

export async function runResetCommand(
  options: ResetCommandOptions,
  deps?: Partial<ResetCommandDeps>,
): Promise<ResetCommandResult> {
  const resolvedDeps = resolveDeps(deps);
  const resolvedDbPath = resolvedDeps.resolveDbPathFn(options);
  const watchStatePath = path.join(resolveConfigDir(), "watch-state.json");
  const reviewQueuePath = REVIEW_QUEUE_PATH;

  if (!options.confirmReset) {
    resolvedDeps.stdoutLine("[dry run] agenr db reset --full would perform the following actions:");
    resolvedDeps.stdoutLine(`  - Backup database to: ${buildPreResetBackupPath(resolvedDbPath)}`);
    resolvedDeps.stdoutLine("  - Drop and recreate DB schema (all data erased, file retained)");
    resolvedDeps.stdoutLine(`  - Delete: ${watchStatePath}`);
    resolvedDeps.stdoutLine(`  - Delete: ${reviewQueuePath}`);
    resolvedDeps.stdoutLine("Run with --confirm-reset to execute.");
    return { exitCode: 0 };
  }

  resolvedDeps.stdoutLine(
    "WARNING: If the agenr watcher daemon is running, stop it before proceeding. Reset will not abort if the daemon is running.",
  );

  let backupPath: string;
  try {
    backupPath = await resolvedDeps.backupDbFn(resolvedDbPath);
  } catch (error) {
    resolvedDeps.stderrLine(errorMessage(error));
    return { exitCode: 1 };
  }

  resolvedDeps.stdoutLine(`Backup created: ${backupPath}`);

  const db = resolvedDeps.getDbFn(resolvedDbPath);
  try {
    await resolvedDeps.resetDbFn(db);
  } catch (error) {
    resolvedDeps.stderrLine(errorMessage(error));
    return { exitCode: 1 };
  } finally {
    resolvedDeps.closeDbFn(db);
  }

  await deleteSideFile(watchStatePath, resolvedDeps);
  await deleteSideFile(reviewQueuePath, resolvedDeps);

  resolvedDeps.stdoutLine("Reset complete.");
  resolvedDeps.stdoutLine(`  DB schema dropped and recreated: ${resolvedDbPath}`);
  resolvedDeps.stdoutLine("  watch-state.json deleted (or was not present)");
  resolvedDeps.stdoutLine("  review-queue.json deleted (or was not present)");

  return { exitCode: 0 };
}
