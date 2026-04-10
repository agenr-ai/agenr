import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";

import { recall } from "../../../core/recall/search.js";
import type { RecallPorts } from "../../../core/ports.js";
import type { SurgeonToolDeps } from "./index.js";
import { toolResult } from "./shared.js";

const SIMULATE_RECALL_SCHEMA = Type.Object({
  query: Type.String({ minLength: 1 }),
  exclude_entry_id: Type.Optional(
    Type.String({
      description: "Entry ID to exclude from results, simulating what recall would look like if this entry were retired.",
    }),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
});

/** Validated parameter payload for the recall-simulation tool. */
type SimulateRecallParams = Static<typeof SIMULATE_RECALL_SCHEMA>;

/**
 * Creates the no-telemetry recall-simulation tool.
 *
 * @param deps - Shared run dependencies for surgeon tools.
 * @returns Agent tool that simulates recall without writing telemetry.
 */
export function createSimulateRecallTool(deps: SurgeonToolDeps): AgentTool<typeof SIMULATE_RECALL_SCHEMA> {
  return {
    name: "simulate_recall",
    label: "Simulate recall",
    description: "Run recall without recording telemetry, optionally excluding one entry from the result set.",
    parameters: SIMULATE_RECALL_SCHEMA,
    async execute(_toolCallId, params: SimulateRecallParams) {
      if (!deps.recallPorts) {
        throw new Error("Recall simulation is unavailable because no embedding-enabled recall ports are configured.");
      }

      const excludeEntryId = normalizeOptionalString(params.exclude_entry_id);
      const results = await recall(
        {
          text: params.query.trim(),
          limit: normalizeLimit(params.limit),
        },
        createSimulationRecallPorts(deps.recallPorts, excludeEntryId),
      );

      return toolResult({
        query: params.query.trim(),
        excludeEntryId: excludeEntryId ?? null,
        count: results.length,
        results,
      });
    },
  };
}

/**
 * Wraps recall ports for no-telemetry simulation and optional target exclusion.
 *
 * @param inner - Real recall ports used for retrieval and hydration.
 * @param excludeEntryId - Optional entry ID to omit from all simulated results.
 * @returns Wrapped recall ports safe for simulation.
 */
function createSimulationRecallPorts(inner: RecallPorts, excludeEntryId?: string): RecallPorts {
  return {
    embed: (text) => inner.embed(text),
    async vectorSearch(params) {
      const results = await inner.vectorSearch(params);
      if (!excludeEntryId) {
        return results;
      }

      return results.filter((result) => result.entry.id !== excludeEntryId);
    },
    async ftsSearch(params) {
      const results = await inner.ftsSearch(params);
      if (!excludeEntryId) {
        return results;
      }

      return results.filter((result) => result.entry.id !== excludeEntryId);
    },
    async fetchPredecessors(params) {
      if (!inner.fetchPredecessors) {
        return [];
      }

      const activeEntryIds = excludeEntryId ? params.activeEntryIds.filter((id) => id !== excludeEntryId) : params.activeEntryIds;
      if (activeEntryIds.length === 0) {
        return [];
      }

      const results = await inner.fetchPredecessors({
        ...params,
        activeEntryIds,
      });
      if (!excludeEntryId) {
        return results;
      }

      return results.filter((result) => result.id !== excludeEntryId);
    },
    async hydrateEntries(ids) {
      const filteredIds = excludeEntryId ? ids.filter((id) => id !== excludeEntryId) : ids;
      return inner.hydrateEntries(filteredIds);
    },
    async recordRecallEvents() {
      // Simulation must not write recall telemetry.
    },
  };
}

/**
 * Normalizes the requested recall result limit.
 *
 * @param value - Raw limit input.
 * @returns Safe simulated recall limit.
 */
function normalizeLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 10;
  }

  return Math.floor(value);
}

/**
 * Trims optional string input and drops empty values.
 *
 * @param value - Raw string input.
 * @returns Trimmed value, or undefined when empty.
 */
function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
