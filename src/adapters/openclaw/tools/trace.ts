import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-runtime";
import { failedTextResult, readStringParam, textResult } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginToolContext, PluginLogger } from "openclaw/plugin-sdk/core";

import type { AgenrOpenClawServices } from "../types.js";
import {
  asRecord,
  formatTargetSelector,
  formatTrace,
  logToolCall,
  logToolFailure,
  readBooleanParam,
  resolveTargetEntry,
  sanitizeTraceToolParams,
  toolFailureResult,
} from "./shared.js";

const TRACE_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: {
      type: "string",
      description: "Entry id to trace. Provide exactly one of id, subject, or last.",
    },
    subject: {
      type: "string",
      description:
        "Subject text to resolve when the id is unknown. The most recent exact or substring match wins. Provide exactly one of id, subject, or last.",
    },
    last: {
      type: "boolean",
      description: "Set true to trace the most recently created agenr entry. Provide exactly one of id, subject, or last.",
    },
  },
} as const;

/**
 * Creates the agenr trace tool bound to one OpenClaw session context.
 *
 * @param ctx - Trusted OpenClaw tool context.
 * @param servicesPromise - Shared agenr adapters reused for the process lifetime.
 * @param logger - Host logger supplied by the OpenClaw plugin runtime.
 * @returns Agent tool definition for `agenr_trace`.
 */
export function createAgenrTraceTool(ctx: OpenClawPluginToolContext, servicesPromise: Promise<AgenrOpenClawServices>, logger: PluginLogger): AnyAgentTool {
  return {
    name: "agenr_trace",
    label: "Agenr Trace",
    description:
      "Trace the provenance of a knowledge entry. The current v1 trace view shows the entry itself, supersession links, and recent recall history. Accepts id, subject, or last for lookup.",
    parameters: TRACE_TOOL_PARAMETERS,
    async execute(_toolCallId, rawParams) {
      try {
        const params = asRecord(rawParams);
        const id = readStringParam(params, "id");
        const subject = readStringParam(params, "subject");
        const last = readBooleanParam(params, "last");
        logToolCall(logger, "agenr_trace", ctx, `target=${formatTargetSelector(id, subject, last)}`, sanitizeTraceToolParams({ id, subject, last }));
        const services = await servicesPromise;
        const entry = await resolveTargetEntry(services, params, { allowLast: true });
        const trace = await services.memory.getEntryTrace(entry.id);

        if (!trace) {
          return failedTextResult(`Entry ${entry.id} was not found for tracing.`, {
            status: "failed",
            entryId: entry.id,
          });
        }

        return textResult(formatTrace(trace.entry, trace.supersededBy, trace.supersedes, trace.recallEvents), {
          status: "ok",
          sessionKey: ctx.sessionKey,
          trace: {
            entry: trace.entry,
            supersededBy: trace.supersededBy,
            supersedes: trace.supersedes,
            recallEvents: trace.recallEvents,
          },
        });
      } catch (error) {
        logToolFailure(logger, "agenr_trace", ctx, error);
        return toolFailureResult(error);
      }
    },
  };
}
