import type { ExtensionAPI, ExtensionContext } from "../skeln-types.js";

import { parseWorkToolParams, runWorkMemoryTool, WORK_TOOL_PARAMETERS } from "../../shared/work-tools.js";
import { toWorkingScopeFromSkelnSession } from "../session/scope.js";
import type { AgenrSkelnServices } from "../runtime.js";
import type { AgenrSkelnSessionScope } from "../types.js";
import { SKELN_PARAM_READER, textToolResult, toolFailureResult, toolSchema } from "./shared.js";

/** Registers the Skeln-native agenr_work tool. */
export function registerAgenrSkelnWorkTool(
  skeln: ExtensionAPI,
  servicesPromise: Promise<AgenrSkelnServices>,
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
): void {
  skeln.registerTool({
    name: "agenr_work",
    label: "Agenr Work",
    description:
      "Read or update transient working memory for the active task. Use this for task state, checkpoints, next actions, files, commands, blockers, and close handoff candidates, not durable facts.",
    promptSnippet: "Use agenr_work to keep active task state current without storing transient work in durable memory.",
    promptGuidelines: [
      "Use create with set_objective to start a new scoped working set only when no goal exists for the scope, including completed goals awaiting user clear.",
      "Use update only for material task-state changes, and always pass expectedRevision plus updateReason.",
      "Use merge_checkpoint before pausing, compacting, handing off, forking, or waiting.",
      "Do not call close; only the user clears goals with /goal clear.",
      "After delivering results, leave the working set open and record progress with merge_checkpoint.",
      "Do not use agenr_store for transient WIP.",
    ],
    parameters: toolSchema(WORK_TOOL_PARAMETERS),
    execute: async (_toolCallId, rawParams, _signal, _onUpdate, context) => {
      try {
        const [services, scope] = await Promise.all([servicesPromise, resolveScope(context)]);
        const params = parseWorkToolParams(rawParams, toWorkingScopeFromSkelnSession(scope), SKELN_PARAM_READER);
        const outcome = await runWorkMemoryTool(params, services.workingMemory);
        return textToolResult(outcome.text, outcome.details);
      } catch (error) {
        return toolFailureResult(error);
      }
    },
  });
}
