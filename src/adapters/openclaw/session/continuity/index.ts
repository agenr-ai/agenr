import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import { formatErrorMessage, formatSessionContext } from "../../logging.js";
import type { AgenrOpenClawHookContext, AgenrOpenClawServices } from "../../types.js";
import type { SessionStartTracker } from "../state.js";
import { generateAndWriteOpenClawContinuitySummary } from "./continuity-summary-generator.js";
import { readOpenClawContinuitySummaryFile } from "./continuity-summary-reader.js";
import { resolveOpenClawSessionPredecessor } from "./predecessor-resolver.js";
import { renderRecentSessionSection } from "./recent-session.js";
import type { OpenClawContinuitySummaryWriteResult, PredecessorContinuityResult } from "./types.js";

const READ_TIME_CONTINUITY_SUMMARY_TIMEOUT_MS = 20_000;
const READ_TIME_CONTINUITY_SUMMARY_TIMEOUT = Symbol("read-time-continuity-summary-timeout");

export type { PredecessorContinuityResult } from "./types.js";

/**
 * Resolves continuity context for the active session.
 *
 * Handles predecessor detection, continuity summary load-or-generate,
 * and recent transcript tail rendering. Returns prompt-ready content.
 *
 * @param ctx - Active OpenClaw hook context.
 * @param tracker - Shared in-process continuity tracker.
 * @param services - Shared agenr services plus OpenClaw host runtime access.
 * @param logger - Plugin logger used for continuity diagnostics.
 * @returns Prompt-ready continuity content for prompt assembly.
 */
export async function resolvePredecessorContinuity(
  ctx: AgenrOpenClawHookContext,
  tracker: SessionStartTracker,
  services: AgenrOpenClawServices,
  logger: PluginLogger,
): Promise<PredecessorContinuityResult> {
  const sessionContext = formatSessionContext(ctx.sessionId, ctx.sessionKey);
  const predecessor = await resolveOpenClawSessionPredecessor(ctx, tracker, {
    logger,
    resolveStateDir: services.openClaw.runtime.state.resolveStateDir,
  });
  if (!predecessor) {
    logger.info(`[agenr] session-start predecessor continuity summary not found for ${sessionContext} reason=no_predecessor`);
    return {
      continuitySummaryContent: "",
      recentSessionContent: "",
    };
  }

  return {
    continuitySummaryContent: await loadPredecessorContinuitySummaryContent(sessionContext, predecessor.sessionFile, ctx.agentId, services, logger),
    recentSessionContent: await renderRecentSessionSection(predecessor.sessionFile, logger),
  };
}

/**
 * Loads or generates continuity summary content for one predecessor session.
 *
 * @param sessionContext - Stable session identifiers for log output.
 * @param sessionFile - Absolute predecessor transcript path.
 * @param agentId - Active OpenClaw agent id when available.
 * @param services - Shared agenr services plus OpenClaw host runtime access.
 * @param logger - Plugin logger used for continuity summary diagnostics.
 * @returns Continuity summary Markdown content, or an empty string when unavailable.
 */
async function loadPredecessorContinuitySummaryContent(
  sessionContext: string,
  sessionFile: string,
  agentId: string | undefined,
  services: AgenrOpenClawServices,
  logger: PluginLogger,
): Promise<string> {
  try {
    const existingContinuitySummary = await readOpenClawContinuitySummaryFile(sessionFile, logger);
    if (existingContinuitySummary) {
      logger.info(
        `[agenr] session-start read-time continuity summary generation skipped for ${sessionContext} predecessor=${sessionFile} reason=already_exists path=${existingContinuitySummary.continuitySummaryPath}`,
      );
      logger.info(`[agenr] session-start predecessor continuity summary found for ${sessionContext} path=${existingContinuitySummary.continuitySummaryPath}`);
      return existingContinuitySummary.content;
    }

    logger.info(`[agenr] session-start predecessor continuity summary not found for ${sessionContext} predecessor=${sessionFile}`);
  } catch (error) {
    logger.info(
      `[agenr] session-start predecessor continuity summary not found for ${sessionContext} predecessor=${sessionFile} reason=${formatErrorMessage(error)}`,
    );
    logger.debug?.(`[agenr] before_prompt_build: failed reading predecessor continuity summary for ${sessionContext}: ${formatErrorMessage(error)}`);
    return "";
  }

  logger.info(
    `[agenr] session-start read-time continuity summary generation triggered for ${sessionContext} predecessor=${sessionFile} reason=no_existing_continuity_summary`,
  );
  const startedAt = Date.now();

  try {
    const result = await awaitWithTimeout(
      generateAndWriteOpenClawContinuitySummary({
        sessionFile,
        agentId,
        openClaw: services.openClaw,
        logger,
      }),
      READ_TIME_CONTINUITY_SUMMARY_TIMEOUT_MS,
    );
    const elapsedMs = Date.now() - startedAt;

    if (result === READ_TIME_CONTINUITY_SUMMARY_TIMEOUT) {
      logger.info(
        `[agenr] session-start read-time continuity summary generation failed for ${sessionContext} predecessor=${sessionFile} reason=timeout elapsedMs=${elapsedMs}`,
      );
      logger.debug?.(
        `[agenr] before_prompt_build: read-time continuity summary generation timed out for ${sessionContext}: predecessor=${sessionFile} timeoutMs=${READ_TIME_CONTINUITY_SUMMARY_TIMEOUT_MS}`,
      );
      return "";
    }

    return handleReadTimeContinuitySummaryResult(sessionContext, sessionFile, result, elapsedMs, logger);
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    logger.info(
      `[agenr] session-start read-time continuity summary generation failed for ${sessionContext} predecessor=${sessionFile} reason=${formatErrorMessage(error)} elapsedMs=${elapsedMs}`,
    );
    logger.debug?.(
      `[agenr] before_prompt_build: unexpected read-time continuity summary generation failure for ${sessionContext}: ${formatErrorMessage(error)}`,
    );
    return "";
  }
}

/**
 * Normalizes read-time continuity summary generation outcomes into prompt content and logs.
 *
 * @param sessionContext - Stable session identifiers for log output.
 * @param sessionFile - Absolute predecessor transcript path.
 * @param result - Continuity summary generation outcome.
 * @param elapsedMs - End-to-end elapsed time for the read-time attempt.
 * @param logger - Plugin logger used for continuity diagnostics.
 * @returns Continuity summary Markdown content, or an empty string when unavailable.
 */
function handleReadTimeContinuitySummaryResult(
  sessionContext: string,
  sessionFile: string,
  result: OpenClawContinuitySummaryWriteResult,
  elapsedMs: number,
  logger: PluginLogger,
): string {
  if (result.status === "written" && result.content && result.continuitySummaryPath) {
    logger.info(
      `[agenr] session-start read-time continuity summary generation completed for ${sessionContext} predecessor=${sessionFile} elapsedMs=${elapsedMs} path=${result.continuitySummaryPath}`,
    );
    logger.info(`[agenr] session-start predecessor continuity summary found for ${sessionContext} path=${result.continuitySummaryPath}`);
    return result.content;
  }

  if (result.status === "skipped") {
    logger.info(
      `[agenr] session-start read-time continuity summary generation skipped for ${sessionContext} predecessor=${sessionFile} reason=${result.reason ?? "unknown"} path=${result.continuitySummaryPath ?? "n/a"}`,
    );
    logger.debug?.(
      `[agenr] before_prompt_build: read-time continuity summary generation skipped for ${sessionContext}: predecessor=${sessionFile} transcriptChars=${result.transcriptChars ?? 0} cleanedMessages=${result.messageCount ?? 0}`,
    );

    if (result.reason === "already_exists" && result.content && result.continuitySummaryPath) {
      logger.info(`[agenr] session-start predecessor continuity summary found for ${sessionContext} path=${result.continuitySummaryPath}`);
      return result.content;
    }

    return "";
  }

  logger.info(
    `[agenr] session-start read-time continuity summary generation failed for ${sessionContext} predecessor=${sessionFile} reason=${result.reason ?? "unknown"} elapsedMs=${elapsedMs} model=${result.model ?? "unknown"}`,
  );
  logger.debug?.(
    `[agenr] before_prompt_build: read-time continuity summary generation failed for ${sessionContext}: predecessor=${sessionFile} durationMs=${result.durationMs ?? 0} transcriptChars=${result.transcriptChars ?? 0}`,
  );
  return "";
}

/**
 * Resolves a promise while allowing prompt build to proceed after a bounded delay.
 *
 * @param promise - In-flight continuity summary generation promise.
 * @param timeoutMs - Maximum time to wait before returning the timeout sentinel.
 * @returns The promise result, or the timeout sentinel when the delay elapses first.
 */
async function awaitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof READ_TIME_CONTINUITY_SUMMARY_TIMEOUT> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      resolve(READ_TIME_CONTINUITY_SUMMARY_TIMEOUT);
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
