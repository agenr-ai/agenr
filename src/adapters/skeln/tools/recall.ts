import type { ExtensionAPI, ExtensionContext } from "../skeln-types.js";

import { formatUnifiedRecallResults } from "../../shared/recall-format.js";
import { buildSkelnRecallToolDescription, buildSkelnRecallToolGuidelines } from "../../shared/memory-prompt-doctrine.js";
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
    description: buildSkelnRecallToolDescription(),
    promptSnippet: "Use agenr_recall to retrieve durable memory, prior episode summaries, or canonical procedures from agenr.",
    promptGuidelines: buildSkelnRecallToolGuidelines(),
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
