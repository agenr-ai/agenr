import type { ExtensionAPI, ExtensionContext } from "../skeln-types.js";

import { UPDATE_TOOL_PARAMETERS, parseUpdateToolParams, runUpdateMemoryTool } from "../../shared/memory-tools.js";
import { formatTargetSelector, sanitizeUpdateToolParams } from "../../shared/entry-tools.js";
import type { AgenrSkelnServices } from "../runtime.js";
import type { AgenrSkelnSessionScope } from "../types.js";
import { SKELN_PARAM_READER, toSkelnToolResult, toolFailureResult, toolSchema } from "./shared.js";

/** Registers the Skeln-native agenr_update tool. */
export function registerAgenrSkelnUpdateTool(
  skeln: ExtensionAPI,
  servicesPromise: Promise<AgenrSkelnServices>,
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
): void {
  skeln.registerTool({
    name: "agenr_update",
    label: "Agenr Update",
    description: "Update an existing memory entry in place. Supports metadata corrections: importance, expiry, claimKey, validFrom, validTo, and project.",
    promptSnippet: "Use agenr_update to correct metadata on an existing durable memory entry.",
    promptGuidelines: ["Provide exactly one target selector: id or subject.", "Use agenr_store with supersedes for substantive content replacement."],
    parameters: toolSchema(UPDATE_TOOL_PARAMETERS),
    execute: async (_toolCallId, rawParams, _signal, _onUpdate, context) => {
      try {
        const params = parseUpdateToolParams(rawParams, SKELN_PARAM_READER);
        const [services, scope] = await Promise.all([servicesPromise, resolveScope(context)]);
        const outcome = await runUpdateMemoryTool(params, services, {
          session: scope,
          sourcePrefix: "skeln-session",
          successDetails: { sessionKey: scope.sessionKey },
          failureDetails: { sessionKey: scope.sessionKey },
        });

        return toSkelnToolResult({
          ...outcome,
          details: {
            ...outcome.details,
            target: formatTargetSelector(params.id, params.subject),
            sanitized: sanitizeUpdateToolParams({
              id: params.id,
              subject: params.subject,
              importance: params.importance,
              expiry: params.expiry,
              claimKey: params.claimKeyInput,
              validFrom: params.validFrom,
              validTo: params.validTo,
              project: params.project,
            }),
          },
        });
      } catch (error) {
        return toolFailureResult(error);
      }
    },
  });
}
