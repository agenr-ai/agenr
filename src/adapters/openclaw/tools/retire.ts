import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-runtime";
import { failedTextResult, readStringParam, textResult } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginToolContext, PluginLogger } from "openclaw/plugin-sdk/core";

import type { AgenrOpenClawServices } from "../types.js";
import { asRecord, formatTargetSelector, logToolCall, logToolFailure, resolveTargetEntry, sanitizeRetireToolParams, toolFailureResult } from "./shared.js";

const RETIRE_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: {
      type: "string",
      description: "Entry id to retire. Provide exactly one of id or subject.",
    },
    subject: {
      type: "string",
      description: "Subject text to resolve when the id is unknown. The most recent exact or substring match wins. Provide exactly one of id or subject.",
    },
    reason: {
      type: "string",
      description: "Optional retirement reason so later trace output explains why this memory was removed.",
    },
  },
} as const;

/**
 * Creates the agenr retire tool bound to one OpenClaw session context.
 *
 * @param ctx - Trusted OpenClaw tool context.
 * @param servicesPromise - Shared agenr adapters reused for the process lifetime.
 * @param logger - Host logger supplied by the OpenClaw plugin runtime.
 * @returns Agent tool definition for `agenr_retire`.
 */
export function createAgenrRetireTool(ctx: OpenClawPluginToolContext, servicesPromise: Promise<AgenrOpenClawServices>, logger: PluginLogger): AnyAgentTool {
  return {
    name: "agenr_retire",
    label: "Agenr Retire",
    description: "Mark a memory entry as retired (soft delete). Retired entries are excluded from all recall.",
    parameters: RETIRE_TOOL_PARAMETERS,
    async execute(_toolCallId, rawParams) {
      try {
        const params = asRecord(rawParams);
        const id = readStringParam(params, "id");
        const subject = readStringParam(params, "subject");
        const reason = readStringParam(params, "reason");
        logToolCall(logger, "agenr_retire", ctx, `target=${formatTargetSelector(id, subject)}`, sanitizeRetireToolParams({ id, subject, reason }));
        const services = await servicesPromise;
        const entry = await resolveTargetEntry(services, params);
        const retired = await services.entries.retireEntry(entry.id, reason);

        if (!retired) {
          return failedTextResult(`Entry ${entry.id} is not active, so it could not be retired.`, {
            status: "failed",
            entryId: entry.id,
          });
        }

        return textResult(`Retired "${entry.subject}".`, {
          status: "retired",
          entryId: entry.id,
          subject: entry.subject,
          sessionKey: ctx.sessionKey,
        });
      } catch (error) {
        logToolFailure(logger, "agenr_retire", ctx, error);
        return toolFailureResult(error);
      }
    },
  };
}
