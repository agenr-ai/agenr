import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_DREAMING_DAILY_COST_CAP, type AgenrConfig } from "../../config.js";
import type { LlmPort } from "../../core/ports.js";
import type { Logger } from "../../logger.js";
import type { DreamCompletionSummary, DreamRunStatus, DreamTier } from "../../core/dreaming/types.js";
import { emitDreamProgress, type DreamProgressReporter } from "./progress.js";
import type { DreamPort } from "./ports.js";
import { runReconcilePass } from "./reconcile/index.js";
import { runDreamScan } from "./scan.js";

/**
 * CLI and runtime options accepted by one dreaming run.
 */
export interface DreamRunOptions {
  tier: DreamTier;
  project?: string;
  type?: string;
  claimKeyPrefix?: string;
  durableIds?: string[];
  includeInactive?: boolean;
  apply: boolean;
  verbose: boolean;
  json: boolean;
  signal?: AbortSignal;
  skipBackup?: boolean;
  /** When true, records shadow sibling-slot resonance telemetry in reconcile summaries. */
  includeShadowTelemetry?: boolean;
}

/**
 * Persisted summary returned after a dreaming run completes or fails.
 */
export interface DreamRunResult {
  runId: string;
  status: DreamRunStatus;
  tier: DreamTier;
  actionsTaken: number;
  actionsSkipped: number;
  durablesRetired: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  summary: string | null;
  completionSummary?: DreamCompletionSummary | null;
}

/**
 * Resolved infrastructure dependencies for the dreaming workflow.
 */
export interface DreamWorkflowDeps {
  port: DreamPort;
  dbPath?: string;
  config: AgenrConfig | null;
  createClaimExtractionLlm?: () => LlmPort & { metadata?: { usage?: { inputTokens?: number; outputTokens?: number; totalCost?: number } } };
  now?: () => Date;
  backupDb?: (dbPath: string) => Promise<string>;
  reportProgress?: DreamProgressReporter;
  logger?: Logger;
}

const USER_ABORT_ERROR = "Run aborted by user (SIGINT).";
const USER_ABORT_SUMMARY = "Run aborted by user.";

/**
 * Runs the standard dreaming pipeline: scan, reconcile, and optional apply.
 *
 * @param options - Dreaming run options from the CLI or host trigger.
 * @param deps - Resolved database, config, and progress dependencies.
 * @returns Final dreaming run summary.
 */
export async function runDream(options: DreamRunOptions, deps: DreamWorkflowDeps): Promise<DreamRunResult> {
  const now = deps.now ?? (() => new Date());
  throwIfAborted(options.signal);

  const dailyCost = await deps.port.getDailyCost(now());
  const dailyCap = deps.config?.dreaming?.dailyCostCap ?? DEFAULT_DREAMING_DAILY_COST_CAP;
  if (dailyCost >= dailyCap) {
    throw new Error(`Daily dreaming cost cap reached (${dailyCost.toFixed(2)} / ${dailyCap.toFixed(2)} USD).`);
  }
  const remainingDailyBudgetUsd = Math.max(0, dailyCap - dailyCost);

  const runId = await deps.port.createRun({
    tier: options.tier,
    project: options.project,
    dryRun: !options.apply,
    config: {
      tier: options.tier,
      project: options.project ?? null,
      type: options.type ?? null,
      claimKeyPrefix: options.claimKeyPrefix ?? null,
      durableIds: options.durableIds ?? [],
      includeInactive: options.includeInactive ?? false,
    },
  });

  emitDreamProgress(deps.reportProgress, {
    kind: "phase",
    phase: "start",
    tier: options.tier,
    apply: options.apply,
  });

  if (options.apply && !options.skipBackup && deps.dbPath && deps.dbPath !== ":memory:" && deps.backupDb) {
    emitDreamProgress(deps.reportProgress, { kind: "phase", phase: "backup_start", tier: options.tier, apply: options.apply });
    const backupPath = await deps.backupDb(deps.dbPath);
    emitDreamProgress(deps.reportProgress, {
      kind: "phase",
      phase: "backup_complete",
      tier: options.tier,
      apply: options.apply,
      backupPath,
    });
  }

  try {
    const scan = await runDreamScan({ project: options.project, now }, { port: deps.port });
    const reconcile = await runReconcilePass(
      {
        runId,
        tier: options.tier,
        apply: options.apply,
        project: options.project,
        type: options.type,
        claimKeyPrefix: options.claimKeyPrefix,
        durableIds: options.durableIds,
        includeInactive: options.includeInactive,
        signal: options.signal,
        now,
        costCapUsd: remainingDailyBudgetUsd,
        verbose: options.verbose,
        includeShadowTelemetry: options.includeShadowTelemetry === true,
        reportProgress: deps.reportProgress,
      },
      {
        port: deps.port,
        config: deps.config,
        ...(deps.createClaimExtractionLlm ? { createClaimExtractionLlm: deps.createClaimExtractionLlm } : {}),
      },
    );

    const completionSummary: DreamCompletionSummary = {
      actions_taken: reconcile.completion.actions_taken,
      durables_skipped: reconcile.completion.durables_skipped,
      observations: reconcile.completion.observations,
      recommendations: reconcile.completion.recommendations,
      scan,
      reconcile: reconcile.completion.reconcile,
    };

    const status: DreamRunStatus = reconcile.status;
    await deps.port.completeRun(runId, {
      status,
      inputTokens: reconcile.usage.inputTokens,
      outputTokens: reconcile.usage.outputTokens,
      estimatedCostUsd: reconcile.usage.estimatedCostUsd,
      actionsTaken: reconcile.completion.actions_taken,
      actionsSkipped: reconcile.completion.durables_skipped.length,
      durablesRetired: reconcile.durablesRetired,
      summaryJson: completionSummary,
      error: reconcile.error,
    });

    await deps.port.updateDreamState({
      lastSuccessfulRunAt: status === "completed" ? now().toISOString() : undefined,
      unsynthesizedImportanceSum: scan.unsynthesizedImportanceSum,
      updatedAt: now().toISOString(),
    });

    return {
      runId,
      status,
      tier: options.tier,
      actionsTaken: reconcile.completion.actions_taken,
      actionsSkipped: reconcile.completion.durables_skipped.length,
      durablesRetired: reconcile.durablesRetired,
      inputTokens: reconcile.usage.inputTokens,
      outputTokens: reconcile.usage.outputTokens,
      estimatedCostUsd: reconcile.usage.estimatedCostUsd,
      summary: reconcile.error ?? (status === "completed" ? "Dreaming run completed." : null),
      completionSummary,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status: DreamRunStatus = message === USER_ABORT_ERROR ? "aborted" : "failed";
    await deps.port.completeRun(runId, {
      status,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      actionsTaken: 0,
      actionsSkipped: 0,
      durablesRetired: 0,
      summaryJson: {
        actions_taken: 0,
        durables_skipped: [],
        observations: [],
        recommendations: [],
      },
      error: message,
    });
    throw error;
  }
}

/**
 * Creates a timestamped SQLite backup before the first mutating dreaming write.
 *
 * @param dbPath - Database file path to back up.
 * @returns Absolute path to the created backup file.
 */
export async function backupDatabaseFile(dbPath: string): Promise<string> {
  const backupDir = path.join(path.dirname(dbPath), "backups");
  await mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `knowledge-${stamp}.db`);
  await copyFile(dbPath, backupPath);
  for (const suffix of ["-wal", "-shm"]) {
    try {
      await copyFile(`${dbPath}${suffix}`, `${backupPath}${suffix}`);
    } catch {
      // WAL/SHM may not exist for inactive databases.
    }
  }
  return backupPath;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error(USER_ABORT_ERROR);
  }
}

export { USER_ABORT_ERROR, USER_ABORT_SUMMARY };
