import { resolveClaimExtractionConfig } from "../../../config.js";
import { isTrustedClaimKeyForCleanup } from "../../../core/claim-key.js";
import type { ReconcileRepairCounts } from "../../../core/dreaming/types.js";
import type { Durable } from "../../../core/types.js";
import { createEmptyClaimKeyInspectionTally, type ClaimKeyInspectionTally } from "./helpers/claim-key-health-tally.js";
import type { ExistingClaimKeyInspection } from "./helpers/claim-key-inspection.js";
import { createCircuitBreakerState } from "./helpers/circuit-breaker.js";
import { claimExtractionUsage, resolveClaimExtractionConcurrency } from "./helpers/claim-extraction.js";
import { cloneDurable } from "./helpers/durable.js";
import {
  createEmptyEntityFamilyConvergenceDecisionStats,
  createEmptyMissingBackfillDecisionStats,
  createEmptyRepairCounts,
  createEmptySiblingSlotResonanceShadowStats,
} from "./helpers/stats.js";
import { buildTrustedCleanupHintSeed } from "./helpers/trusted-hints.js";
import { normalizeOptionalString, normalizeStringArray } from "./helpers/utils.js";
import { createReconcileProgressTracker, type ReconcileProgressTracker } from "./progress-tracker.js";
import type {
  ClaimExtractionPreviewLlm,
  ClaimKeyCircuitBreakerState,
  ClaimKeyCircuitBreakerTrip,
  DurableSuggestionRecord,
  EntityFamilyConvergenceDecisionStats,
  MissingBackfillDecisionStats,
  MissingBackfillSkipDiagnostic,
  ReconcileRunDeps,
  ReconcileRunOptions,
  ReconcileSelection,
  SiblingSlotResonanceShadowStats,
  TrustedCleanupHintSeed,
} from "./types.js";
import type { DreamRunStatus } from "../../../core/dreaming/types.js";

/**
 * Loaded durables and trusted reuse state shared across reconcile stages.
 */
export interface ReconcileWorkingSet {
  selection: ReconcileSelection;
  projectedDurables: Durable[];
  actualDurables: Durable[];
  durablesById: Map<string, Durable>;
  actualDurablesById: Map<string, Durable>;
  trustedHints: TrustedCleanupHintSeed;
  trustedReusableDurableIds: Set<string>;
  handledEntityFamilyClaimKeys: Set<string>;
  projectedInspectionById: Map<string, ExistingClaimKeyInspection>;
  actualInspectionById: Map<string, ExistingClaimKeyInspection>;
  projectedInspectionTally: ClaimKeyInspectionTally;
  actualInspectionTally: ClaimKeyInspectionTally;
}

/**
 * Claim-extraction preview runtime state for one reconcile pass.
 */
export interface ReconcileExtractionRuntime {
  claimExtractionConfig: ReturnType<typeof resolveClaimExtractionConfig>;
  previewConcurrency: number;
  suggestionCache: Map<string, DurableSuggestionRecord>;
  claimExtractionLlms: ClaimExtractionPreviewLlm[];
  fallbackClaimExtractionLlm: ClaimExtractionPreviewLlm | null | undefined;
}

/**
 * Mutable counters, diagnostics, and terminal state for one reconcile pass.
 */
export interface ReconcilePassTelemetry {
  counts: ReconcileRepairCounts;
  observations: string[];
  recommendations: string[];
  missingDecisionStats: MissingBackfillDecisionStats;
  siblingSlotResonanceShadowStats: SiblingSlotResonanceShadowStats;
  entityFamilyDecisionStats: EntityFamilyConvergenceDecisionStats;
  skippedDiagnostics: MissingBackfillSkipDiagnostic[];
  circuitBreakerState: ClaimKeyCircuitBreakerState;
  circuitBreaker: ClaimKeyCircuitBreakerTrip | null;
  terminalStatus: DreamRunStatus;
  terminalError: string | null;
  actionsTaken: number;
}

/**
 * Mutable execution context shared across reconcile pass handlers.
 */
export interface ReconcilePassContext {
  options: ReconcileRunOptions;
  deps: ReconcileRunDeps;
  workingSet: ReconcileWorkingSet;
  extraction: ReconcileExtractionRuntime;
  telemetry: ReconcilePassTelemetry;
  progressTracker: ReconcileProgressTracker;
}

/**
 * Creates the mutable reconcile pass context from run options and dependencies.
 *
 * @param options - Reconcile pass selection and safety options.
 * @param deps - Database and optional claim-extraction dependencies.
 * @returns Initialized pass context with working-set durables loaded.
 */
export async function createReconcilePassContext(options: ReconcileRunOptions, deps: ReconcileRunDeps): Promise<ReconcilePassContext> {
  const selection: ReconcileSelection = {
    includeInactive: options.includeInactive === true,
    project: normalizeOptionalString(options.project) ?? null,
    type: normalizeOptionalString(options.type) ?? null,
    claimKeyPrefix: normalizeOptionalString(options.claimKeyPrefix) ?? null,
    durableIds: normalizeStringArray(options.durableIds ?? []),
  };

  const sourceDurables = await deps.port.listReconcileDurables({
    project: selection.project ?? undefined,
    type: selection.type ?? undefined,
    claimKeyPrefix: selection.claimKeyPrefix ?? undefined,
    durableIds: selection.durableIds,
    includeInactive: selection.includeInactive,
  });
  const actualDurables = sourceDurables.map((durable) => cloneDurable(durable));
  const projectedDurables = sourceDurables.map((durable) => cloneDurable(durable));
  const durablesById = new Map(projectedDurables.map((durable) => [durable.id, durable]));
  const actualDurablesById = new Map(actualDurables.map((durable) => [durable.id, durable]));
  const counts = createEmptyRepairCounts();
  const claimExtractionConfig = resolveClaimExtractionConfig(deps.config ?? undefined);
  const previewConcurrency = resolveClaimExtractionConcurrency(claimExtractionConfig);
  const trustedHints = buildTrustedCleanupHintSeed(actualDurables);
  const trustedReusableDurableIds = new Set(
    sourceDurables.flatMap((durable) => {
      const claimKey = durable.claim_key?.trim();
      return claimKey && isTrustedClaimKeyForCleanup(claimKey) ? [durable.id] : [];
    }),
  );

  const progressTracker = createReconcileProgressTracker({
    tier: options.tier,
    apply: options.apply,
    verbose: options.verbose,
    totalDurables: actualDurables.length,
    counts,
    reportProgress: options.reportProgress,
  });

  return {
    options,
    deps,
    workingSet: {
      selection,
      projectedDurables,
      actualDurables,
      durablesById,
      actualDurablesById,
      trustedHints,
      trustedReusableDurableIds,
      handledEntityFamilyClaimKeys: new Set<string>(),
      projectedInspectionById: new Map<string, ExistingClaimKeyInspection>(),
      actualInspectionById: new Map<string, ExistingClaimKeyInspection>(),
      projectedInspectionTally: createEmptyClaimKeyInspectionTally(),
      actualInspectionTally: createEmptyClaimKeyInspectionTally(),
    },
    extraction: {
      claimExtractionConfig,
      previewConcurrency,
      suggestionCache: new Map<string, DurableSuggestionRecord>(),
      claimExtractionLlms: [],
      fallbackClaimExtractionLlm: undefined,
    },
    telemetry: {
      counts,
      observations: [],
      recommendations: [],
      missingDecisionStats: createEmptyMissingBackfillDecisionStats(),
      siblingSlotResonanceShadowStats: createEmptySiblingSlotResonanceShadowStats(),
      entityFamilyDecisionStats: createEmptyEntityFamilyConvergenceDecisionStats(),
      skippedDiagnostics: [],
      circuitBreakerState: createCircuitBreakerState(),
      circuitBreaker: null,
      terminalStatus: "completed",
      terminalError: null,
      actionsTaken: 0,
    },
    progressTracker,
  };
}

export function getClaimExtractionUsage(ctx: ReconcilePassContext): ReturnType<typeof claimExtractionUsage> {
  return claimExtractionUsage(ctx.extraction.claimExtractionLlms);
}
