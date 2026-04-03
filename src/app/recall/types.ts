import type { ResolvedTemporalWindow } from "../../core/episode/types.js";
import type { RecallOutput } from "../../core/recall/types.js";
import type { EntryType } from "../../core/types.js";

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
 * Unified recall response returned to OpenClaw tool adapters.
 */
export interface UnifiedRecallResult {
  routing: UnifiedRecallRouting;
  parsedTimeWindow?: ResolvedTemporalWindow;
  timeWindow?: UnifiedRecallTimeWindow;
  episodes: import("../../core/episode/types.js").EpisodeResult[];
  entries: RecallOutput[];
  notices: string[];
  count: number;
}
