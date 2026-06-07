import type { AgenrOpenClawSessionEndEvent } from "../types.js";

/**
 * Returns whether OpenClaw session_end should skip session-memory intake and
 * automatic episode capture because compaction hooks already handled the session.
 *
 * @param reason - OpenClaw session-end reason when present.
 * @returns True when compaction already captured the session snapshot.
 */
export function isOpenClawSessionEndCompaction(reason: AgenrOpenClawSessionEndEvent["reason"]): boolean {
  return reason === "compaction";
}
