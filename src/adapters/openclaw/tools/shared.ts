import { failedTextResult, readNumberParam, readStringArrayParam, readStringParam, textResult } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginToolContext, PluginLogger } from "openclaw/plugin-sdk/core";

import { formatErrorMessage } from "../../shared/errors.js";
import type { MemoryToolOutcome, MemoryToolParamReader } from "../../shared/memory-tools.js";
import {
  DURABLE_TYPE_DESCRIPTION,
  EXPIRY_DESCRIPTION,
  RECALL_MODES,
  UPDATE_EXPIRY_DESCRIPTION,
  asRecord,
  formatTargetSelector,
  normalizeStringArray,
  parseDurableKind,
  parseDurableKinds,
  parseExpiry,
  parseRecallMode,
  sanitizeUpdateToolParams,
} from "../../shared/durable-tools.js";

/** Shared OpenClaw param reader wired into host-neutral memory tool parsers. */
const OPENCLAW_PARAM_READER: MemoryToolParamReader = {
  readString: readStringParam,
  readNumber: readNumberParam,
  readStringArray: readStringArrayParam,
};

export {
  OPENCLAW_PARAM_READER,
  DURABLE_TYPE_DESCRIPTION,
  EXPIRY_DESCRIPTION,
  RECALL_MODES,
  UPDATE_EXPIRY_DESCRIPTION,
  asRecord,
  formatErrorMessage,
  formatTargetSelector,
  normalizeStringArray,
  parseDurableKind,
  parseDurableKinds,
  parseExpiry,
  parseRecallMode,
  sanitizeUpdateToolParams,
};

/**
 * Maps a host-neutral memory tool outcome into an OpenClaw tool result.
 *
 * @param outcome - Shared store/update execution result.
 * @returns OpenClaw text result payload.
 */
export function toOpenClawToolResult(outcome: MemoryToolOutcome) {
  if (outcome.failed) {
    return failedTextResult(outcome.text, {
      ...outcome.details,
      status: "failed",
    });
  }

  return textResult(outcome.text, outcome.details);
}

/**
 * Logs one tool call summary plus sanitized parameters at info level.
 *
 * @param logger - Host logger used for OpenClaw tools.
 * @param toolName - Tool name being invoked.
 * @param ctx - Tool invocation context.
 * @param summary - Human-readable summary text.
 * @param sanitizedParams - Redacted parameter payload for logs.
 * @returns Nothing.
 */
export function logToolCall(
  logger: PluginLogger,
  toolName: string,
  ctx: OpenClawPluginToolContext,
  summary: string,
  sanitizedParams: Record<string, unknown>,
): void {
  logger.info(`[agenr] tool=${toolName} ${formatToolSessionContext(ctx)} ${summary}`);
  logger.info(`[agenr] tool=${toolName} ${formatToolSessionContext(ctx)} params=${JSON.stringify(sanitizedParams)}`);
}

/**
 * Logs a warning when one OpenClaw tool call fails.
 *
 * @param logger - Host logger used for OpenClaw tools.
 * @param toolName - Tool name being invoked.
 * @param ctx - Tool invocation context.
 * @param error - Unknown failure value.
 * @returns Nothing.
 */
export function logToolFailure(logger: PluginLogger, toolName: string, ctx: OpenClawPluginToolContext, error: unknown): void {
  logger.warn(`[agenr] tool=${toolName} ${formatToolSessionContext(ctx)} failed: ${formatErrorMessage(error)}`);
}

/**
 * Wraps unexpected tool failures in the standard failed result payload.
 *
 * @param error - Unknown failure value.
 * @returns Standard failed text result payload.
 */
export function toolFailureResult(error: unknown) {
  return failedTextResult(formatErrorMessage(error), {
    status: "failed" as const,
  });
}

/**
 * Formats stable session identifiers for tool-level OpenClaw logs.
 *
 * @param ctx - Tool invocation context.
 * @returns Stable session context string for logs.
 */
function formatToolSessionContext(ctx: OpenClawPluginToolContext): string {
  const normalizedSessionId = ctx.sessionId?.trim();
  const normalizedSessionKey = ctx.sessionKey?.trim();

  if (normalizedSessionId && normalizedSessionKey) {
    return `session=${normalizedSessionId} key=${normalizedSessionKey}`;
  }

  if (normalizedSessionId) {
    return `session=${normalizedSessionId}`;
  }

  if (normalizedSessionKey) {
    return `key=${normalizedSessionKey}`;
  }

  return "session=unknown";
}
