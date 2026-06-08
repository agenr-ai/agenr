import { detectClaimKeyEntityFamilyCandidates } from "../../../core/claim-key-entity-family.js";
import type { DreamCompletionSummary, ReconcilePassSummary } from "../../../core/dreaming/types.js";
import { emitDreamProgress, type ReconcileProgressStage } from "../progress.js";
import { buildClaimKeyHealthSnapshot } from "./health.js";
import { cloneClaimKeyInspectionTally } from "./helpers/claim-key-health-tally.js";
import { processEntityFamilyConvergenceCandidate } from "./handlers/entity-family.js";
import { detectDeepClaimKeyAliasCandidates, processClaimKeyAliasConvergenceCandidate } from "./handlers/claim-key-alias.js";
import { processInvalidOrNoncanonicalDurable } from "./handlers/invalid-durable.js";
import { processMissingDurable } from "./handlers/missing-durable.js";
import { processMixedKeyGroup } from "./handlers/mixed-group.js";
import { processSuspectDurable } from "./handlers/suspect-durable.js";
import { findMixedKeyGroups } from "./helpers/mixed-groups.js";
import { buildReconcilePassObservations, buildReconcilePassRecommendations } from "./helpers/observations.js";
import { formatMissingBackfillSkipDiagnostic } from "./helpers/missing-backfill.js";
import type { InspectedDurable, ReconcileDurablePartitions } from "./helpers/partition.js";
import { partitionReconcileDurables } from "./helpers/partition.js";
import { buildSiblingSlotResonanceShadowSummary } from "./helpers/shadow-resonance.js";
import { createReconcilePassContext, getClaimExtractionUsage } from "./pass-context.js";
import {
  preloadSuggestionsForStage,
  shouldPreloadSuggestions,
  shouldPreloadSuspectSuggestion,
  shouldPreviewMissingDurable,
} from "./pass-suggestion-handlers.js";
import { canContinueReconcilePass, runReconcileStage } from "./pass-stage-runner.js";
import type { ReconcileRunDeps, ReconcileRunOptions, ReconcileRunResult } from "./types.js";
import type { ReconcilePassContext } from "./pass-context.js";

/** Runnable unit for one ordered reconcile stage. */
type ReconcileStageRunner = (ctx: ReconcilePassContext) => Promise<void>;

/** Definition for a reconcile stage that processes inspected durables. */
interface InspectedDurableStageDef {
  stage: ReconcileProgressStage;
  items: InspectedDurable[];
  process: (ctx: ReconcilePassContext, item: InspectedDurable) => Promise<void>;
  previewFilter?: (ctx: ReconcilePassContext, item: InspectedDurable) => boolean;
}

/**
 * Runs the first-class reconcile dreaming pass.
 *
 * @param options - Reconcile pass selection and safety options.
 * @param deps - Database and optional claim-extraction dependencies.
 * @returns Final deterministic run summary plus usage totals.
 */
export async function runReconcilePass(options: ReconcileRunOptions, deps: ReconcileRunDeps): Promise<ReconcileRunResult> {
  const ctx = await createReconcilePassContext(options, deps);
  const { selection, projectedDurables, actualDurables } = ctx.workingSet;
  const executionStyle: ReconcilePassSummary["executionStyle"] =
    selection.includeInactive || selection.type !== null || selection.claimKeyPrefix !== null || selection.durableIds.length > 0 ? "targeted" : "autonomous";

  const eligibleTypes = ctx.extraction.claimExtractionConfig.eligibleTypes;
  const { partitions, inspectionTally, inspectionById } = partitionReconcileDurables(projectedDurables, eligibleTypes);
  const before = buildClaimKeyHealthSnapshot(actualDurables, eligibleTypes, inspectionTally);
  ctx.workingSet.projectedInspectionById = new Map(inspectionById);
  ctx.workingSet.actualInspectionById = new Map(inspectionById);
  ctx.workingSet.projectedInspectionTally = cloneClaimKeyInspectionTally(inspectionTally);
  ctx.workingSet.actualInspectionTally = cloneClaimKeyInspectionTally(inspectionTally);

  emitDreamProgress(options.reportProgress, {
    kind: "phase",
    phase: "load_working_set_complete",
    tier: options.tier,
    apply: options.apply,
    workingSetSize: before.totalDurables,
  });
  emitDreamProgress(options.reportProgress, {
    kind: "phase",
    phase: "pass_start",
    tier: options.tier,
    apply: options.apply,
  });
  ctx.progressTracker.emitHealthSnapshot(before);
  const stageRunners = buildReconcileStageRunners(partitions);

  try {
    for (const runStage of stageRunners) {
      if (!canContinueReconcilePass(ctx)) {
        break;
      }

      await runStage(ctx);
    }
  } catch (error) {
    ctx.telemetry.terminalStatus = "failed";
    ctx.telemetry.terminalError = error instanceof Error ? error.message : String(error);
  }

  const actualAfter = buildClaimKeyHealthSnapshot(actualDurables, ctx.extraction.claimExtractionConfig.eligibleTypes, ctx.workingSet.actualInspectionTally);
  const projectedAfter = buildClaimKeyHealthSnapshot(
    projectedDurables,
    ctx.extraction.claimExtractionConfig.eligibleTypes,
    ctx.workingSet.projectedInspectionTally,
  );
  ctx.telemetry.observations.push(...buildReconcilePassObservations(ctx, { before, executionStyle }));
  ctx.telemetry.recommendations.push(...buildReconcilePassRecommendations(ctx, actualAfter));

  const passSummary: ReconcilePassSummary = {
    executionStyle,
    workingSet: selection,
    before,
    after: options.apply ? actualAfter : before,
    projectedAfter: options.apply ? undefined : projectedAfter,
    counts: ctx.telemetry.counts,
    shadowSiblingSlotResonance: ctx.options.includeShadowTelemetry
      ? buildSiblingSlotResonanceShadowSummary(ctx.telemetry.siblingSlotResonanceShadowStats)
      : undefined,
    circuitBreaker: ctx.telemetry.circuitBreaker,
  };
  const completion: DreamCompletionSummary = {
    actions_taken: ctx.telemetry.actionsTaken,
    durables_skipped: ctx.telemetry.skippedDiagnostics.map((diagnostic) => ({
      durable_id: diagnostic.durableId,
      reason: formatMissingBackfillSkipDiagnostic(diagnostic),
    })),
    observations: ctx.telemetry.observations,
    recommendations: ctx.telemetry.recommendations,
    reconcile: passSummary,
  };

  return {
    status: ctx.telemetry.terminalStatus,
    error: ctx.telemetry.terminalError,
    completion,
    durablesStaled: 0,
    usage: getClaimExtractionUsage(ctx),
  };
}

/** Builds the ordered reconcile stage runner list from durable partitions. */
function buildReconcileStageRunners(partitions: ReconcileDurablePartitions): ReconcileStageRunner[] {
  const durableStageDefs: InspectedDurableStageDef[] = [
    {
      stage: "invalid_noncanonical",
      items: partitions.invalidOrNoncanonical,
      process: processInvalidOrNoncanonicalDurable,
    },
    {
      stage: "missing",
      items: partitions.missing,
      process: processMissingDurable,
      previewFilter: shouldPreviewMissingDurable,
    },
    {
      stage: "suspect_canonical",
      items: partitions.suspect,
      process: processSuspectDurable,
      previewFilter: shouldPreloadSuspectSuggestion,
    },
  ];

  return [
    ...durableStageDefs.map(buildInspectedDurableStageRunner),
    (ctx) =>
      runReconcileStage(ctx, {
        stage: "entity_family_convergence",
        items: detectClaimKeyEntityFamilyCandidates(ctx.workingSet.projectedDurables),
        unitLabel: "groups",
        process: processEntityFamilyConvergenceCandidate,
        afterItem: (passCtx, candidate) => {
          for (const claimKey of candidate.claimKeys) {
            passCtx.workingSet.handledConvergenceClaimKeys.add(claimKey);
          }
        },
      }),
    (ctx) =>
      runReconcileStage(ctx, {
        stage: "claim_key_alias_convergence",
        items: detectDeepClaimKeyAliasCandidates(ctx),
        unitLabel: "groups",
        process: processClaimKeyAliasConvergenceCandidate,
        afterItem: (passCtx, candidate) => {
          for (const claimKey of candidate.claimKeys) {
            passCtx.workingSet.handledConvergenceClaimKeys.add(claimKey);
          }
        },
      }),
    (ctx) =>
      runReconcileStage(ctx, {
        stage: "mixed_key_groups",
        items: findMixedKeyGroups(ctx.workingSet.projectedDurables, ctx.workingSet.handledConvergenceClaimKeys),
        unitLabel: "groups",
        process: processMixedKeyGroup,
      }),
  ];
}

/** Builds a runner for a durable-inspection stage with optional preview preload. */
function buildInspectedDurableStageRunner(def: InspectedDurableStageDef): ReconcileStageRunner {
  return (ctx) => {
    const preloadEnabled = shouldPreloadSuggestions(ctx);
    const previewItems = def.previewFilter && preloadEnabled ? def.items.filter((item) => def.previewFilter!(ctx, item)) : [];

    return runReconcileStage(ctx, {
      stage: def.stage,
      items: def.items,
      unitLabel: "durables",
      preview:
        def.previewFilter && preloadEnabled
          ? {
              items: previewItems,
              concurrency: previewItems.length > 0 ? ctx.extraction.previewConcurrency : undefined,
            }
          : undefined,
      preload: def.previewFilter
        ? (ctx, items) =>
            preloadSuggestionsForStage(
              ctx,
              items.map((item) => item.durable),
            )
        : undefined,
      process: def.process,
    });
  };
}
