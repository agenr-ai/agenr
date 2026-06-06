import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_DREAMING_DAILY_COST_CAP,
  DEFAULT_DREAMING_EXTRACT_MAX_SESSIONS,
  DEFAULT_DREAMING_LIGHT_MAX_SESSIONS,
  DEFAULT_DREAMING_PRUNE_PROTECT_MIN_IMPORTANCE,
  DEFAULT_DREAMING_PRUNE_PROTECT_RECALLED_DAYS,
  type AgenrConfig,
} from "../../config.js";
import { buildDreamEfficiencySummary } from "../../core/dreaming/efficiency.js";
import { resolveTierStages } from "../../core/dreaming/domain/tier-plan.js";
import type { EmbeddingPort } from "../../core/ports.js";
import type { Logger } from "../../logger.js";
import type {
  DreamCompletionSummary,
  DreamEfficiencySummary,
  DreamProjectSummary,
  DreamPruneSummary,
  DreamRunStatus,
  DreamTier,
} from "../../core/dreaming/types.js";
import { resolveLocalFilesystemPath } from "../../filesystem-path.js";
import { throwIfAborted, USER_ABORT_ERROR } from "./abort.js";
import { applyExtractedDurables, runExtractStage } from "./extract.js";
import { emitDreamProgress, type DreamProgressReporter } from "./progress.js";
import { runPruneStage } from "./prune.js";
import { runProjectStage } from "./project.js";
import type { CostMeteredLlm, DreamPort } from "./ports.js";
import { runReconcilePass } from "./reconcile/index.js";
import { type DreamingRunLease, withDreamingRunLock } from "./concurrency.js";
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
  durablesStaled: number;
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
  throwIfAborted(options.signal);
  return withDreamingRunLock(deps.port, deps.dbPath, (lease) => runDreamWithHeldLock(options, deps, lease));
}

/**
 * Runs the dreaming pipeline using a lock lease already held by the caller.
 *
 * @param options - Dreaming run options from the CLI or host trigger.
 * @param deps - Resolved database, config, and progress dependencies.
 * @param lease - Active dreaming run lease returned by the concurrency helper.
 * @returns Final dreaming run summary.
 */
export async function runDreamWithHeldLock(options: DreamRunOptions, deps: DreamWorkflowDeps, lease: DreamingRunLease): Promise<DreamRunResult> {
  throwIfAborted(options.signal);
  await lease.heartbeat();
  return executeDreamRun(options, deps);
}

/**
 * Executes the dreaming pipeline assuming the run lock is already held.
 *
 * @param options - Dreaming run options from the CLI or host trigger.
 * @param deps - Resolved database, config, and progress dependencies.
 * @returns Final dreaming run summary.
 */
async function executeDreamRun(options: DreamRunOptions, deps: DreamWorkflowDeps): Promise<DreamRunResult> {
  const now = deps.now ?? (() => new Date());
  assertDreamTierEnabled(options.tier, deps.config);
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

  const extractStages = resolveExtractStageConfig(deps.config, options.tier);
  const stagePlan = resolveTierStages(options.tier);
  const createExtractLlm = deps.createExtractLlm ?? deps.createClaimExtractionLlm;
  const embedding = resolveDreamEmbedding(deps.embedding);
  let scanSummary: DreamCompletionSummary["scan"];
  let extractSummary: DreamCompletionSummary["extract"];
  let reconcileSummary: DreamCompletionSummary["reconcile"];
  let temporalizeSummary: DreamCompletionSummary["temporalize"];
  let projectSummary: DreamProjectSummary | undefined;
  let pruneSummary: DreamPruneSummary | undefined;
  let efficiencySummary: DreamEfficiencySummary | undefined;
  const stagesSkipped: NonNullable<DreamCompletionSummary["stages_skipped"]> = [];
  let durablesSkipped: DreamCompletionSummary["durables_skipped"] = [];
  let observations: string[] = [];
  let recommendations: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedCostUsd = 0;
  let actionsTaken = 0;
  let actionsSkipped = 0;
  let durablesStaled = 0;
  let reconcileStatus: DreamRunStatus;
  let reconcileError: string | undefined;

  try {
    const fullBacklog = options.tier === "deep";
    const scan = await runDreamScan({ project: options.project, fullBacklog, now }, { port: deps.port });
    scanSummary = scan;

    const extract = await runExtractStage(
      {
        now,
        ...(options.project ? { project: options.project } : {}),
        fullBacklog,
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

    if (stagePlan.runReconcile) {
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
      actionsTaken = reconcile.completion.actions_taken + durablesInserted;
      actionsSkipped = reconcile.completion.durables_skipped.length;
      durablesSkipped = reconcile.completion.durables_skipped;
      recommendations = reconcile.completion.recommendations;
      reconcileSummary = reconcile.completion.reconcile;
      durablesStaled = reconcile.durablesStaled;
      inputTokens = reconcile.usage.inputTokens + extract.usage.inputTokens;
      outputTokens = reconcile.usage.outputTokens + extract.usage.outputTokens;
      estimatedCostUsd = reconcile.usage.estimatedCostUsd + extract.usage.estimatedCostUsd;
      reconcileStatus = reconcile.status;
      reconcileError = reconcile.error ?? undefined;
    } else {
      stagesSkipped.push({ stage: "reconcile", reason: "light_tier" });
      observations.push("Reconcile stage skipped for light tier.");
      actionsTaken = durablesInserted;
      reconcileStatus = "completed";
    }

    if (extract.status === "cost_capped") {
      observations.push("Extract stage stopped early after reaching the daily dreaming cost cap.");
    }

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

    const status: DreamRunStatus = extract.status === "cost_capped" && reconcileStatus === "completed" ? "cost_capped" : reconcileStatus;
    const activeProfileSnapshot = status === "completed" && options.apply && !options.project ? projectStage.snapshot : null;
    projectSummary = {
      ...projectStage.summary,
      snapshotId: activeProfileSnapshot?.id ?? null,
      applied: activeProfileSnapshot !== null,
    };

    if (stagePlan.runPrune) {
      const pruneConfig = resolvePruneStageConfig(deps.config);
      pruneSummary = await runPruneStage(
        {
          runId,
          apply: options.apply,
          now,
          ...(options.project ? { project: options.project } : {}),
          protectedDurableIds: projectStage.snapshot ? [...projectStage.snapshot.durableIds, ...projectStage.snapshot.directiveIds] : [],
          protectRecalledDays: pruneConfig.protectRecalledDays,
          protectMinImportance: pruneConfig.protectMinImportance,
        },
        { port: deps.port },
      );
      actionsTaken += pruneSummary.durablesStaled;
      actionsSkipped += pruneSummary.candidatesProtected + (options.apply ? 0 : pruneSummary.candidatesRetirable);
      durablesStaled += pruneSummary.durablesStaled;
    } else {
      stagesSkipped.push({ stage: "prune", reason: "light_tier" });
    }

    efficiencySummary = buildDreamEfficiencySummary({
      scan,
      estimatedCostUsd,
      synthesizedDurableMutations: extractSummary.durablesInserted + temporalizeSummary.revisionsApplied + (pruneSummary?.durablesStaled ?? 0),
      profileDurableCount: projectSummary.profileDurableCount,
      directiveCount: projectSummary.directiveCount,
    });

    const completionSummary: DreamCompletionSummary = {
      actions_taken: actionsTaken,
      ...(resolveBackupSkipped(options) ? { backupSkipped: true } : {}),
      ...(stagesSkipped.length > 0 ? { stages_skipped: stagesSkipped } : {}),
      durables_skipped: durablesSkipped,
      observations,
      recommendations,
      scan,
      extract: extractSummary,
      ...(reconcileSummary ? { reconcile: reconcileSummary } : {}),
      temporalize: temporalizeSummary,
      project: projectSummary,
      ...(pruneSummary ? { prune: pruneSummary } : {}),
      efficiency: efficiencySummary,
    };

    const runCompletion = {
      status,
      inputTokens,
      outputTokens,
      estimatedCostUsd,
      actionsTaken,
      actionsSkipped,
      durablesStaled,
      summaryJson: completionSummary,
      error: reconcileError,
    };
    const dreamStateUpdate = {
      unsynthesizedImportanceSum: status === "completed" ? 0 : scan.unsynthesizedImportanceSum,
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
      durablesStaled,
      inputTokens,
      outputTokens,
      estimatedCostUsd,
      summary: reconcileError ?? (status === "completed" ? "Dreaming run completed." : null),
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
      ...(resolveBackupSkipped(options) ? { backupSkipped: true } : {}),
      ...(stagesSkipped.length > 0 ? { stages_skipped: stagesSkipped } : {}),
      durables_skipped: durablesSkipped,
      observations: failureObservations,
      recommendations,
      ...(scanSummary ? { scan: scanSummary } : {}),
      ...(extractSummary ? { extract: extractSummary } : {}),
      ...(reconcileSummary ? { reconcile: reconcileSummary } : {}),
      ...(temporalizeSummary ? { temporalize: temporalizeSummary } : {}),
      ...(projectSummary ? { project: projectSummary } : {}),
      ...(pruneSummary ? { prune: pruneSummary } : {}),
      ...(efficiencySummary ? { efficiency: efficiencySummary } : {}),
    };
    await deps.port.completeRun(runId, {
      status,
      inputTokens,
      outputTokens,
      estimatedCostUsd,
      actionsTaken,
      actionsSkipped,
      durablesStaled,
      summaryJson: failureSummary,
      error: message,
    });
    throw error;
  }
}

/**
 * Enforces operator tier availability before any dreaming run state is created.
 *
 * @param tier - Requested dreaming tier.
 * @param config - Optional runtime config.
 */
function assertDreamTierEnabled(tier: DreamTier, config: AgenrConfig | null): void {
  if (config?.dreaming?.tiers?.[tier]?.enabled === false) {
    throw new Error(`Dreaming tier "${tier}" is disabled in config.`);
  }
}

/** Returns whether this apply run intentionally skipped the pre-apply backup step. */
function resolveBackupSkipped(options: DreamRunOptions): boolean {
  return options.apply === true && options.skipBackup === true;
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
 * Resolves prune-stage protection settings from config.
 *
 * @param config - Resolved or partial agenr config, or null.
 * @returns Effective prune protection thresholds.
 */
function resolvePruneStageConfig(config: AgenrConfig | null): { protectRecalledDays: number; protectMinImportance: number } {
  const prune = config?.dreaming?.stages?.prune;
  return {
    protectRecalledDays:
      typeof prune?.protectRecalledDays === "number" && prune.protectRecalledDays >= 0
        ? prune.protectRecalledDays
        : DEFAULT_DREAMING_PRUNE_PROTECT_RECALLED_DAYS,
    protectMinImportance:
      typeof prune?.protectMinImportance === "number" && prune.protectMinImportance >= 0
        ? prune.protectMinImportance
        : DEFAULT_DREAMING_PRUNE_PROTECT_MIN_IMPORTANCE,
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
function resolveExtractStageConfig(config: AgenrConfig | null, tier: DreamTier): { maxEpisodes: number; contextLookupEnabled: boolean } {
  const extract = config?.dreaming?.stages?.extract;
  const defaultMaxSessions = tier === "light" ? DEFAULT_DREAMING_LIGHT_MAX_SESSIONS : DEFAULT_DREAMING_EXTRACT_MAX_SESSIONS;
  const configuredMaxSessions = tier === "light" ? extract?.lightMaxSessionsPerRun : extract?.maxSessionsPerRun;
  const maxEpisodes = typeof configuredMaxSessions === "number" && configuredMaxSessions > 0 ? configuredMaxSessions : defaultMaxSessions;
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

/** Copies a SQLite sidecar file when it exists. */
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

/** Loads a best-effort action count for a partially completed dream run. */
async function loadPartialRunActions(port: DreamPort, runId: string): Promise<number> {
  try {
    return (await port.getRunActions(runId)).length;
  } catch {
    return 0;
  }
}

/** Returns whether an error represents a missing filesystem path. */
function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
