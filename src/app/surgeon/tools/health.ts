import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

import type { SurgeonToolDeps } from "./index.js";
import { toolResult } from "./shared.js";

const GET_HEALTH_STATS_SCHEMA = Type.Object({});

/**
 * Creates the corpus-health inspection tool used at the start of a surgeon pass.
 *
 * @param deps - Shared run dependencies for surgeon tools.
 * @returns Agent tool that reports current health stats and the last run.
 */
export function createHealthStatsTool(deps: SurgeonToolDeps): AgentTool<typeof GET_HEALTH_STATS_SCHEMA> {
  return {
    name: "get_health_stats",
    label: "Get health stats",
    description: "Inspect current corpus health and the latest surgeon run summary.",
    parameters: GET_HEALTH_STATS_SCHEMA,
    async execute() {
      const [health, lastRun, lastBulkIngestAt] = await Promise.all([
        deps.port.getHealthStats({
          protectRecalledDays: deps.protection.protectRecalledDays,
          protectMinImportance: deps.protection.protectMinImportance,
          now: deps.now(),
        }),
        deps.port.getLastRun(),
        deps.port.getLastBulkIngestAt(),
      ]);

      return toolResult({
        now: deps.now().toISOString(),
        health,
        lastRun,
        lastBulkIngestAt,
      });
    },
  };
}
