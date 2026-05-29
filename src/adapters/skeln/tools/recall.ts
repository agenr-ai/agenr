import type { ExtensionAPI, ExtensionContext } from "skeln";

import { formatUnifiedRecallResults } from "../../shared/recall-format.js";
import {
  RECALL_TOOL_PARAMETERS,
  buildRecallToolDetails,
  buildRecallToolServices,
  parseRecallToolParams,
  runRecallMemoryTool,
} from "../../shared/memory-tools.js";
import type { AgenrSkelnServices } from "../runtime.js";
import type { AgenrSkelnSessionScope } from "../types.js";
import { SKELN_PARAM_READER, textToolResult, toolFailureResult, toolSchema } from "./shared.js";

/** Registers the Skeln-native agenr_recall tool. */
export function registerAgenrSkelnRecallTool(
  skeln: ExtensionAPI,
  servicesPromise: Promise<AgenrSkelnServices>,
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
): void {
  skeln.registerTool({
    name: "agenr_recall",
    label: "Agenr Recall",
    description:
      "Retrieve knowledge from agenr long-term memory. Use mode=auto for normal use, including exact facts, historical-state questions, time-bounded episode questions, and procedural questions.",
    promptSnippet: "Use agenr_recall to retrieve durable memory, prior episode summaries, or canonical procedures from agenr.",
    promptGuidelines: [
      "Use focused natural-language queries instead of broad 'everything' searches.",
      "Use mode=procedures for how-to or checklist questions, and mode=episodes for what-happened questions tied to time or sessions.",
      "Use asOf when the user asks what was true at an earlier point in time.",
    ],
    parameters: toolSchema(RECALL_TOOL_PARAMETERS),
    execute: async (_toolCallId, rawParams, _signal, _onUpdate, context) => {
      try {
        const params = parseRecallToolParams(rawParams, SKELN_PARAM_READER);
        const [services, scope] = await Promise.all([servicesPromise, resolveScope(context)]);
        const result = await runRecallMemoryTool(params, buildRecallToolServices(services), {
          sessionKey: scope.sessionKey,
          slotPolicyConfig: services.skelnConfig.memoryPolicy?.slotPolicies,
        });

        return textToolResult(formatUnifiedRecallResults(result), buildRecallToolDetails(result, { sessionKey: scope.sessionKey }));
      } catch (error) {
        return toolFailureResult(error);
      }
    },
  });
}
