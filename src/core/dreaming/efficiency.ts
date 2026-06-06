import type { DreamCompletionSummary, DreamEfficiencySummary } from "./types.js";

const PROFILE_DURABLE_TOKEN_ESTIMATE = 36;
const PROFILE_DIRECTIVE_TOKEN_ESTIMATE = 24;

/** Input counters used to build one dreaming compute-efficiency summary. */
export interface DreamEfficiencySummaryInput {
  /** Evidence counters scanned during the run. */
  scan: NonNullable<DreamCompletionSummary["scan"]>;
  /** Estimated model cost for the run in USD. */
  estimatedCostUsd: number;
  /** Durable mutations synthesized by extract, temporalize, and prune stages. */
  synthesizedDurableMutations: number;
  /** Number of durable profile entries projected for session injection. */
  profileDurableCount: number;
  /** Number of directive entries projected with the profile. */
  directiveCount: number;
}

/**
 * Builds production dreaming compute-efficiency telemetry from stage counters.
 *
 * @param input - Stage counters and model spend for one completed run.
 * @returns Normalized compute-efficiency summary.
 */
export function buildDreamEfficiencySummary(input: DreamEfficiencySummaryInput): DreamEfficiencySummary {
  const evidenceItemsRead = input.scan.episodesSinceLastRun + input.scan.ingestFilesSinceLastRun + input.scan.durablesCreatedSinceLastRun;
  const profileInjectionTokenEstimate = estimateProfileInjectionTokens(input.profileDurableCount, input.directiveCount);

  return {
    evidenceItemsRead,
    synthesizedDurableMutations: input.synthesizedDurableMutations,
    costPerSynthesizedDurableUsd:
      input.synthesizedDurableMutations > 0 ? roundEfficiencyMetric(input.estimatedCostUsd / input.synthesizedDurableMutations) : null,
    profileInjectionTokenEstimate,
    recomputeRatio: evidenceItemsRead === 0 ? 0 : roundEfficiencyMetric(input.synthesizedDurableMutations / evidenceItemsRead),
  };
}

/**
 * Derives compute-efficiency telemetry from a persisted completion summary.
 *
 * @param summary - Persisted dreaming completion summary.
 * @param estimatedCostUsd - Persisted run cost in USD.
 * @returns Derived efficiency telemetry, or null when required stage counters are missing.
 */
export function deriveDreamEfficiencySummary(summary: DreamCompletionSummary, estimatedCostUsd: number): DreamEfficiencySummary | null {
  if (!summary.scan || !summary.project) {
    return null;
  }

  return buildDreamEfficiencySummary({
    scan: summary.scan,
    estimatedCostUsd,
    synthesizedDurableMutations: countSynthesizedDurableMutations(summary),
    profileDurableCount: summary.project.profileDurableCount,
    directiveCount: summary.project.directiveCount,
  });
}

/**
 * Counts durable mutations synthesized by one persisted dreaming summary.
 *
 * @param summary - Persisted dreaming completion summary.
 * @returns Durable writes and stale actions emitted by the run.
 */
export function countSynthesizedDurableMutations(summary: DreamCompletionSummary): number {
  return (summary.extract?.durablesInserted ?? 0) + (summary.temporalize?.revisionsApplied ?? 0) + (summary.prune?.durablesStaled ?? 0);
}

/**
 * Estimates prompt tokens needed for profile and directive injection.
 *
 * @param profileDurableCount - Number of profile durable entries.
 * @param directiveCount - Number of directive entries.
 * @returns Approximate prompt-token cost for profile injection.
 */
export function estimateProfileInjectionTokens(profileDurableCount: number, directiveCount: number): number {
  return profileDurableCount * PROFILE_DURABLE_TOKEN_ESTIMATE + directiveCount * PROFILE_DIRECTIVE_TOKEN_ESTIMATE;
}

/**
 * Rounds efficiency telemetry to the persisted precision.
 *
 * @param value - Raw metric value.
 * @returns Metric rounded to six decimals.
 */
export function roundEfficiencyMetric(value: number): number {
  return Number(value.toFixed(6));
}
