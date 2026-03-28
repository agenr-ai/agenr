import type { PluginLogger } from "openclaw/plugin-sdk/core";

import type { AgenrOpenClawMemoryFlushPlanResolver } from "../types.js";

/**
 * The v1 OpenClaw adapter does not take over transcript flush or compaction.
 *
 * Returning `null` keeps the agenr memory slot active while OpenClaw's
 * existing transcript lifecycle continues to manage compaction.
 *
 * @param _params - OpenClaw runtime metadata for flush-plan resolution.
 * @param logger - Host logger supplied by the OpenClaw plugin runtime.
 * @returns Always `null` for the current plugin phases.
 */
export function buildAgenrMemoryFlushPlan(
  _params: Parameters<AgenrOpenClawMemoryFlushPlanResolver>[0],
  logger: PluginLogger,
): ReturnType<AgenrOpenClawMemoryFlushPlanResolver> {
  logger.debug?.("[agenr] flush-plan: pass-through (no custom flush)");
  return null;
}
