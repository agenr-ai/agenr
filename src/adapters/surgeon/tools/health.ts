import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

import { getLastSurgeonRun } from "../../db/surgeon-run-log.js";
import { getSurgeonHealthStats } from "../../db/surgeon-queries.js";
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
      const [health, lastRun] = await Promise.all([
        getSurgeonHealthStats(deps.executor, {
          protectRecalledDays: deps.protection.protectRecalledDays,
          protectMinImportance: deps.protection.protectMinImportance,
          now: deps.now(),
        }),
        getLastSurgeonRun(deps.executor),
      ]);

      return toolResult({
        now: deps.now().toISOString(),
        health,
        lastRun,
      });
    },
  };
}
