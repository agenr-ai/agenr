import type { ExtensionAPI, ExtensionContext } from "../skeln-types.js";

import { maybeRunLightDream } from "../../../app/dreaming/background-triggers.js";
import { formatErrorMessage } from "../../shared/errors.js";
import { STORE_TOOL_PARAMETERS, parseStoreToolParams, runStoreMemoryTool } from "../../shared/memory-tools.js";
import type { AgenrSkelnServices } from "../runtime.js";
import type { AgenrSkelnSessionScope } from "../types.js";
import { SKELN_PARAM_READER, toSkelnToolResult, toolFailureResult, toolSchema } from "./shared.js";

/** Registers the Skeln-native agenr_store tool. */
export function registerAgenrSkelnStoreTool(
  skeln: ExtensionAPI,
  servicesPromise: Promise<AgenrSkelnServices>,
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
): void {
  skeln.registerTool({
    name: "agenr_store",
    label: "Agenr Store",
    description:
      "Store a new durable memory entry in agenr. Store only durable facts, decisions, preferences, lessons, milestones, and relationships that help a future Skeln session make a better decision.",
    promptSnippet: "Use agenr_store to persist durable memory that should survive across Skeln sessions.",
    promptGuidelines: [
      "Do not store progress logs, plans, or data already canonical in git, tickets, calendars, signed docs, chat/email, or databases.",
      "Store the durable takeaway, standing rule, preference, risk, lesson, or relationship instead of raw activity.",
      "Use claimKey for slot-like facts that may be superseded later, such as versions, strategies, owners, or limits.",
    ],
    parameters: toolSchema(STORE_TOOL_PARAMETERS),
    execute: async (_toolCallId, rawParams, _signal, _onUpdate, context) => {
      try {
        const params = parseStoreToolParams(rawParams, SKELN_PARAM_READER);
        const [services, scope] = await Promise.all([servicesPromise, resolveScope(context)]);
        const outcome = await runStoreMemoryTool(params, services, {
          session: scope,
          sourcePrefix: "skeln-session",
          defaultSourceContext: "Stored via agenr_store from Skeln.",
          extraDetails: { sessionKey: scope.sessionKey },
          onWarning: (warning) => console.warn(`[agenr] tool=agenr_store session=${scope.sessionId} warning: ${warning}`),
        });
        triggerSkelnImportanceLightDream(services, outcome.details.status);
        return toSkelnToolResult(outcome);
      } catch (error) {
        return toolFailureResult(error);
      }
    },
  });
}

/** Triggers a Skeln light dream after an important store result. */
function triggerSkelnImportanceLightDream(services: AgenrSkelnServices, status: unknown): void {
  if (status !== "stored") {
    return;
  }

  void maybeRunLightDream(
    { trigger: "importance" },
    {
      port: services.dreaming,
      config: services.agenrConfig,
      embedding: services.embedding,
      ...(services.claimExtraction ? { createClaimExtractionLlm: () => services.claimExtraction!.llm } : {}),
    },
  )
    .then((result) => {
      if (result.status === "ran") {
        console.info(`[agenr] skeln importance light dream completed run=${result.result.runId}`);
      }
    })
    .catch((error: unknown) => {
      console.warn(`[agenr] skeln importance light dream failed: ${formatErrorMessage(error)}`);
    });
}
