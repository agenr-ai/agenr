import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginToolContext, PluginLogger } from "openclaw/plugin-sdk/core";

import { UPDATE_TOOL_PARAMETERS, parseUpdateToolParams, runUpdateMemoryTool } from "../../shared/memory-tools.js";
import type { AgenrOpenClawServices } from "../types.js";
import {
  formatTargetSelector,
  logToolCall,
  logToolFailure,
  OPENCLAW_PARAM_READER,
  sanitizeUpdateToolParams,
  toOpenClawToolResult,
  toolFailureResult,
} from "./shared.js";

/**
 * Creates the agenr update tool bound to one OpenClaw session context.
 *
 * @param ctx - Trusted OpenClaw tool context.
 * @param servicesPromise - Shared agenr adapters reused for the process lifetime.
 * @param logger - Host logger supplied by the OpenClaw plugin runtime.
 * @returns Agent tool definition for `agenr_update`.
 */
export function createAgenrUpdateTool(ctx: OpenClawPluginToolContext, servicesPromise: Promise<AgenrOpenClawServices>, logger: PluginLogger): AnyAgentTool {
  return {
    name: "agenr_update",
    label: "Agenr Update",
    description: "Update an existing memory entry in place. Currently supports importance, expiry, claim_key, valid_from, and valid_to.",
    parameters: UPDATE_TOOL_PARAMETERS,
    async execute(_toolCallId, rawParams) {
      try {
        const params = parseUpdateToolParams(rawParams, OPENCLAW_PARAM_READER);
        logToolCall(
          logger,
          "agenr_update",
          ctx,
          `target=${formatTargetSelector(params.id, params.subject)}${params.importance !== undefined ? ` importance=${params.importance}` : ""}${params.expiry !== undefined ? ` expiry=${params.expiry}` : ""}`,
          sanitizeUpdateToolParams({
            id: params.id,
            subject: params.subject,
            importance: params.importance,
            expiry: params.expiry,
            claimKey: params.claimKeyInput,
            validFrom: params.validFrom,
            validTo: params.validTo,
          }),
        );
        const services = await servicesPromise;
        return toOpenClawToolResult(
          await runUpdateMemoryTool(params, services, {
            session: ctx,
            sourcePrefix: "openclaw-session",
            successDetails: { sessionKey: ctx.sessionKey },
          }),
        );
      } catch (error) {
        logToolFailure(logger, "agenr_update", ctx, error);
        return toolFailureResult(error);
      }
    },
  };
}
