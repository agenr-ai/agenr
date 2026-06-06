import type { PluginLogger } from "openclaw/plugin-sdk/core";

import { formatSessionContext } from "../logging.js";
import { pushMidSessionStoredSubject, type MidSessionTracker } from "../session/state.js";
import type { AgenrOpenClawAfterToolCallEvent, AgenrOpenClawHookContext, MidSessionState } from "../types.js";

const STORE_TOOL_NAME = "agenr_store";
const UPDATE_TOOL_NAME = "agenr_update";

/**
 * Updates mid-session nudge state from OpenClaw's fire-and-forget tool hook.
 *
 * All state mutation happens synchronously before the function returns so the
 * next `before_prompt_build` turn sees the latest memory activity.
 *
 * @param event - Tool execution facts emitted by OpenClaw.
 * @param ctx - Tool hook context with session identity.
 * @param params - Shared logger and mutable mid-session tracker.
 * @returns Nothing.
 */
export function handleAgenrAfterToolCall(
  event: AgenrOpenClawAfterToolCallEvent,
  ctx: AgenrOpenClawHookContext,
  params: {
    logger: PluginLogger;
    midSessionTracker: MidSessionTracker;
  },
): void {
  if (event.toolName !== STORE_TOOL_NAME && event.toolName !== UPDATE_TOOL_NAME) {
    return;
  }

  const state = params.midSessionTracker.getOrCreate(ctx.sessionId, ctx.sessionKey);
  if (!state) {
    params.logger.debug?.(`[agenr] after_tool_call: skipped mid-session tracking without session identity for tool=${event.toolName}`);
    return;
  }

  if (event.toolName === STORE_TOOL_NAME) {
    handleStoreToolResult(event, ctx, state, params.logger);
    return;
  }

  state.lastMemoryActionTurn = state.turnCount;
  state.lastExplicitMemoryActionTurn = state.turnCount;
  params.logger.debug?.(
    `[agenr] after_tool_call: memory maintenance tool=${event.toolName} turn=${state.turnCount} ${formatSessionContext(ctx.sessionId, ctx.sessionKey)}`,
  );
}

/**
 * Applies agenr_store outcomes to tracked mid-session state.
 *
 * @param event - Store tool execution facts.
 * @param ctx - Tool hook context with session identity.
 * @param state - Mutable mid-session state for the active session.
 * @param logger - Host logger for debug tracing.
 * @returns Nothing.
 */
function handleStoreToolResult(event: AgenrOpenClawAfterToolCallEvent, ctx: AgenrOpenClawHookContext, state: MidSessionState, logger: PluginLogger): void {
  const status = readToolStatus(event.result);
  const sessionContext = formatSessionContext(ctx.sessionId, ctx.sessionKey);
  const hasExplicitMemoryParams = hasNonEmptyString(event.params.claimKey) || hasNonEmptyString(event.params.supersedes);

  if (status === "stored" && !event.error) {
    state.entriesStored += 1;
    state.lastSuccessfulStoreTurn = state.turnCount;
    state.lastMemoryActionTurn = state.turnCount;
    if (hasExplicitMemoryParams) {
      state.lastExplicitMemoryActionTurn = state.turnCount;
    }
    pushMidSessionStoredSubject(state, readString(event.params.subject));
    logger.debug?.(`[agenr] after_tool_call: store recorded status=stored turn=${state.turnCount} entriesStored=${state.entriesStored} ${sessionContext}`);
    return;
  }

  if (status === "skipped" && !event.error) {
    state.lastMemoryActionTurn = state.turnCount;
    if (hasExplicitMemoryParams) {
      state.lastExplicitMemoryActionTurn = state.turnCount;
    }
    logger.debug?.(`[agenr] after_tool_call: store recorded status=skipped turn=${state.turnCount} ${sessionContext}`);
    return;
  }

  if (hasExplicitMemoryParams) {
    state.lastExplicitMemoryActionTurn = state.turnCount;
  }

  logger.debug?.(
    `[agenr] after_tool_call: store ignored for nudge reset status=${status ?? "unknown"} error=${event.error ?? "none"} turn=${state.turnCount} ${sessionContext}`,
  );
}

/**
 * Reads the normalized status field from one sanitized tool result payload.
 *
 * @param value - Sanitized tool result payload supplied by OpenClaw.
 * @returns Tool status string, or `undefined` when absent.
 */
function readToolStatus(value: unknown): string | undefined {
  const record = asRecord(value);
  const directStatus = readString(record?.status);
  if (directStatus) {
    return directStatus;
  }

  return readString(asRecord(record?.details)?.status);
}

/**
 * Narrows one unknown value to an object-like record.
 *
 * @param value - Candidate value to inspect.
 * @returns String-keyed record, or `undefined` when not object-like.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Reads one non-empty string value from an unknown field.
 *
 * @param value - Candidate string field.
 * @returns Trimmed string, or `undefined` when absent.
 */
function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalizedValue = value.trim();
  return normalizedValue.length > 0 ? normalizedValue : undefined;
}

/**
 * Checks whether one unknown field contains a non-empty string.
 *
 * @param value - Candidate field value.
 * @returns True when the value is a non-empty string.
 */
function hasNonEmptyString(value: unknown): boolean {
  return readString(value) !== undefined;
}
