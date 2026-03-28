import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import { listOpenClawCoreEntries } from "../../db/openclaw-plugin-queries.js";
import { formatAgenrSessionStartRecall } from "../format/recall-format.js";
import { resolveOpenClawSessionPredecessor } from "../session/predecessor.js";
import { readOpenClawSessionSummaryFile } from "../session/summary-reader.js";
import type {
  AgenrOpenClawBeforePromptBuildDeps,
  AgenrOpenClawBeforePromptBuildEvent,
  AgenrOpenClawBeforePromptBuildResult,
  AgenrOpenClawHookContext,
  AgenrOpenClawServices,
  OpenClawSessionStartRecall,
} from "../types.js";
import type { SessionStartTracker } from "../session/state.js";
import { openClawTranscriptParser } from "../transcript/parser.js";

const CORE_ENTRY_LIMIT = 4;
const RECENT_SESSION_MESSAGE_LIMIT = 6;
const RECENT_SESSION_MAX_CHARS = 1_800;

/**
 * Runs agenr session-start recall and injects the result into the OpenClaw prompt.
 *
 * @param _event - Current prompt-build payload from OpenClaw.
 * @param ctx - Hook context with session identity data.
 * @param params - Shared services and session-start tracking state.
 * @returns Prompt mutation payload, or `undefined` when nothing should be injected.
 */
export async function handleAgenrBeforePromptBuild(
  _event: AgenrOpenClawBeforePromptBuildEvent,
  ctx: AgenrOpenClawHookContext,
  params: AgenrOpenClawBeforePromptBuildDeps & {
    tracker: SessionStartTracker;
  },
): Promise<AgenrOpenClawBeforePromptBuildResult | undefined> {
  const sessionContext = formatSessionContext(ctx.sessionId, ctx.sessionKey);
  const trackerState = params.tracker.consume(ctx.sessionId, ctx.sessionKey);

  if (!trackerState.isFirst) {
    debugLog(params.logger, "before_prompt_build", `session tracker duplicate blocked for ${sessionContext}`);
    debugLog(params.logger, "before_prompt_build", `session tracker active count=${trackerState.activeCount}`);
    params.logger.info(`[agenr] session-start recall skipped (already ran) for ${sessionContext}`);
    return undefined;
  }

  debugLog(params.logger, "before_prompt_build", `session tracker first start for ${sessionContext}`);
  debugLog(params.logger, "before_prompt_build", `session tracker active count=${trackerState.activeCount}`);
  params.logger.info(`[agenr] session-start recall for ${sessionContext}`);

  try {
    const services = await params.servicesPromise;
    const sessionStartRecall = await runAgenrSessionStartRecall(services);
    const previousSessionContext = await buildPreviousSessionContext(ctx, params.tracker, params.logger);
    const memoryContext = formatAgenrSessionStartRecall(sessionStartRecall);
    const prependContext = [previousSessionContext, memoryContext].filter((value): value is string => value.trim().length > 0).join("\n\n");

    params.logger.info(`[agenr] session-start recall: ${sessionStartRecall.core.length} core entries for ${sessionContext}`);
    debugLog(params.logger, "before_prompt_build", `session-start core entries for ${sessionContext}: ${formatEntryRefs(sessionStartRecall.core)}`);
    debugLog(params.logger, "before_prompt_build", `session-start prependContext length for ${sessionContext}: ${prependContext.length} chars`);

    if (prependContext.length === 0) {
      params.logger.info(`[agenr] session-start recall: nothing to inject for ${sessionContext}`);
      return undefined;
    }

    return { prependContext };
  } catch (error) {
    params.logger.warn(`[agenr] session-start recall failed for ${sessionContext}: ${formatErrorMessage(error)}`);
    return undefined;
  }
}

/**
 * Composes the session-start recall payload from always-on agenr core entries.
 *
 * @param services - Shared agenr adapters used by the plugin.
 * @returns Structured session-start recall data ready for prompt formatting.
 */
export async function runAgenrSessionStartRecall(services: AgenrOpenClawServices): Promise<OpenClawSessionStartRecall> {
  const core = await listOpenClawCoreEntries(services.database, CORE_ENTRY_LIMIT);

  return {
    core,
  };
}

/**
 * Builds predecessor continuity sections for the active session start.
 *
 * @param ctx - Active OpenClaw hook context.
 * @param tracker - Shared in-process continuity tracker.
 * @param logger - Plugin logger used for continuity diagnostics.
 * @returns Prompt-ready predecessor sections, or an empty string when unavailable.
 */
async function buildPreviousSessionContext(ctx: AgenrOpenClawHookContext, tracker: SessionStartTracker, logger: PluginLogger): Promise<string> {
  const sessionContext = formatSessionContext(ctx.sessionId, ctx.sessionKey);
  const predecessor = await resolveOpenClawSessionPredecessor(ctx, tracker, logger);
  if (!predecessor) {
    logger.info(`[agenr] session-start predecessor summary not found for ${sessionContext} reason=no_predecessor`);
    return "";
  }

  const sections: string[] = [];
  try {
    const summary = await readOpenClawSessionSummaryFile(predecessor.sessionFile, logger);
    if (summary) {
      logger.info(`[agenr] session-start predecessor summary found for ${sessionContext} path=${summary.summaryPath}`);
      sections.push(`## Previous session summary\n${summary.content}`);
    } else {
      logger.info(`[agenr] session-start predecessor summary not found for ${sessionContext} predecessor=${predecessor.sessionFile}`);
    }
  } catch (error) {
    logger.info(
      `[agenr] session-start predecessor summary not found for ${sessionContext} predecessor=${predecessor.sessionFile} reason=${formatErrorMessage(error)}`,
    );
    debugLog(logger, "before_prompt_build", `failed reading predecessor summary for ${sessionContext}: ${formatErrorMessage(error)}`);
  }

  const recentSession = await renderRecentSessionSection(predecessor.sessionFile, logger);
  if (recentSession.length > 0) {
    sections.push(`## Recent session\n${recentSession}`);
  }

  return sections.join("\n\n");
}

/**
 * Renders a compact recent-session tail from the predecessor transcript file.
 *
 * @param sessionFile - Absolute predecessor transcript path.
 * @param logger - Plugin logger used for transcript-tail diagnostics.
 * @returns Prompt-ready transcript excerpt, or an empty string when unavailable.
 */
async function renderRecentSessionSection(sessionFile: string, logger: PluginLogger): Promise<string> {
  try {
    const transcript = await openClawTranscriptParser.parseFile(sessionFile);
    const tail = transcript.messages.slice(-RECENT_SESSION_MESSAGE_LIMIT);
    const body = capRecentSession(tail.map((message) => `${message.role === "user" ? "U" : "A"}: ${message.text}`).join("\n"), RECENT_SESSION_MAX_CHARS);

    debugLog(logger, "before_prompt_build", `recent session tail for file=${sessionFile}: messages=${tail.length} chars=${body.length}`);
    return body;
  } catch (error) {
    debugLog(logger, "before_prompt_build", `failed to build recent session tail for file=${sessionFile}: ${formatErrorMessage(error)}`);
    return "";
  }
}

/** Emits detailed diagnostics when the plugin logger supports debug level. */
function debugLog(logger: PluginLogger, subsystem: string, message: string): void {
  logger.debug?.(`[agenr] ${subsystem}: ${message}`);
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

/** Formats a concise entry reference list for debug logging. */
function formatEntryRefs(entries: OpenClawSessionStartRecall["core"]): string {
  if (entries.length === 0) {
    return "none";
  }

  return entries.map((entry) => `${entry.subject} [${entry.id}]`).join(", ");
}

/** Normalizes unknown failures into human-readable log messages. */
function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/** Caps recent-session excerpts from the end to keep the newest turns visible. */
function capRecentSession(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const marker = "[...truncated earlier recent session...]\n";
  return `${marker}${value.slice(-(maxChars - marker.length)).trimStart()}`;
}
