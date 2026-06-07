import { randomUUID } from "node:crypto";

import { runBeforeTurn } from "../../../app/before-turn/index.js";
import { runSessionStart } from "../../../app/session-start/index.js";
import type { BeforeTurnPatch } from "../../../app/before-turn/index.js";
import { resolveStoreNudgeConfig } from "../config.js";
import { formatAgenrBeforeTurnRecall } from "../format/before-turn-format.js";
import { extractRecentTurnsFromMessages, normalizePromptText } from "../../shared/injection/message-text.js";
import { resolveBeforeTurnPolicy, resolveSessionStartPolicy } from "../../shared/injection/policy.js";
import { buildStoreNudgeMessage } from "../format/nudge-format.js";
import { formatAgenrSessionStartRecall } from "../format/recall-format.js";
import { resolveOpenClawCompactionPromptContext } from "./compaction-handlers.js";
import { formatErrorMessage, formatSessionContext } from "../logging.js";
import type { CompactionPromptTracker } from "../../shared/compaction-prompt-tracker.js";
import { mergeInjectionContent } from "../../shared/injection/merge-injection-content.js";
import type { SessionLifecycleIntakeTracker } from "../../../app/plugin-runtime/session-lifecycle-intake.js";
import type { SessionStartTracker } from "../../../app/plugin-runtime/session-tracking.js";
import { createMidSessionTracker, type MidSessionTracker } from "../session/state.js";
import type {
  AgenrOpenClawBeforePromptBuildDeps,
  AgenrOpenClawBeforePromptBuildEvent,
  AgenrOpenClawBeforePromptBuildResult,
  AgenrOpenClawHookContext,
  StoreNudgeConfig,
} from "../types.js";

const NON_USER_TRIGGER_SET = new Set(["heartbeat", "cron", "memory"]);
const DEFAULT_STORE_NUDGE_CONFIG = resolveStoreNudgeConfig(undefined);
const INLINE_METADATA_SENTINELS = [
  "Sender (untrusted metadata):",
  "Conversation info (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
] as const;

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
    compactionPromptTracker?: CompactionPromptTracker;
    lifecycleIntakeTracker?: SessionLifecycleIntakeTracker;
  },
): Promise<AgenrOpenClawBeforePromptBuildResult | undefined> {
  const sessionContext = formatSessionContext(ctx.sessionId, ctx.sessionKey);
  await params.lifecycleIntakeTracker?.wait(ctx.sessionId, ctx.sessionKey);
  const trackerState = params.tracker.consume(ctx.sessionId, ctx.sessionKey);
  if (!trackerState.isFirst) {
    params.logger.debug?.(`[agenr] before_prompt_build: session tracker duplicate blocked for ${sessionContext}`);
    params.logger.debug?.(`[agenr] before_prompt_build: session tracker active count=${trackerState.activeCount}`);
    params.logger.info(`[agenr] session-start recall skipped (already ran) for ${sessionContext}`);
    return await resolveNonFirstTurnResult(event, ctx, sessionContext, params);
  }

  params.logger.debug?.(`[agenr] before_prompt_build: session tracker first start for ${sessionContext}`);
  params.logger.debug?.(`[agenr] before_prompt_build: session tracker active count=${trackerState.activeCount}`);
  params.logger.info(`[agenr] session-start recall for ${sessionContext}`);

  try {
    const services = await params.servicesPromise;
    if (services.pluginConfig.memoryPolicy?.sessionStart?.enabled === false) {
      params.logger.info(`[agenr] session-start recall disabled by memoryPolicy for ${sessionContext}`);
      return await resolveNonFirstTurnResult(event, ctx, sessionContext, params);
    }

    const sessionStartPatch = await runSessionStart(
      {
        sessionKey: ctx.sessionKey,
        policy: resolveSessionStartPolicy(services.pluginConfig.memoryPolicy),
      },
      services.sessionStart,
    );
    const prependContext = formatAgenrSessionStartRecall(sessionStartPatch);
    if (services.debugSink.enabled) {
      void services.debugSink.emit({
        type: "session_start_recall",
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
        debug: {
          durableMemoryCount: sessionStartPatch.durableMemory.length,
          selectedDurableIds: sessionStartPatch.durableMemory.map((item) => item.durable.id),
          coreCandidateCount: sessionStartPatch.diagnostics.coreCandidateCount,
          artifactRecallCandidateCount: sessionStartPatch.diagnostics.artifactRecallCandidateCount,
          artifactRecallUsed: sessionStartPatch.diagnostics.artifactRecallUsed,
          notices: [...sessionStartPatch.diagnostics.notices],
        },
      });
    }

    params.logger.info(
      `[agenr] session-start recall: ${sessionStartPatch.durableMemory.length} durables for ${sessionContext} ` +
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
      `[agenr] before_prompt_build: session-start durables for ${sessionContext}: ${formatDurableRefs(sessionStartPatch.durableMemory.map((item) => item.durable))}`,
    );
    params.logger.debug?.(`[agenr] before_prompt_build: session-start prependContext length for ${sessionContext}: ${prependContext.length} chars`);
    if (prependContext.length === 0) {
      params.logger.info(`[agenr] session-start recall: nothing to inject for ${sessionContext}`);
      return undefined;
    }

    return { prependContext };
  } catch (error) {
    params.logger.warn(`[agenr] session-start recall failed for ${sessionContext}: ${formatErrorMessage(error)}`);
    try {
      const services = await params.servicesPromise;
      if (services.debugSink.enabled) {
        void services.debugSink.emit({
          type: "error",
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
          scope: "session_start_recall",
          error: { message: error instanceof Error ? error.message : String(error) },
        });
      }
    } catch {
      // Ignore debug-sink emission failures to keep the runtime path resilient.
    }
    return undefined;
  }
}

/**
 * Resolves one non-first prompt-build turn by trying before-turn recall first,
 * then falling back to the mid-session store nudge path when appropriate.
 *
 * @param event - Current prompt-build payload from OpenClaw.
 * @param ctx - Hook context with session identity and trigger facts.
 * @param sessionContext - Stable formatted session label for logs.
 * @param params - Shared logger, config, services, and tracker state.
 * @returns Prompt mutation payload when a patch or nudge should be injected.
 */
async function resolveNonFirstTurnResult(
  event: AgenrOpenClawBeforePromptBuildEvent,
  ctx: AgenrOpenClawHookContext,
  sessionContext: string,
  params: AgenrOpenClawBeforePromptBuildDeps & {
    midSessionTracker?: MidSessionTracker;
    storeNudgeConfig?: StoreNudgeConfig;
    compactionPromptTracker?: CompactionPromptTracker;
  },
): Promise<AgenrOpenClawBeforePromptBuildResult | undefined> {
  const services = await params.servicesPromise;
  const compactionContext = params.compactionPromptTracker
    ? await resolveOpenClawCompactionPromptContext(ctx, services, params.compactionPromptTracker)
    : undefined;
  if (compactionContext) {
    params.logger.info(`[agenr] compaction recall injected for ${sessionContext}`);
  }

  const beforeTurnResult = await resolveBeforeTurnResult(event, ctx, sessionContext, params);
  if (beforeTurnResult?.prependContext || compactionContext) {
    return {
      prependContext: mergeInjectionContent(compactionContext, beforeTurnResult?.prependContext),
    };
  }

  const storeNudgeResult = await resolveStoreNudgeResult(event, ctx, sessionContext, params);
  if (storeNudgeResult?.prependContext || compactionContext) {
    return {
      prependContext: mergeInjectionContent(compactionContext, storeNudgeResult?.prependContext),
    };
  }

  return compactionContext ? { prependContext: compactionContext } : undefined;
}

/**
 * Runs proactive before-turn selection for eligible user turns.
 *
 * @param event - Current prompt-build payload from OpenClaw.
 * @param ctx - Hook context with session identity and trigger facts.
 * @param sessionContext - Stable formatted session label for logs.
 * @param params - Shared logger and runtime services.
 * @returns Prompt mutation payload when a before-turn patch should be injected.
 */
async function resolveBeforeTurnResult(
  event: AgenrOpenClawBeforePromptBuildEvent,
  ctx: AgenrOpenClawHookContext,
  sessionContext: string,
  params: AgenrOpenClawBeforePromptBuildDeps,
): Promise<AgenrOpenClawBeforePromptBuildResult | undefined> {
  const normalizedTrigger = ctx.trigger?.trim().toLowerCase();
  if (normalizedTrigger && NON_USER_TRIGGER_SET.has(normalizedTrigger)) {
    params.logger.debug?.(`[agenr] before_prompt_build: before-turn skipped for ${sessionContext} reason=non_user_trigger trigger=${normalizedTrigger}`);
    return undefined;
  }

  const services = await params.servicesPromise;
  if (services.pluginConfig.memoryPolicy?.beforeTurn?.enabled === false) {
    params.logger.debug?.(`[agenr] before_prompt_build: before-turn skipped for ${sessionContext} reason=disabled`);
    return undefined;
  }

  const currentTurnText = normalizePromptText(event.prompt, {
    stripInlineMetadata: true,
    inlineMetadataSentinels: INLINE_METADATA_SENTINELS,
    stripTimestampPrefix: true,
    stripUserPrefix: true,
  });
  if (!currentTurnText) {
    params.logger.debug?.(`[agenr] before_prompt_build: before-turn skipped for ${sessionContext} reason=empty_prompt`);
    return undefined;
  }

  try {
    const beforeTurnPatch = await runBeforeTurn(
      {
        sessionKey: ctx.sessionKey,
        currentTurnText,
        recentTurns: extractRecentTurnsFromMessages(
          event.messages.filter((message): message is { role?: unknown; content?: unknown } => Boolean(message) && typeof message === "object"),
          { stripMemoryCheck: true },
        ),
        trigger: ctx.trigger,
        policy: resolveBeforeTurnPolicy(services.pluginConfig.memoryPolicy),
      },
      services.beforeTurn,
    );
    const prependContext = formatAgenrBeforeTurnRecall(beforeTurnPatch);
    if (services.debugSink.enabled) {
      const { buildLiveBeforeTurnDebugArtifact } = await import("../debug/build-before-turn-artifact.js");
      void services.debugSink.emit({
        type: "before_turn_decision",
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
        debug: buildLiveBeforeTurnDebugArtifact({
          caseId: `live-${randomUUID()}`,
          patch: beforeTurnPatch,
          currentTurnText,
          trigger: ctx.trigger,
          eventLevel: services.debugSink.eventLevel,
          maxTopCandidates: services.debugSink.maxTopCandidates,
        }),
      });
    }

    params.logger.info(
      `[agenr] before-turn recall: ${beforeTurnPatch.durableMemory.length} durables for ${sessionContext} ` +
        `(durable_candidates=${beforeTurnPatch.diagnostics.durableRecallCandidateCount} procedure_candidates=${beforeTurnPatch.diagnostics.procedureCandidateCount})`,
    );
    if (beforeTurnPatch.procedure) {
      params.logger.info(
        `[agenr] before-turn procedure suggestion for ${sessionContext}: ${beforeTurnPatch.procedure.procedure.procedure_key} score=${beforeTurnPatch.procedure.score.toFixed(2)}`,
      );
    }
    if (beforeTurnPatch.diagnostics.notices.length > 0) {
      params.logger.info(`[agenr] before-turn recall notices for ${sessionContext}: ${beforeTurnPatch.diagnostics.notices.join(" | ")}`);
    }
    if (beforeTurnPatch.diagnostics.abstained) {
      params.logger.debug?.(
        `[agenr] before_prompt_build: before-turn abstained for ${sessionContext}: category=${
          beforeTurnPatch.diagnostics.suppressedTurnCategory ?? "none"
        } signals=${
          beforeTurnPatch.diagnostics.turnSignalLabels.join(",") || "none"
        } reasons=${beforeTurnPatch.diagnostics.abstentionReasons.join(" | ") || "none"}`,
      );
    }
    params.logger.debug?.(`[agenr] before_prompt_build: before-turn diagnostics for ${sessionContext}: ${formatBeforeTurnDiagnosticsForLog(beforeTurnPatch)}`);
    params.logger.debug?.(
      `[agenr] before_prompt_build: before-turn durables for ${sessionContext}: ${formatDurableRefs(
        beforeTurnPatch.durableMemory.map((item: (typeof beforeTurnPatch.durableMemory)[number]) => item.durable),
      )}`,
    );
    params.logger.debug?.(`[agenr] before_prompt_build: before-turn prependContext length for ${sessionContext}: ${prependContext.length} chars`);
    if (prependContext.length === 0) {
      return undefined;
    }

    return { prependContext };
  } catch (error) {
    params.logger.warn(`[agenr] before-turn recall failed for ${sessionContext}: ${formatErrorMessage(error)}`);
    try {
      if (services.debugSink.enabled) {
        void services.debugSink.emit({
          type: "error",
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
          scope: "before_turn_decision",
          error: { message: error instanceof Error ? error.message : String(error) },
        });
      }
    } catch {
      // Ignore debug-sink emission failures to keep the runtime path resilient.
    }
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
 * Formats a concise durable reference list for debug logging.
 *
 * @param durables - Session-start or before-turn durables.
 * @returns Stable debug text listing subjects and ids.
 */
function formatDurableRefs(durables: Array<{ id: string; subject: string }>): string {
  return durables.length === 0 ? "none" : durables.map((durable) => `${durable.subject} [${durable.id}]`).join(", ");
}

/**
 * Formats one compact structured before-turn diagnostics payload for logs.
 *
 * @param patch - Structured before-turn patch returned by the app layer.
 * @returns One-line JSON string suitable for debug logging.
 */
function formatBeforeTurnDiagnosticsForLog(patch: BeforeTurnPatch): string {
  return JSON.stringify({
    query: truncateForLog(patch.diagnostics.query, 160),
    queryPolicy: patch.diagnostics.queryPolicy,
    queryVariants: patch.diagnostics.queryVariants.map((variant) => ({
      kind: variant.kind,
      query: truncateForLog(variant.query, 120),
      candidateCount: variant.candidateCount,
      selected: variant.selected,
    })),
    turnSignalLabels: patch.diagnostics.turnSignalLabels,
    suppressedTurnCategory: patch.diagnostics.suppressedTurnCategory,
    durableRecallCandidateCount: patch.diagnostics.durableRecallCandidateCount,
    procedureCandidateCount: patch.diagnostics.procedureCandidateCount,
    directness: patch.diagnostics.directness
      ? {
          queryKind: patch.diagnostics.directness.queryKind,
          entity: patch.diagnostics.directness.entity,
          decision: patch.diagnostics.directness.decision,
          winnerDurableId: patch.diagnostics.directness.winnerDurableId,
          runnerUpDurableId: patch.diagnostics.directness.runnerUpDurableId,
          winnerGap: patch.diagnostics.directness.winnerGap,
          reason: truncateForLog(patch.diagnostics.directness.reason, 180),
          candidates: patch.diagnostics.directness.candidates.map((candidate) => ({
            durableId: candidate.durableId,
            baseRank: candidate.baseRank,
            baseScore: candidate.baseScore,
            directnessDelta: candidate.directnessDelta,
            adjustedScore: candidate.adjustedScore,
            signals: candidate.signals,
          })),
        }
      : undefined,
    abstained: patch.diagnostics.abstained,
    abstentionReasons: patch.diagnostics.abstentionReasons.map((reason) => truncateForLog(reason, 180)),
    notices: patch.diagnostics.notices.map((notice) => truncateForLog(notice, 180)),
    selectedEntries: patch.durableMemory.map((item) => ({
      id: item.durable.id,
      subject: truncateForLog(item.durable.subject, 80),
      score: Number(item.score.toFixed(3)),
    })),
    procedure: patch.procedure
      ? {
          procedureKey: patch.procedure.procedure.procedure_key,
          score: Number(patch.procedure.score.toFixed(3)),
        }
      : undefined,
  });
}

/**
 * Truncates multiline or oversized values into one stable log-friendly string.
 *
 * @param value - Optional raw text value.
 * @param maxChars - Maximum output length.
 * @returns One-line truncated value, or undefined when empty.
 */
function truncateForLog(value: string | undefined, maxChars: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
