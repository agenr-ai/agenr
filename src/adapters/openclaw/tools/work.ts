import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginToolContext, PluginLogger } from "openclaw/plugin-sdk/core";

import { parseWorkToolParams, runWorkMemoryTool, WORK_TOOL_PARAMETERS } from "../../shared/work-tools.js";
import {
  formatUnknownOpenClawSessionScopeMessage,
  isUnknownOpenClawSessionScope,
  resolveOpenClawSessionScope,
  toWorkingScopeFromOpenClawSession,
} from "../session/scope.js";
import type { AgenrOpenClawServices } from "../types.js";
import { OPENCLAW_PARAM_READER, logToolCall, logToolFailure, toOpenClawToolResult, toolFailureResult } from "./shared.js";

const OPENCLAW_WORK_TOOL_DESCRIPTION =
  "Read or update transient working memory for the active task. Use this for task state, checkpoints, next actions, files, commands, blockers, and close handoff candidates, not durable facts.";

const OPENCLAW_WORK_TOOL_GUIDELINES = [
  "Use create with set_objective to start a new scoped working set only when no active session working set exists.",
  "Use update only for material task-state changes, and always pass expectedRevision plus updateReason.",
  "Use merge_checkpoint before pausing, compacting, handing off, forking, or waiting.",
  "Do not call close; host lifecycle paths own session working-set close.",
  "After delivering results, leave the working set open and record progress with merge_checkpoint.",
  "Do not use agenr_store for transient WIP.",
] as const;

/**
 * Creates the agenr_work tool bound to one OpenClaw session context.
 *
 * @param ctx - Trusted OpenClaw tool context.
 * @param servicesPromise - Shared agenr adapters reused for the process lifetime.
 * @param logger - Host logger supplied by the OpenClaw plugin runtime.
 * @returns Agent tool definition for `agenr_work`.
 */
export function createAgenrWorkTool(ctx: OpenClawPluginToolContext, servicesPromise: Promise<AgenrOpenClawServices>, logger: PluginLogger): AnyAgentTool {
  return {
    name: "agenr_work",
    label: "Agenr Work",
    description: [OPENCLAW_WORK_TOOL_DESCRIPTION, ...OPENCLAW_WORK_TOOL_GUIDELINES].join(" "),
    parameters: WORK_TOOL_PARAMETERS,
    async execute(_toolCallId, rawParams) {
      try {
        const sessionScope = resolveOpenClawSessionScope({
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
          ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
          ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        });
        if (isUnknownOpenClawSessionScope(sessionScope)) {
          throw new Error(formatUnknownOpenClawSessionScopeMessage("mutate a session working set"));
        }

        const defaultScope = toWorkingScopeFromOpenClawSession(sessionScope);
        const params = parseWorkToolParams(rawParams, defaultScope, OPENCLAW_PARAM_READER);
        logToolCall(logger, "agenr_work", ctx, `work action=${params.action}`, { action: params.action, target: params.target });

        const services = await servicesPromise;
        const outcome = await runWorkMemoryTool(params, services.workingMemory);
        return toOpenClawToolResult(outcome);
      } catch (error) {
        logToolFailure(logger, "agenr_work", ctx, error);
        return toolFailureResult(error);
      }
    },
  };
}
