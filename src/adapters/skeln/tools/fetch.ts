import type { ExtensionAPI, ExtensionContext } from "../skeln-types.js";

import { formatTargetSelector, sanitizeFetchToolParams } from "../../shared/durable-tools.js";
import { MEMORY_DOCTRINE } from "../../shared/memory-prompt-doctrine.js";
import { FETCH_TOOL_PARAMETERS, parseFetchToolParams, runFetchMemoryTool } from "../../shared/memory-tools.js";
import type { AgenrSkelnServices } from "../runtime.js";
import type { AgenrSkelnSessionScope } from "../types.js";
import { SKELN_PARAM_READER, toSkelnToolResult, toolFailureResult, toolSchema } from "./shared.js";

/** Registers the Skeln-native agenr_fetch tool. */
export function registerAgenrSkelnFetchTool(
  skeln: ExtensionAPI,
  servicesPromise: Promise<AgenrSkelnServices>,
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
): void {
  skeln.registerTool({
    name: "agenr_fetch",
    label: "Agenr Fetch",
    description: "Fetch the full body and metadata for one durable memory by id or subject.",
    promptSnippet: "Use agenr_fetch after agenr_recall when you need the full entry body for an id shown in recall results.",
    promptGuidelines: [MEMORY_DOCTRINE.update.targetSelector, MEMORY_DOCTRINE.fetch.preferId],
    parameters: toolSchema(FETCH_TOOL_PARAMETERS),
    execute: async (_toolCallId, rawParams, _signal, _onUpdate, context) => {
      try {
        const params = parseFetchToolParams(rawParams, SKELN_PARAM_READER);
        const [services, scope] = await Promise.all([servicesPromise, resolveScope(context)]);
        const outcome = await runFetchMemoryTool(params, services, {
          extraDetails: { sessionKey: scope.sessionKey },
        });

        return toSkelnToolResult({
          ...outcome,
          details: {
            ...outcome.details,
            target: formatTargetSelector(params.id, params.subject),
            sanitized: sanitizeFetchToolParams(params),
          },
        });
      } catch (error) {
        return toolFailureResult(error);
      }
    },
  });
}
