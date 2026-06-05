import { createDatabase } from "../../adapters/db/client.js";
import { createDreamPort } from "../../adapters/db/dreaming-port.js";
import { readConfig, type ResolvedAgenrConfig } from "../../config.js";
import type { DreamRunAction } from "../../core/dreaming/domain/action-types.js";
import type { DreamRunProposal } from "../../core/dreaming/types.js";
import type { Logger } from "../../logger.js";
import type { DreamHealthStats, DreamProposalBacklogItem, DreamProposalBacklogQuery, DreamRunRecord } from "./ports.js";
import type { DreamPort } from "./ports.js";
import type { DreamProgressReporter } from "./progress.js";
import { backupDatabaseFile, runDream, type DreamRunOptions, type DreamRunResult } from "./service.js";

/**
 * Runtime input accepted by the dreaming CLI and other top-level entry points.
 */
export interface DreamRuntimeOptions extends DreamRunOptions {
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  onProgress?: DreamProgressReporter;
  logger?: Logger;
}

/**
 * Resolves configuration and adapter instances, then runs one dreaming pipeline.
 *
 * @param input - Runtime input with optional db-path and env overrides.
 * @returns Final dreaming run result.
 */
export async function runDreamRuntime(input: DreamRuntimeOptions): Promise<DreamRunResult> {
  const runtime = loadRuntimeConfig(input);
  return withDreamPort(runtime.dbPath, async (port) =>
    runDream(input, {
      port,
      dbPath: runtime.dbPath,
      config: runtime.config,
      backupDb: backupDatabaseFile,
      reportProgress: input.onProgress,
      logger: input.logger,
    }),
  );
}

/**
 * Loads the current dreaming status without starting a run.
 *
 * @param input - Runtime input with optional db-path and env overrides.
 * @returns Current health summary and the latest persisted dreaming run.
 */
export async function loadDreamStatusRuntime(input: {
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ health: DreamHealthStats; lastRun: DreamRunRecord | null }> {
  const runtime = loadRuntimeConfig(input);
  return withDreamPort(runtime.dbPath, async (port) => {
    const [health, lastRun] = await Promise.all([port.getHealthStats(), port.getLastRun()]);

    return { health, lastRun };
  });
}

/**
 * Loads recent dreaming run history for CLI inspection.
 *
 * @param input - Runtime input with optional db-path and row limit.
 * @returns Recent persisted dreaming runs ordered newest first.
 */
export async function loadDreamHistoryRuntime(input: { dbPath?: string; env?: NodeJS.ProcessEnv; limit?: number }): Promise<DreamRunRecord[]> {
  const runtime = loadRuntimeConfig(input);
  return withDreamPort(runtime.dbPath, async (port) => port.getRunHistory(input.limit));
}

/**
 * Loads the action audit trail for one dreaming run.
 *
 * @param input - Runtime input with optional db-path and required run ID.
 * @returns Recorded dreaming actions for the requested run.
 */
export async function loadDreamActionsRuntime(input: { runId: string; dbPath?: string; env?: NodeJS.ProcessEnv }): Promise<DreamRunAction[]> {
  const runtime = loadRuntimeConfig(input);
  return withDreamPort(runtime.dbPath, async (port) => port.getRunActions(input.runId));
}

/**
 * Loads the unresolved proposal trail for one dreaming run.
 *
 * @param input - Runtime input with optional db-path and required run ID.
 * @returns Recorded unresolved proposals for the requested run.
 */
export async function loadDreamProposalsRuntime(input: { runId: string; dbPath?: string; env?: NodeJS.ProcessEnv }): Promise<DreamRunProposal[]> {
  const runtime = loadRuntimeConfig(input);
  return withDreamPort(runtime.dbPath, async (port) => port.getRunProposals(input.runId));
}

/**
 * Loads the global proposal backlog across runs for operator review.
 *
 * @param input - Runtime input with optional db-path and backlog filters.
 * @returns Joined backlog rows ordered for review.
 */
export async function loadDreamBacklogRuntime(
  input: { dbPath?: string; env?: NodeJS.ProcessEnv } & DreamProposalBacklogQuery,
): Promise<DreamProposalBacklogItem[]> {
  const runtime = loadRuntimeConfig(input);
  return withDreamPort(runtime.dbPath, async (port) => port.listProposalBacklog(input));
}

/**
 * Opens one database session and exposes the dreaming port to a callback.
 *
 * @param dbPath - Database path to open.
 * @param fn - Callback that receives the dreaming port.
 * @returns Callback result after the database is closed.
 */
async function withDreamPort<T>(dbPath: string, fn: (port: DreamPort) => Promise<T>): Promise<T> {
  const database = await createDatabase(dbPath);
  const port = createDreamPort(database);

  try {
    return await fn(port);
  } finally {
    await database.close();
  }
}

function loadRuntimeConfig(input: { dbPath?: string; env?: NodeJS.ProcessEnv }): { dbPath: string; config: ResolvedAgenrConfig } {
  const previousConfigPath = input.env?.AGENR_CONFIG_PATH;
  if (input.env) {
    delete input.env.AGENR_CONFIG_PATH;
  }
  const config = readConfig({ dbPath: input.dbPath });
  if (input.env && previousConfigPath) {
    input.env.AGENR_CONFIG_PATH = previousConfigPath;
  }
  const dbPath = input.dbPath ?? config.dbPath;
  return { dbPath, config };
}
