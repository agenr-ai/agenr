/** Minimum material turns or duration required before episode ingest proceeds. */
export interface EpisodeActivityThreshold {
  /** Minimum user and assistant turns. */
  minMaterialTurns: number;
  /** Minimum session duration in milliseconds. */
  minDurationMs: number;
}

/** Eligibility facts for one activity-threshold evaluation. */
export type EpisodeActivityEligibility =
  | {
      /** Whether the transcript met the activity threshold. */
      eligible: true;
      /** Count of material transcript turns. */
      materialTurns: number;
      /** Session duration in milliseconds when timestamps are usable. */
      durationMs: number;
    }
  | {
      /** Whether the transcript met the activity threshold. */
      eligible: false;
      /** Stable skip reason for logs and tests. */
      reason: "below_activity_threshold";
      /** Count of material transcript turns. */
      materialTurns: number;
      /** Session duration in milliseconds when timestamps are usable. */
      durationMs: number;
    };

/**
 * Resolves whether one transcript satisfies an optional activity threshold.
 *
 * @param materialTurns - Count of non-empty user or assistant messages.
 * @param startedAt - Session start timestamp when available.
 * @param endedAt - Session end timestamp when available.
 * @param threshold - Minimum turns or duration required to proceed.
 * @returns Eligibility decision and threshold facts.
 */
export function resolveEpisodeActivityEligibility(
  materialTurns: number,
  startedAt: string | undefined,
  endedAt: string | undefined,
  threshold: EpisodeActivityThreshold,
): EpisodeActivityEligibility {
  const durationMs = resolveTranscriptDurationMs(startedAt, endedAt);

  if (materialTurns >= threshold.minMaterialTurns || durationMs >= threshold.minDurationMs) {
    return {
      eligible: true,
      materialTurns,
      durationMs,
    };
  }

  return {
    eligible: false,
    reason: "below_activity_threshold",
    materialTurns,
    durationMs,
  };
}

/** Computes transcript duration in milliseconds when timestamps are usable. */
function resolveTranscriptDurationMs(startedAt: string | undefined, endedAt: string | undefined): number {
  if (!startedAt || !endedAt) {
    return 0;
  }

  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  return Number.isFinite(started) && Number.isFinite(ended) && ended > started ? ended - started : 0;
}
