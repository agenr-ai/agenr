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
  if (!params.tracker.consume(ctx.sessionId, ctx.sessionKey)) {
    return undefined;
  }

  try {
    const services = await params.servicesPromise;
    const sessionStartRecall = await runAgenrSessionStartRecall(event.prompt, ctx.sessionKey, services, params.logger);
    const prependContext = formatAgenrSessionStartRecall(sessionStartRecall);

    if (prependContext.length === 0) {
      return undefined;
    }

    return { prependContext };
  } catch (error) {
    params.logger.warn(`agenr before_prompt_build setup failed: ${formatErrorMessage(error)}`);
    return undefined;
  }
}

/**
 * Composes the Phase 1 session-start recall payload from agenr core plus plugin-side browse queries.
 *
 * @param prompt - Current user prompt for the waking session.
 * @param sessionKey - Stable OpenClaw session key when available.
 * @param services - Shared agenr adapters used by the plugin.
 * @param logger - Plugin logger used for degraded-mode warnings.
 * @returns Structured recall sections ready for prompt formatting.
 */
export async function runAgenrSessionStartRecall(
  prompt: string,
  sessionKey: string | undefined,
  services: AgenrOpenClawServices,
  logger: PluginLogger,
): Promise<OpenClawSessionStartRecall> {
  const core = await listOpenClawCoreEntries(services.database, CORE_ENTRY_LIMIT);
  const excludedIds = new Set(core.map((entry) => entry.id));
  const relevant = await runRelevantRecall(prompt, sessionKey, services, logger);

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
async function runRelevantRecall(prompt: string, sessionKey: string | undefined, services: AgenrOpenClawServices, logger: PluginLogger) {
  if (!services.embeddingStatus.available) {
    return [];
  }

  const normalizedPrompt = prompt.trim();
  if (normalizedPrompt.length === 0) {
    return [];
  }

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
    logger.warn(`agenr before_prompt_build recall failed: ${formatErrorMessage(error)}`);
    return [];
  }
}

/** Normalizes unknown failures into human-readable log messages. */
function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
