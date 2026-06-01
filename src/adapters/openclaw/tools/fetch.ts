import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginToolContext, PluginLogger } from "openclaw/plugin-sdk/core";

import { formatTargetSelector, sanitizeFetchToolParams } from "../../shared/entry-tools.js";
import { FETCH_TOOL_PARAMETERS, parseFetchToolParams, runFetchMemoryTool } from "../../shared/memory-tools.js";
import type { AgenrOpenClawServices } from "../types.js";
import { logToolCall, logToolFailure, OPENCLAW_PARAM_READER, toOpenClawToolResult, toolFailureResult } from "./shared.js";

/**
 * Creates the agenr fetch tool bound to one OpenClaw session context.
 *
 * @param ctx - Trusted OpenClaw tool context.
 * @param servicesPromise - Shared agenr adapters reused for the process lifetime.
 * @param logger - Host logger supplied by the OpenClaw plugin runtime.
 * @returns Agent tool definition for `agenr_fetch`.
 */
export function createAgenrFetchTool(ctx: OpenClawPluginToolContext, servicesPromise: Promise<AgenrOpenClawServices>, logger: PluginLogger): AnyAgentTool {
  return {
    name: "agenr_fetch",
    label: "Agenr Fetch",
    description: "Fetch the full body and metadata for one durable memory entry by id or subject.",
    parameters: FETCH_TOOL_PARAMETERS,
    async execute(_toolCallId, rawParams) {
      try {
        const params = parseFetchToolParams(rawParams, OPENCLAW_PARAM_READER);
        logToolCall(logger, "agenr_fetch", ctx, `target=${formatTargetSelector(params.id, params.subject)}`, sanitizeFetchToolParams(params));
        const services = await servicesPromise;
        return toOpenClawToolResult(
          await runFetchMemoryTool(params, services, {
            extraDetails: { sessionKey: ctx.sessionKey },
          }),
        );
      } catch (error) {
        logToolFailure(logger, "agenr_fetch", ctx, error);
        return toolFailureResult(error);
      }
    },
  };
}
