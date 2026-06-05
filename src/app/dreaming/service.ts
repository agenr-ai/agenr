import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_DREAMING_DAILY_COST_CAP, DEFAULT_DREAMING_EXTRACT_MAX_SESSIONS, type AgenrConfig } from "../../config.js";
import type { EmbeddingPort } from "../../core/ports.js";
import type { Logger } from "../../logger.js";
import type { DreamCompletionSummary, DreamProjectSummary, DreamRunStatus, DreamTier } from "../../core/dreaming/types.js";
import { resolveLocalFilesystemPath } from "../../filesystem-path.js";
import { throwIfAborted, USER_ABORT_ERROR } from "./abort.js";
import { applyExtractedDurables, runExtractStage } from "./extract.js";
import { emitDreamProgress, type DreamProgressReporter } from "./progress.js";
import { runProjectStage } from "./project.js";
import type { CostMeteredLlm, DreamPort } from "./ports.js";
import { runReconcilePass } from "./reconcile/index.js";
import { runDreamScan } from "./scan.js";
import { runTemporalizeStage } from "./temporalize.js";

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
  createClaimExtractionLlm?: () => CostMeteredLlm;
  /** Factory for the extract-stage mining LLM. Falls back to the claim-extraction factory when absent. */
  createExtractLlm?: () => CostMeteredLlm;
  /** Embedding provider used to vectorize durables inserted by extract and temporalize. */
  embedding?: EmbeddingPort;
  now?: () => Date;
  backupDb?: (dbPath: string) => Promise<string>;
  reportProgress?: DreamProgressReporter;
  logger?: Logger;
}

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

  const extractStages = resolveExtractStageConfig(deps.config);
  const createExtractLlm = deps.createExtractLlm ?? deps.createClaimExtractionLlm;
  const embedding = resolveDreamEmbedding(deps.embedding);
  let scanSummary: DreamCompletionSummary["scan"];
  let extractSummary: DreamCompletionSummary["extract"];
  let reconcileSummary: DreamCompletionSummary["reconcile"];
  let temporalizeSummary: DreamCompletionSummary["temporalize"];
  let projectSummary: DreamProjectSummary | undefined;
  let durablesSkipped: DreamCompletionSummary["durables_skipped"] = [];
  let observations: string[] = [];
  let recommendations: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedCostUsd = 0;
  let actionsTaken = 0;
  let actionsSkipped = 0;
  let durablesRetired = 0;

  try {
    const scan = await runDreamScan({ project: options.project, now }, { port: deps.port });
    scanSummary = scan;

    const extract = await runExtractStage(
      {
        now,
        ...(options.project ? { project: options.project } : {}),
        maxEpisodes: extractStages.maxEpisodes,
        contextLookupEnabled: extractStages.contextLookupEnabled,
        costCapUsd: remainingDailyBudgetUsd,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      {
        port: deps.port,
        ...(createExtractLlm ? { createExtractLlm } : {}),
      },
    );
    let durablesInserted = 0;
    if (options.apply) {
      const applied = await applyExtractedDurables({ runId, candidates: extract.candidates, now }, { port: deps.port, embedding });
      durablesInserted = applied.inserted;
    }
    extractSummary = { ...extract.summary, durablesInserted };
    actionsTaken = durablesInserted;
    inputTokens = extract.usage.inputTokens;
    outputTokens = extract.usage.outputTokens;
    estimatedCostUsd = extract.usage.estimatedCostUsd;

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
        costCapUsd: Math.max(0, remainingDailyBudgetUsd - extract.usage.estimatedCostUsd),
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
    observations = [...reconcile.completion.observations];
    if (extract.status === "cost_capped") {
      observations.push("Extract stage stopped early after reaching the daily dreaming cost cap.");
    }

    actionsTaken = reconcile.completion.actions_taken + durablesInserted;
    actionsSkipped = reconcile.completion.durables_skipped.length;
    durablesSkipped = reconcile.completion.durables_skipped;
    recommendations = reconcile.completion.recommendations;
    reconcileSummary = reconcile.completion.reconcile;
    durablesRetired = reconcile.durablesRetired;
    inputTokens = reconcile.usage.inputTokens + extract.usage.inputTokens;
    outputTokens = reconcile.usage.outputTokens + extract.usage.outputTokens;
    estimatedCostUsd = reconcile.usage.estimatedCostUsd + extract.usage.estimatedCostUsd;

    const temporalize = await runTemporalizeStage(
      {
        runId,
        candidates: extract.candidates,
        apply: options.apply,
        now,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      { port: deps.port, embedding },
    );
    temporalizeSummary = temporalize.summary;

    actionsTaken += temporalize.summary.revisionsApplied;

    const projectStage = await runProjectStage(
      {
        runId,
        now,
        ...(options.project ? { project: options.project } : {}),
        maxProfileDurables: resolveProjectStageConfig(deps.config).maxProfileDurables,
      },
      { port: deps.port },
    );

    const status: DreamRunStatus = extract.status === "cost_capped" && reconcile.status === "completed" ? "cost_capped" : reconcile.status;
    const activeProfileSnapshot = status === "completed" && options.apply && !options.project ? projectStage.snapshot : null;
    projectSummary = {
      ...projectStage.summary,
      snapshotId: activeProfileSnapshot?.id ?? null,
      applied: activeProfileSnapshot !== null,
    };

    const completionSummary: DreamCompletionSummary = {
      actions_taken: actionsTaken,
      durables_skipped: durablesSkipped,
      observations,
      recommendations,
      scan,
      extract: extractSummary,
      reconcile: reconcileSummary,
      temporalize: temporalizeSummary,
      project: projectSummary,
    };

    const runCompletion = {
      status,
      inputTokens,
      outputTokens,
      estimatedCostUsd,
      actionsTaken,
      actionsSkipped,
      durablesRetired,
      summaryJson: completionSummary,
      error: reconcile.error,
    };
    const dreamStateUpdate = {
      unsynthesizedImportanceSum: scan.unsynthesizedImportanceSum,
      ...(status === "completed" ? { lastSuccessfulRunAt: now().toISOString() } : {}),
      ...(activeProfileSnapshot ? { activeProfileSnapshotId: activeProfileSnapshot.id } : {}),
      updatedAt: now().toISOString(),
    };
    if (activeProfileSnapshot) {
      await deps.port.withTransaction(async (tx) => {
        await tx.createProfileSnapshot(activeProfileSnapshot);
        await tx.completeRun(runId, runCompletion);
        await tx.updateDreamState(dreamStateUpdate);
      });
    } else {
      await deps.port.completeRun(runId, runCompletion);
      await deps.port.updateDreamState(dreamStateUpdate);
    }

    return {
      runId,
      status,
      tier: options.tier,
      actionsTaken,
      actionsSkipped,
      durablesRetired,
      inputTokens,
      outputTokens,
      estimatedCostUsd,
      summary: reconcile.error ?? (status === "completed" ? "Dreaming run completed." : null),
      completionSummary,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status: DreamRunStatus = message === USER_ABORT_ERROR ? "aborted" : "failed";
    const partialActions = await loadPartialRunActions(deps.port, runId);
    actionsTaken = Math.max(actionsTaken, partialActions);
    const failureObservations = [...observations, `Dreaming run stopped before completion: ${message}`];
    const failureSummary: DreamCompletionSummary = {
      actions_taken: actionsTaken,
      durables_skipped: durablesSkipped,
      observations: failureObservations,
      recommendations,
      ...(scanSummary ? { scan: scanSummary } : {}),
      ...(extractSummary ? { extract: extractSummary } : {}),
      ...(reconcileSummary ? { reconcile: reconcileSummary } : {}),
      ...(temporalizeSummary ? { temporalize: temporalizeSummary } : {}),
      ...(projectSummary ? { project: projectSummary } : {}),
    };
    await deps.port.completeRun(runId, {
      status,
      inputTokens,
      outputTokens,
      estimatedCostUsd,
      actionsTaken,
      actionsSkipped,
      durablesRetired,
      summaryJson: failureSummary,
      error: message,
    });
    throw error;
  }
}

/**
 * Resolves project-stage profile limits from config.
 *
 * @param config - Resolved or partial agenr config, or null.
 * @returns Effective profile durable ceiling.
 */
function resolveProjectStageConfig(config: AgenrConfig | null): { maxProfileDurables: number | undefined } {
  return {
    maxProfileDurables: config?.dreaming?.stages?.project?.maxProfileDurables,
  };
}

/**
 * Creates a timestamped SQLite backup before the first mutating dreaming write.
 *
 * @param dbPath - Database file path to back up.
 * @returns Absolute path to the created backup file.
 */
export async function backupDatabaseFile(dbPath: string): Promise<string> {
  const sourcePath = resolveLocalFilesystemPath(dbPath);
  if (!sourcePath) {
    throw new Error(`Cannot back up non-file database path: ${dbPath}.`);
  }

  const backupDir = path.join(path.dirname(sourcePath), "backups");
  await mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `knowledge-${stamp}.db`);
  await copyFile(sourcePath, backupPath);
  for (const suffix of ["-wal", "-shm"]) {
    await copySidecarIfPresent(`${sourcePath}${suffix}`, `${backupPath}${suffix}`);
  }
  return backupPath;
}

/**
 * Resolves extract-stage limits from config, applying defaults when absent.
 *
 * @param config - Resolved or partial agenr config, or null.
 * @returns Effective max-episodes ceiling and context-lookup toggle.
 */
function resolveExtractStageConfig(config: AgenrConfig | null): { maxEpisodes: number; contextLookupEnabled: boolean } {
  const extract = config?.dreaming?.stages?.extract;
  const maxEpisodes =
    typeof extract?.maxSessionsPerRun === "number" && extract.maxSessionsPerRun > 0 ? extract.maxSessionsPerRun : DEFAULT_DREAMING_EXTRACT_MAX_SESSIONS;
  const contextLookupEnabled = extract?.contextLookup?.enabled ?? true;
  return { maxEpisodes, contextLookupEnabled };
}

/**
 * Resolves the embedding provider used for dreaming inserts.
 *
 * When no provider is configured a guard port is returned that throws on any
 * non-empty embed request. Dry runs and no-op runs never embed, so the guard
 * stays dormant; an apply run that actually inserts without a configured
 * provider fails loudly instead of silently writing unsearchable rows.
 *
 * @param embedding - Optional embedding provider from the workflow dependencies.
 * @returns Embedding provider guaranteed to be present.
 */
function resolveDreamEmbedding(embedding: EmbeddingPort | undefined): EmbeddingPort {
  if (embedding) {
    return embedding;
  }

  return {
    embed: async (texts: string[]): Promise<number[][]> => {
      if (texts.length === 0) {
        return [];
      }
      throw new Error("Dreaming apply requires an embedding provider, but none was configured.");
    },
  };
}

async function copySidecarIfPresent(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await copyFile(sourcePath, targetPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }

    throw error;
  }
}

async function loadPartialRunActions(port: DreamPort, runId: string): Promise<number> {
  try {
    return (await port.getRunActions(runId)).length;
  } catch {
    return 0;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
