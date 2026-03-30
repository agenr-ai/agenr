import type { AgenrOpenClawBeforeResetDeps, AgenrOpenClawBeforeResetEvent, AgenrOpenClawHookContext } from "../types.js";
import type { SessionStartTracker } from "../session/state.js";
import { writeOpenClawContinuitySummary } from "../session/continuity/continuity-summary-generator.js";

/**
 * Generates a file-based predecessor continuity summary when OpenClaw resets a
 * session.
 *
 * @param event - Reset payload containing the outgoing session transcript path.
 * @param ctx - Hook context with session identity data.
 * @param params - Shared services plus continuity tracker state.
 */
export async function handleAgenrBeforeReset(
  event: AgenrOpenClawBeforeResetEvent,
  ctx: AgenrOpenClawHookContext,
  params: AgenrOpenClawBeforeResetDeps & {
    tracker: SessionStartTracker;
  },
): Promise<void> {
  const sessionContext = formatSessionContext(ctx.sessionId, ctx.sessionKey);
  const sessionFile = event.sessionFile?.trim();
  const rawMessageCount = Array.isArray(event.messages) ? event.messages.length : 0;

  if (!sessionFile) {
    params.logger.info(
      `[agenr] before_reset: continuity summary generation skipped for ${sessionContext} reason=no_session_file rawMessages=${rawMessageCount}`,
    );
    debugLog(params.logger, "before_reset", `skipping continuity summary for ${sessionContext} because no session file was provided`);
    return;
  }

  params.tracker.rememberReset(ctx.sessionKey, {
    sessionFile,
    recordedAt: new Date().toISOString(),
    ...(ctx.sessionId?.trim() ? { sessionId: ctx.sessionId.trim() } : {}),
  });

  params.logger.info(
    `[agenr] before_reset: continuity summary generation started for ${sessionContext} reason=${event.reason ?? "unknown"} rawMessages=${rawMessageCount}`,
  );
  debugLog(
    params.logger,
    "before_reset",
    `continuity summary request details for ${sessionContext}: file=${sessionFile} workspace=${ctx.workspaceDir ?? "unknown"} reason=${event.reason ?? "unknown"}`,
  );

  try {
    const services = await params.servicesPromise;
    const result = await writeOpenClawContinuitySummary({
      sessionFile,
      agentId: ctx.agentId,
      openClaw: services.openClaw,
      logger: params.logger,
    });

    if (result.status === "written") {
      params.logger.info(
        `[agenr] before_reset: continuity summary file written for ${sessionContext} path=${result.continuitySummaryPath} bytes=${result.bytesWritten ?? 0}`,
      );
      return;
    }

    if (result.status === "skipped") {
      params.logger.info(
        `[agenr] before_reset: continuity summary generation skipped for ${sessionContext} reason=${result.reason ?? "unknown"} cleanedMessages=${result.messageCount ?? 0}`,
      );
      debugLog(
        params.logger,
        "before_reset",
        `skip details for ${sessionContext}: continuitySummaryPath=${result.continuitySummaryPath ?? "n/a"} transcriptChars=${result.transcriptChars ?? 0}`,
      );
      return;
    }

    params.logger.info(
      `[agenr] before_reset: continuity summary generation failed for ${sessionContext} reason=${result.reason ?? "unknown"} model=${result.model ?? "unknown"}`,
    );
    debugLog(
      params.logger,
      "before_reset",
      `failure details for ${sessionContext}: continuitySummaryPath=${result.continuitySummaryPath ?? "n/a"} durationMs=${result.durationMs ?? 0} transcriptChars=${result.transcriptChars ?? 0}`,
    );
  } catch (error) {
    params.logger.info(`[agenr] before_reset: continuity summary generation failed for ${sessionContext} reason=${formatErrorMessage(error)} model=unknown`);
    debugLog(params.logger, "before_reset", `unexpected failure for ${sessionContext}: ${formatErrorMessage(error)}`);
  }
}

/** Emits debug logs when the plugin logger supports them. */
function debugLog(logger: AgenrOpenClawBeforeResetDeps["logger"], subsystem: string, message: string): void {
  logger.debug?.(`[agenr] ${subsystem}: ${message}`);
}

/** Formats unknown failures into human-readable log messages. */
function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
