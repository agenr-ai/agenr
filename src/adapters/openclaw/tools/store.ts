import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginToolContext, PluginLogger } from "openclaw/plugin-sdk/core";

import { maybeRunLightDream } from "../../../app/dreaming/background-triggers.js";
import { buildOpenClawStoreToolDescription } from "../../shared/memory-prompt-doctrine.js";
import { STORE_TOOL_PARAMETERS, parseStoreToolParams, runStoreMemoryTool, sanitizeStoreToolParams } from "../../shared/memory-tools.js";
import type { AgenrOpenClawServices } from "../types.js";
import { formatErrorMessage } from "../logging.js";
import { OPENCLAW_PARAM_READER, logToolCall, logToolFailure, toOpenClawToolResult, toolFailureResult } from "./shared.js";

/**
 * Creates the agenr store tool bound to one OpenClaw session context.
 *
 * @param ctx - Trusted OpenClaw tool context.
 * @param servicesPromise - Shared agenr adapters reused for the process lifetime.
 * @param logger - Host logger supplied by the OpenClaw plugin runtime.
 * @returns Agent tool definition for `agenr_store`.
 */
export function createAgenrStoreTool(ctx: OpenClawPluginToolContext, servicesPromise: Promise<AgenrOpenClawServices>, logger: PluginLogger): AnyAgentTool {
  return {
    name: "agenr_store",
    label: "Agenr Store",
    description: buildOpenClawStoreToolDescription(),
    parameters: STORE_TOOL_PARAMETERS,
    async execute(_toolCallId, rawParams) {
      try {
        const params = parseStoreToolParams(rawParams, OPENCLAW_PARAM_READER);
        logToolCall(logger, "agenr_store", ctx, `store 1 entry subject=${JSON.stringify(params.subject)} type=${params.type}`, sanitizeStoreToolParams(params));

        const services = await servicesPromise;
        const outcome = await runStoreMemoryTool(params, services, {
          session: ctx,
          sourcePrefix: "openclaw-session",
          defaultSourceContext: "Stored via agenr_store from OpenClaw.",
          onWarning: (warning) => logger.warn(`[agenr] tool=agenr_store session=${ctx.sessionId ?? "unknown"} warning: ${warning}`),
        });
        triggerOpenClawImportanceLightDream(services, logger, outcome.details.status);
        return toOpenClawToolResult(outcome);
      } catch (error) {
        logToolFailure(logger, "agenr_store", ctx, error);
        return toolFailureResult(error);
      }
    },
  };
}

/** Triggers an OpenClaw light dream after an important store result. */
function triggerOpenClawImportanceLightDream(services: AgenrOpenClawServices, logger: PluginLogger, status: unknown): void {
  if (status !== "stored") {
    return;
  }

  void maybeRunLightDream(
    { trigger: "importance" },
    {
      port: services.dreaming,
      dbPath: services.config.dbPath,
      config: services.agenrConfig,
      embedding: services.embedding,
      ...(services.claimExtraction ? { createClaimExtractionLlm: () => services.claimExtraction!.llm } : {}),
    },
  )
    .then((result) => {
      if (result.status === "ran") {
        logger.info(`[agenr] importance light dream completed run=${result.result.runId}`);
      } else if (result.reason === "run_in_progress" || result.reason === "episode_write_in_progress") {
        logger.info(`[agenr] importance light dream skipped reason=${result.reason}`);
      } else {
        logger.debug?.(`[agenr] importance light dream skipped reason=${result.reason}`);
      }
    })
    .catch((error: unknown) => {
      logger.warn(`[agenr] importance light dream failed: ${formatErrorMessage(error)}`);
    });
}
