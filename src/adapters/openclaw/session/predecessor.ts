import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import type { AgenrOpenClawHookContext } from "../types.js";
import type { SessionResetRecord, SessionStartTracker } from "./state.js";

/**
 * Resolved predecessor facts used for summary and transcript-tail injection.
 */
export interface OpenClawSessionPredecessor {
  /**
   * Previous OpenClaw session UUID when known.
   */
  sessionId?: string;
  /**
   * Absolute path to the predecessor session transcript JSONL.
   */
  sessionFile: string;
}

/**
 * Resolves the predecessor session file for the active OpenClaw session.
 *
 * The v1 plugin keeps continuity simple:
 * 1. remember the outgoing session file during `before_reset`
 * 2. remember `resumedFrom` during `session_start`
 * 3. on `before_prompt_build`, match the current session key to the latest
 *    reset record and, when available, verify that `resumedFrom` agrees
 *
 * @param ctx - Active OpenClaw hook context.
 * @param tracker - In-process continuity tracker shared by the plugin.
 * @param logger - Optional plugin logger used for debug diagnostics.
 * @returns Predecessor facts, or `undefined` when continuity cannot be resolved.
 */
export function resolveOpenClawSessionPredecessor(
  ctx: AgenrOpenClawHookContext,
  tracker: SessionStartTracker,
  logger?: PluginLogger,
): OpenClawSessionPredecessor | undefined {
  const sessionContext = formatSessionContext(ctx.sessionId, ctx.sessionKey);
  debugLog(logger, "predecessor", `resolving predecessor for ${sessionContext}`);

  const resetRecord = tracker.getLatestReset(ctx.sessionKey);
  if (!resetRecord) {
    debugLog(logger, "predecessor", `no reset record found for ${sessionContext}`);
    return undefined;
  }

  debugLog(logger, "predecessor", `latest reset record for ${sessionContext}: ${formatResetRecord(resetRecord)}`);

  const resumedFrom = tracker.getResumedFrom(ctx.sessionId);
  if (resumedFrom) {
    debugLog(logger, "predecessor", `session_start resumedFrom for ${sessionContext}: ${resumedFrom}`);
  } else {
    debugLog(logger, "predecessor", `session_start resumedFrom unavailable for ${sessionContext}`);
  }

  if (resumedFrom && resetRecord.sessionId && resetRecord.sessionId !== resumedFrom) {
    debugLog(
      logger,
      "predecessor",
      `discarding stale reset record for ${sessionContext}: resumedFrom=${resumedFrom} resetRecordSession=${resetRecord.sessionId}`,
    );
    return undefined;
  }

  return {
    sessionFile: resetRecord.sessionFile,
    ...(resetRecord.sessionId ? { sessionId: resetRecord.sessionId } : {}),
  };
}

/** Emits debug logs when the plugin logger supports them. */
function debugLog(logger: PluginLogger | undefined, subsystem: string, message: string): void {
  logger?.debug?.(`[agenr] ${subsystem}: ${message}`);
}

/** Formats stable session identifiers for OpenClaw adapter log messages. */
function formatSessionContext(sessionId?: string, sessionKey?: string): string {
  const normalizedSessionId = sessionId?.trim();
  const normalizedSessionKey = sessionKey?.trim();

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

/** Formats a concise reset-record string for debug logs. */
function formatResetRecord(record: SessionResetRecord): string {
  return `sessionFile=${record.sessionFile}${record.sessionId ? ` sessionId=${record.sessionId}` : ""} recordedAt=${record.recordedAt}`;
}
