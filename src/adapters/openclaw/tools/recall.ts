import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-runtime";
import { textResult } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginToolContext, PluginLogger } from "openclaw/plugin-sdk/core";

import { randomUUID } from "node:crypto";

import { formatUnifiedRecallResults } from "../../shared/recall-format.js";
import {
  RECALL_TOOL_PARAMETERS,
  buildRecallToolDetails,
  buildRecallToolServices,
  formatRecallToolSummary,
  formatUnifiedRecallLogSummary,
  parseRecallToolParams,
  runRecallMemoryTool,
  sanitizeRecallToolParams,
} from "../../shared/memory-tools.js";
import { buildOpenClawRecallToolDescription } from "../../shared/memory-prompt-doctrine.js";
import { buildLiveRecallDebugArtifact } from "../debug/index.js";
import type { AgenrOpenClawServices } from "../types.js";
import { OPENCLAW_PARAM_READER, logToolCall, logToolFailure, toolFailureResult } from "./shared.js";

/**
 * Creates the agenr recall tool bound to one OpenClaw session context.
 *
 * @param ctx - Trusted OpenClaw tool context.
 * @param servicesPromise - Shared agenr adapters reused for the process lifetime.
 * @param logger - Host logger supplied by the OpenClaw plugin runtime.
 * @returns Agent tool definition for `agenr_recall`.
 */
export function createAgenrRecallTool(ctx: OpenClawPluginToolContext, servicesPromise: Promise<AgenrOpenClawServices>, logger: PluginLogger): AnyAgentTool {
  return {
    name: "agenr_recall",
    label: "Agenr Recall",
    description: buildOpenClawRecallToolDescription(),
    parameters: RECALL_TOOL_PARAMETERS,
    async execute(_toolCallId, rawParams) {
      try {
        const params = parseRecallToolParams(rawParams, OPENCLAW_PARAM_READER);
        const sanitizedParams = sanitizeRecallToolParams(params);
        logToolCall(logger, "agenr_recall", ctx, formatRecallToolSummary(params), sanitizedParams);

        const services = await servicesPromise;
        void services.debugSink.emit({
          type: "tool_call",
          tool: "agenr_recall",
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
          params: sanitizedParams,
        });
        const result = await runRecallMemoryTool(params, buildRecallToolServices(services), {
          sessionKey: ctx.sessionKey,
          slotPolicyConfig: services.pluginConfig.memoryPolicy?.slotPolicies,
          debugLog: (message: string) => {
            logger.debug?.(message);
          },
        });
        logger.info(
          `[agenr] tool=agenr_recall session=${ctx.sessionId ?? "unknown"} key=${ctx.sessionKey ?? "unknown"} result: ${formatUnifiedRecallLogSummary(result)}`,
        );
        emitRecallDebugArtifacts(services, ctx, params.query, result);

        return textResult(formatUnifiedRecallResults(result), buildRecallToolDetails(result));
      } catch (error) {
        logToolFailure(logger, "agenr_recall", ctx, error);
        await emitRecallError(servicesPromise, ctx, error);
        return toolFailureResult(error);
      }
    },
  };
}

/**
 * Emits bounded debug artifacts for a successful OpenClaw recall tool call.
 */
function emitRecallDebugArtifacts(
  services: AgenrOpenClawServices,
  ctx: OpenClawPluginToolContext,
  query: string,
  result: Awaited<ReturnType<typeof runRecallMemoryTool>>,
): void {
  if (!services.debugSink.enabled) {
    return;
  }

  const sessionIdPayload = ctx.sessionId ? { sessionId: ctx.sessionId } : {};
  const sessionKeyPayload = ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {};
  void services.debugSink.emit({
    type: "tool_result",
    tool: "agenr_recall",
    ...sessionIdPayload,
    ...sessionKeyPayload,
    summary: {
      count: result.count,
      routing: {
        requested: result.routing.requested,
        detectedIntent: result.routing.detectedIntent,
        queried: [...result.routing.queried],
        reason: result.routing.reason,
      },
      selectedEntryIds: result.entries.map((entry) => entry.entry.id),
      episodeIds: result.episodes.map((episode) => episode.episode.id),
      selectedProcedureKey: result.procedure?.procedure_key ?? null,
      notices: [...result.notices],
      procedureNotices: [...result.procedureNotices],
    },
  });
  void services.debugSink.emit({
    type: "unified_recall",
    ...sessionIdPayload,
    ...sessionKeyPayload,
    debug: buildLiveRecallDebugArtifact({
      caseId: `live-${randomUUID()}`,
      query,
      result,
      eventLevel: services.debugSink.eventLevel,
      maxTopCandidates: services.debugSink.maxTopCandidates,
    }),
  });
}

/**
 * Emits a best-effort debug event for a failed OpenClaw recall tool call.
 */
async function emitRecallError(servicesPromise: Promise<AgenrOpenClawServices>, ctx: OpenClawPluginToolContext, error: unknown): Promise<void> {
  try {
    const services = await servicesPromise;
    if (services.debugSink.enabled) {
      void services.debugSink.emit({
        type: "error",
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
        scope: "agenr_recall",
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  } catch {
    // Swallow debug-sink emission failures to avoid masking the original error.
  }
}
