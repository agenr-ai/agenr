import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";

import type { SurgeonToolDeps } from "./index.js";
import { toolResult } from "./shared.js";

const INSPECT_ENTRY_SCHEMA = Type.Object({
  entry_id: Type.String({ minLength: 1 }),
});

/** Validated parameter payload for the inspect tool. */
type InspectEntryParams = Static<typeof INSPECT_ENTRY_SCHEMA>;

/**
 * Creates the detailed entry-inspection tool used before retirement decisions.
 *
 * @param deps - Shared run dependencies for surgeon tools.
 * @returns Agent tool that loads one entry plus related-entry context.
 */
export function createInspectEntryTool(deps: SurgeonToolDeps): AgentTool<typeof INSPECT_ENTRY_SCHEMA> {
  return {
    name: "inspect_entry",
    label: "Inspect entry",
    description: "Inspect one entry in detail, including same-subject, same-cluster, and reverse-supersession context.",
    parameters: INSPECT_ENTRY_SCHEMA,
    async execute(_toolCallId, params: InspectEntryParams) {
      if (deps.passType === "retirement") {
        deps.completionGuards?.retirement.recordReviewedEntries([params.entry_id]);
      }
      const inspection = await deps.port.inspectEntry(params.entry_id);

      return toolResult({
        found: inspection !== null,
        entry: inspection?.entry ?? null,
        tags: inspection?.tags ?? [],
        related: inspection?.related ?? null,
      });
    },
  };
}
