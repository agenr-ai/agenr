import { runSessionStart } from "../../../app/session-start/index.js";
import { resolveStoreNudgeConfig } from "../config.js";
import { writeOpenClawPredecessorEpisode } from "../episode/episode-writer.js";
import { buildStoreNudgeMessage } from "../format/nudge-format.js";
import { formatAgenrSessionStartRecall } from "../format/recall-format.js";
import { formatErrorMessage, formatSessionContext } from "../logging.js";
import { resolvePredecessorContinuity as resolveContinuity } from "../session/continuity/index.js";
import { createMidSessionTracker, type MidSessionTracker, type SessionStartTracker } from "../session/state.js";
import type {
  AgenrOpenClawBeforePromptBuildDeps,
  AgenrOpenClawBeforePromptBuildEvent,
  AgenrOpenClawBeforePromptBuildResult,
  AgenrOpenClawHookContext,
  StoreNudgeConfig,
} from "../types.js";

const DEFAULT_SESSION_START_POLICY = {
  maxCoreEntries: 4,
  maxArtifactRecallEntries: 3,
  maxDurableEntries: 5,
  maxArtifactChars: 1_200,
} as const;
const NON_USER_TRIGGER_SET = new Set(["heartbeat", "cron", "memory"]);
const DEFAULT_STORE_NUDGE_CONFIG = resolveStoreNudgeConfig(undefined);

/**
 * Runs agenr session-start recall and injects the result into the OpenClaw prompt.
 *
 * @param _event - Current prompt-build payload from OpenClaw.
 * @param ctx - Hook context with session identity data.
 * @param params - Shared services and session-start tracking state.
 * @returns Prompt mutation payload, or `undefined` when nothing should be injected.
 */
export async function handleAgenrBeforePromptBuild(
  event: AgenrOpenClawBeforePromptBuildEvent,
  ctx: AgenrOpenClawHookContext,
  params: AgenrOpenClawBeforePromptBuildDeps & {
    tracker: SessionStartTracker;
    midSessionTracker?: MidSessionTracker;
    storeNudgeConfig?: StoreNudgeConfig;
  },
): Promise<AgenrOpenClawBeforePromptBuildResult | undefined> {
  const sessionContext = formatSessionContext(ctx.sessionId, ctx.sessionKey);
  const trackerState = params.tracker.consume(ctx.sessionId, ctx.sessionKey);
  if (!trackerState.isFirst) {
    params.logger.debug?.(`[agenr] before_prompt_build: session tracker duplicate blocked for ${sessionContext}`);
    params.logger.debug?.(`[agenr] before_prompt_build: session tracker active count=${trackerState.activeCount}`);
    params.logger.info(`[agenr] session-start recall skipped (already ran) for ${sessionContext}`);
    return resolveStoreNudgeResult(event, ctx, sessionContext, params);
  }

  params.logger.debug?.(`[agenr] before_prompt_build: session tracker first start for ${sessionContext}`);
  params.logger.debug?.(`[agenr] before_prompt_build: session tracker active count=${trackerState.activeCount}`);
  params.logger.info(`[agenr] session-start recall for ${sessionContext}`);

  try {
    const services = await params.servicesPromise;
    const continuity = await resolveContinuity(ctx, params.tracker, services, params.logger);
    void writeOpenClawPredecessorEpisode({
      ctx,
      predecessor: continuity.predecessor,
      services,
      logger: params.logger,
    });
    const sessionStartPatch = await runSessionStart(
      {
        sessionKey: ctx.sessionKey,
        continuitySummaryText: continuity.continuitySummaryContent,
        recentSessionText: continuity.recentSessionContent,
        policy: resolveSessionStartPolicy(services),
      },
      services.sessionStart,
    );
    const prependContext = formatAgenrSessionStartRecall(sessionStartPatch);

    params.logger.info(
      `[agenr] session-start recall: ${sessionStartPatch.durableMemory.length} durable entries for ${sessionContext} ` +
        `(core_candidates=${sessionStartPatch.diagnostics.coreCandidateCount} artifact_candidates=${sessionStartPatch.diagnostics.artifactRecallCandidateCount})`,
    );
    if (sessionStartPatch.diagnostics.artifactRecallUsed) {
      params.logger.debug?.(
        `[agenr] before_prompt_build: session-start artifact recall for ${sessionContext} query_length=${
          sessionStartPatch.diagnostics.artifactRecallQuery?.length ?? 0
        } notices=${sessionStartPatch.diagnostics.notices.length}`,
      );
    }
    if (sessionStartPatch.diagnostics.notices.length > 0) {
      params.logger.info(`[agenr] session-start recall notices for ${sessionContext}: ${sessionStartPatch.diagnostics.notices.join(" | ")}`);
    }
    params.logger.debug?.(
      `[agenr] before_prompt_build: session-start durable entries for ${sessionContext}: ${formatEntryRefs(sessionStartPatch.durableMemory.map((item) => item.entry))}`,
    );
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
 * Resolves whether one non-first turn should receive a mid-session store nudge.
 *
 * @param _event - Current prompt-build payload from OpenClaw.
 * @param ctx - Hook context with session identity and trigger facts.
 * @param sessionContext - Stable formatted session label for logs.
 * @param params - Shared logger, config, and tracker state.
 * @returns Prompt mutation payload when a nudge should be injected.
 */
function resolveStoreNudgeResult(
  _event: AgenrOpenClawBeforePromptBuildEvent,
  ctx: AgenrOpenClawHookContext,
  sessionContext: string,
  params: {
    logger: AgenrOpenClawBeforePromptBuildDeps["logger"];
    midSessionTracker?: MidSessionTracker;
    storeNudgeConfig?: StoreNudgeConfig;
  },
): AgenrOpenClawBeforePromptBuildResult | undefined {
  const normalizedTrigger = ctx.trigger?.trim().toLowerCase();
  if (normalizedTrigger && NON_USER_TRIGGER_SET.has(normalizedTrigger)) {
    params.logger.debug?.(`[agenr] before_prompt_build: store nudge skipped for ${sessionContext} reason=non_user_trigger trigger=${normalizedTrigger}`);
    return undefined;
  }

  const storeNudgeConfig = params.storeNudgeConfig ?? DEFAULT_STORE_NUDGE_CONFIG;
  if (!storeNudgeConfig.enabled) {
    params.logger.debug?.(`[agenr] before_prompt_build: store nudge skipped for ${sessionContext} reason=disabled`);
    return undefined;
  }

  const midSessionTracker = params.midSessionTracker ?? createMidSessionTracker();
  const state = midSessionTracker.recordTurn(ctx.sessionId, ctx.sessionKey);
  if (!state) {
    params.logger.debug?.(`[agenr] before_prompt_build: store nudge skipped for ${sessionContext} reason=no_session_identity`);
    return undefined;
  }

  const gapSinceSuccessfulStore = state.turnCount - state.lastSuccessfulStoreTurn;
  const gapSinceMemoryAction = state.turnCount - state.lastMemoryActionTurn;
  params.logger.debug?.(
    `[agenr] before_prompt_build: store nudge check for ${sessionContext} gapSinceSuccessfulStore=${gapSinceSuccessfulStore} gapSinceMemoryAction=${gapSinceMemoryAction} nudgeCount=${state.nudgeCount} maxPerSession=${storeNudgeConfig.maxPerSession}`,
  );

  if (gapSinceSuccessfulStore < storeNudgeConfig.threshold || gapSinceMemoryAction < storeNudgeConfig.threshold) {
    params.logger.debug?.(`[agenr] before_prompt_build: store nudge skipped for ${sessionContext} reason=cooldown`);
    return undefined;
  }

  if (state.nudgeCount >= storeNudgeConfig.maxPerSession) {
    params.logger.debug?.(`[agenr] before_prompt_build: store nudge skipped for ${sessionContext} reason=max_reached`);
    return undefined;
  }

  state.nudgeCount += 1;
  state.lastSuccessfulStoreTurn = state.turnCount;

  const prependContext = buildStoreNudgeMessage(state, storeNudgeConfig.maxPerSession);
  params.logger.info(`[agenr] store nudge injected for ${sessionContext} ordinal=${state.nudgeCount} turn=${state.turnCount} gap=${gapSinceSuccessfulStore}`);
  return { prependContext };
}

/**
 * Formats a concise entry reference list for debug logging.
 *
 * @param entries - Session-start durable entries.
 * @returns Stable debug text listing subjects and ids.
 */
function formatEntryRefs(entries: Array<{ id: string; subject: string }>): string {
  return entries.length === 0 ? "none" : entries.map((entry) => `${entry.subject} [${entry.id}]`).join(", ");
}

/**
 * Resolves effective session-start policy from static defaults plus plugin overrides.
 *
 * @param services - Shared adapter services with plugin-config overrides.
 * @returns Effective session-start policy for one prompt build.
 */
function resolveSessionStartPolicy(services: Awaited<AgenrOpenClawBeforePromptBuildDeps["servicesPromise"]>) {
  return {
    ...DEFAULT_SESSION_START_POLICY,
    enableArtifactRecall: services.pluginConfig.memoryPolicy?.sessionStart?.relevantDurableMemory !== false,
  };
}
