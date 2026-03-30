import { listOpenClawCoreEntries } from "../../db/openclaw-plugin-queries.js";
import { formatAgenrSessionStartRecall } from "../format/recall-format.js";
import { formatErrorMessage, formatSessionContext } from "../logging.js";
import { resolvePredecessorContinuity as resolveContinuity } from "../session/continuity/index.js";
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
  params: AgenrOpenClawBeforePromptBuildDeps & { tracker: SessionStartTracker },
): Promise<AgenrOpenClawBeforePromptBuildResult | undefined> {
  const sessionContext = formatSessionContext(ctx.sessionId, ctx.sessionKey);
  const trackerState = params.tracker.consume(ctx.sessionId, ctx.sessionKey);
  if (!trackerState.isFirst) {
    params.logger.debug?.(`[agenr] before_prompt_build: session tracker duplicate blocked for ${sessionContext}`);
    params.logger.debug?.(`[agenr] before_prompt_build: session tracker active count=${trackerState.activeCount}`);
    params.logger.info(`[agenr] session-start recall skipped (already ran) for ${sessionContext}`);
    return undefined;
  }

  params.logger.debug?.(`[agenr] before_prompt_build: session tracker first start for ${sessionContext}`);
  params.logger.debug?.(`[agenr] before_prompt_build: session tracker active count=${trackerState.activeCount}`);
  params.logger.info(`[agenr] session-start recall for ${sessionContext}`);

  try {
    const services = await params.servicesPromise;
    const continuity = await resolveContinuity(ctx, params.tracker, services, params.logger);
    const sessionStartRecall = await runAgenrSessionStartRecall(services);
    const memoryContext = formatAgenrSessionStartRecall(sessionStartRecall);
    const sections = [
      continuity.continuitySummaryContent && `## Previous session summary\n${continuity.continuitySummaryContent}`,
      continuity.recentSessionContent && `## Recent session\n${continuity.recentSessionContent}`,
      memoryContext,
    ].filter((value): value is string => Boolean(value && value.trim().length > 0));
    const prependContext = sections.join("\n\n");

    params.logger.info(`[agenr] session-start recall: ${sessionStartRecall.core.length} core entries for ${sessionContext}`);
    params.logger.debug?.(`[agenr] before_prompt_build: session-start core entries for ${sessionContext}: ${formatEntryRefs(sessionStartRecall.core)}`);
    params.logger.debug?.(`[agenr] before_prompt_build: session-start prependContext length for ${sessionContext}: ${prependContext.length} chars`);
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
  return { core: await listOpenClawCoreEntries(services.database, CORE_ENTRY_LIMIT) };
}

/**
 * Formats a concise entry reference list for debug logging.
 *
 * @param entries - Core session-start recall entries.
 * @returns Stable debug text listing subjects and ids.
 */
function formatEntryRefs(entries: OpenClawSessionStartRecall["core"]): string {
  return entries.length === 0 ? "none" : entries.map((entry) => `${entry.subject} [${entry.id}]`).join(", ");
}
