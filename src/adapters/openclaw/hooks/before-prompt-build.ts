import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import { recall } from "../../../core/recall/search.js";
import { listOpenClawCoreEntries, listOpenClawRecentEntries, listOpenClawRecentHandoffEntries } from "../../db/openclaw-plugin-queries.js";
import { formatAgenrSessionStartRecall } from "../format/recall-format.js";
import type {
  AgenrOpenClawBeforePromptBuildDeps,
  AgenrOpenClawBeforePromptBuildEvent,
  AgenrOpenClawBeforePromptBuildResult,
  AgenrOpenClawHookContext,
  AgenrOpenClawServices,
  OpenClawSessionStartRecall,
} from "../types.js";
import type { SessionStartTracker } from "../session/state.js";

const CORE_ENTRY_LIMIT = 4;
const HANDOFF_ENTRY_LIMIT = 2;
const RELEVANT_ENTRY_LIMIT = 5;
const RECENT_ENTRY_LIMIT = 3;

/**
 * Runs agenr session-start recall and injects the result into the OpenClaw prompt.
 *
 * @param event - Current prompt-build payload from OpenClaw.
 * @param ctx - Hook context with session identity data.
 * @param params - Shared services and session-start tracking state.
 * @returns Prompt mutation payload, or `undefined` when nothing should be injected.
 */
export async function handleAgenrBeforePromptBuild(
  event: AgenrOpenClawBeforePromptBuildEvent,
  ctx: AgenrOpenClawHookContext,
  params: AgenrOpenClawBeforePromptBuildDeps & {
    tracker: SessionStartTracker;
  },
): Promise<AgenrOpenClawBeforePromptBuildResult | undefined> {
  const sessionContext = formatSessionContext(ctx.sessionId, ctx.sessionKey);
  const trackerState = params.tracker.consume(ctx.sessionId, ctx.sessionKey);

  if (!trackerState.isFirst) {
    logDebug(params.logger, `[agenr] session tracker: duplicate start blocked for ${sessionContext}`);
    logDebug(params.logger, `[agenr] session tracker: now tracking ${trackerState.activeCount} active sessions`);
    params.logger.info(`[agenr] session-start recall skipped (already ran) for ${sessionContext}`);
    return undefined;
  }

  logDebug(params.logger, `[agenr] session tracker: first start for ${sessionContext}`);
  logDebug(params.logger, `[agenr] session tracker: now tracking ${trackerState.activeCount} active sessions`);
  params.logger.info(`[agenr] session-start recall for ${sessionContext}`);

  try {
    const services = await params.servicesPromise;
    const sessionStartRecall = await runAgenrSessionStartRecall(event.prompt, ctx.sessionId, ctx.sessionKey, services, params.logger);
    const prependContext = formatAgenrSessionStartRecall(sessionStartRecall);
    params.logger.info(
      `[agenr] session-start recall: ${sessionStartRecall.core.length} core, ${sessionStartRecall.handoffs.length} handoffs, ${sessionStartRecall.relevant.length} relevant, ${sessionStartRecall.recent.length} recent entries for ${sessionContext}`,
    );
    logDebug(params.logger, `[agenr] session-start core entries for ${sessionContext}: ${formatEntryRefs(sessionStartRecall.core)}`);
    logDebug(params.logger, `[agenr] session-start handoff entries for ${sessionContext}: ${formatEntryRefs(sessionStartRecall.handoffs)}`);
    logDebug(params.logger, `[agenr] session-start relevant entries for ${sessionContext}: ${formatRelevantRefs(sessionStartRecall.relevant)}`);
    logDebug(params.logger, `[agenr] session-start recent entries for ${sessionContext}: ${formatEntryRefs(sessionStartRecall.recent)}`);
    logDebug(params.logger, `[agenr] session-start prependContext length for ${sessionContext}: ${prependContext.length} chars`);

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
 * Composes the Phase 1 session-start recall payload from agenr core plus plugin-side browse queries.
 *
 * @param prompt - Current user prompt for the waking session.
 * @param sessionId - Ephemeral OpenClaw session UUID when available.
 * @param sessionKey - Stable OpenClaw session key when available.
 * @param services - Shared agenr adapters used by the plugin.
 * @param logger - Plugin logger used for session-start diagnostics.
 * @returns Structured recall sections ready for prompt formatting.
 */
export async function runAgenrSessionStartRecall(
  prompt: string,
  sessionId: string | undefined,
  sessionKey: string | undefined,
  services: AgenrOpenClawServices,
  logger: PluginLogger,
): Promise<OpenClawSessionStartRecall> {
  const core = await listOpenClawCoreEntries(services.database, CORE_ENTRY_LIMIT);
  const excludedIds = new Set(core.map((entry) => entry.id));
  const relevant = await runRelevantRecall(prompt, sessionId, sessionKey, services, logger);

  for (const result of relevant) {
    excludedIds.add(result.entry.id);
  }

  const handoffs = await listOpenClawRecentHandoffEntries(services.database, HANDOFF_ENTRY_LIMIT, [...excludedIds]);
  for (const entry of handoffs) {
    excludedIds.add(entry.id);
  }

  const recent = await listOpenClawRecentEntries(services.database, RECENT_ENTRY_LIMIT, [...excludedIds]);

  return {
    core,
    handoffs,
    relevant,
    recent,
  };
}

/** Runs prompt-conditioned recall only when embeddings are configured. */
async function runRelevantRecall(
  prompt: string,
  sessionId: string | undefined,
  sessionKey: string | undefined,
  services: AgenrOpenClawServices,
  logger: PluginLogger,
) {
  if (!services.embeddingStatus.available) {
    return [];
  }

  const normalizedPrompt = prompt.trim();
  if (normalizedPrompt.length === 0) {
    return [];
  }

  logDebug(logger, `[agenr] session-start relevant query for ${formatSessionContext(sessionId, sessionKey)}: ${JSON.stringify(normalizedPrompt)}`);

  try {
    return await recall(
      {
        text: normalizedPrompt,
        budget: 7,
        limit: RELEVANT_ENTRY_LIMIT,
        threshold: 0.2,
        sessionKey,
      },
      services.recall,
    );
  } catch (error) {
    logger.warn(`[agenr] session-start relevant recall failed for ${formatSessionContext(sessionId, sessionKey)}: ${formatErrorMessage(error)}`);
    return [];
  }
}

/** Emits a debug log only when the host logger exposes that level. */
function logDebug(logger: PluginLogger, message: string): void {
  logger.debug?.(message);
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

/** Formats relevant recall results with scores for debug logging. */
function formatRelevantRefs(results: OpenClawSessionStartRecall["relevant"]): string {
  if (results.length === 0) {
    return "none";
  }

  return results.map((result) => `${result.score.toFixed(2)} ${result.entry.subject} [${result.entry.id}]`).join(", ");
}

/** Normalizes unknown failures into human-readable log messages. */
function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
