import type { AgenrOpenClawMemoryFlushPlanResolver } from "../types.js";

/**
 * Phase 1 does not take over transcript flush/compaction.
 *
 * Returning `null` keeps the agenr memory slot active without introducing the
 * Phase 2 handoff and flush behavior yet.
 *
 * @param _params - OpenClaw runtime metadata for flush-plan resolution.
 * @returns Always `null` in Phase 1.
 */
export function buildAgenrMemoryFlushPlan(_params: Parameters<AgenrOpenClawMemoryFlushPlanResolver>[0]): ReturnType<AgenrOpenClawMemoryFlushPlanResolver> {
  return null;
}
