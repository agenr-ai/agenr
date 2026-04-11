import type { ClaimSlotPolicy } from "../../core/claim-slot-policy.js";
import type { ResolvedTemporalWindow } from "../../core/episode/types.js";
import type { RecallOutput } from "../../core/recall/types.js";
import type { EntryType } from "../../core/types.js";
import type { ClaimCentricRecallEntry, ClaimCentricRecallFamily } from "./claim-centric.js";

/**
 * Agent-facing recall mode.
 */
export type UnifiedRecallMode = "auto" | "entries" | "episodes";

/**
 * Stable high-level intent buckets reported by the unified recall router.
 */
export type UnifiedRecallDetectedIntent = "temporal_narrative" | "factual" | "mixed" | "historical_state";

/**
 * Tool-level unified recall request.
 */
export interface UnifiedRecallInput {
  text: string;
  mode?: UnifiedRecallMode;
  limit?: number;
  threshold?: number;
  types?: EntryType[];
  tags?: string[];
  asOf?: string;
  sessionKey?: string;
}

/**
 * Structured routing explanation returned with every unified recall result.
 */
export interface UnifiedRecallRouting {
  requested: UnifiedRecallMode;
  detectedIntent: UnifiedRecallDetectedIntent;
  queried: Array<"episodes" | "entries">;
  reason: string;
}

/**
 * Tool-friendly temporal window metadata.
 */
export interface UnifiedRecallTimeWindow {
  start: string;
  end: string;
  timezone: string;
  resolvedFrom: string;
}

/**
 * Compact read-side explanation of a claim-family transition.
 */
export interface ClaimTransitionExplanation {
  /** Stable family key for the explained transition. */
  familyKey: string;
  /** Shared claim key when the family is keyed. */
  claimKey?: string;
  /** Runtime slot-policy class used while interpreting the family. */
  slotPolicy: ClaimSlotPolicy;
  /** Family subject shown to the caller. */
  subject: string;
  /** Current entry when one is visible in the recall result. */
  currentEntryId?: string;
  /** Prior entry when one is visible in the recall result. */
  priorEntryId?: string;
  /** Human-readable transition summary. */
  summary: string;
  /** Nearby episode context when one appears relevant. */
  episodeContext?: {
    episodeId: string;
    startedAt: string;
    endedAt?: string;
    summary: string;
  };
}

/**
 * Unified recall response returned to OpenClaw tool adapters.
 */
export interface UnifiedRecallResult {
  routing: UnifiedRecallRouting;
  parsedTimeWindow?: ResolvedTemporalWindow;
  timeWindow?: UnifiedRecallTimeWindow;
  asOf?: string;
  episodes: import("../../core/episode/types.js").EpisodeResult[];
  entries: RecallOutput[];
  projectedEntries: ClaimCentricRecallEntry[];
  entryFamilies: ClaimCentricRecallFamily[];
  claimTransitions: ClaimTransitionExplanation[];
  notices: string[];
  count: number;
}
