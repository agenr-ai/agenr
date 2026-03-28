import type { PluginLogger } from "openclaw/plugin-sdk/core";

import type { AgenrOpenClawMemoryFlushPlanResolver } from "../types.js";

/**
 * Phase 1 does not take over transcript flush/compaction.
 *
 * Returning `null` keeps the agenr memory slot active without introducing the
 * Phase 2 handoff and flush behavior yet.
 *
 * @param _params - OpenClaw runtime metadata for flush-plan resolution.
 * @param logger - Host logger supplied by the OpenClaw plugin runtime.
 * @returns Always `null` in Phase 1.
 */
export function buildAgenrMemoryFlushPlan(
  _params: Parameters<AgenrOpenClawMemoryFlushPlanResolver>[0],
  logger: PluginLogger,
): ReturnType<AgenrOpenClawMemoryFlushPlanResolver> {
  logger.debug?.("[agenr] flush-plan: Phase 1 pass-through (no flush)");
  return null;
}
