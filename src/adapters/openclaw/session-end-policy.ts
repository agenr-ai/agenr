import type { AgenrOpenClawSessionEndEvent } from "./types.js";

/** OpenClaw session_end handling derived from the host reason. */
export interface OpenClawSessionEndPolicy {
  /** Whether session-memory intake should run on this session_end. */
  routeMemoryIntake: boolean;
  /** Whether automatic session-end episode capture should run. */
  captureEpisode: boolean;
}

/**
 * Resolves session-memory intake and episode-capture behavior for one OpenClaw session_end.
 *
 * Compaction session ends skip both paths because pre-compaction hooks already captured
 * the full transcript snapshot and recorded the checkpoint.
 *
 * @param reason - OpenClaw session-end reason when present.
 * @returns Policy flags consumed by the session_end hook and capture orchestration.
 */
export function resolveOpenClawSessionEndPolicy(reason: AgenrOpenClawSessionEndEvent["reason"]): OpenClawSessionEndPolicy {
  const isCompaction = reason === "compaction";
  return {
    routeMemoryIntake: !isCompaction,
    captureEpisode: !isCompaction,
  };
}
