import { runBeforeTurn } from "../../../app/before-turn/index.js";
import { runSessionStart } from "../../../app/session-start/index.js";
import type { BeforeTurnPatch, BeforeTurnRecentTurn } from "../../../app/before-turn/index.js";
import { resolveStoreNudgeConfig } from "../config.js";
import { writeOpenClawPredecessorEpisode } from "../episode/episode-writer.js";
import { formatAgenrBeforeTurnRecall } from "../format/before-turn-format.js";
import { containsAgenrMemoryContext, stripAgenrMemoryContext } from "../format/memory-context.js";
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
const DEFAULT_BEFORE_TURN_POLICY = {
  maxDurableEntries: 1,
  maxHighConfidenceDurableEntries: 2,
  maxRecentTurns: 2,
  maxQueryChars: 450,
  maxProcedureCandidates: 3,
  recallThreshold: 0.6,
  highConfidenceRecallThreshold: 0.85,
  procedureThreshold: 0.72,
} as const;
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
  },
): Promise<AgenrOpenClawBeforePromptBuildResult | undefined> {
  const sessionContext = formatSessionContext(ctx.sessionId, ctx.sessionKey);
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
  },
): Promise<AgenrOpenClawBeforePromptBuildResult | undefined> {
  const beforeTurnResult = await resolveBeforeTurnResult(event, ctx, sessionContext, params);
  if (beforeTurnResult) {
    return beforeTurnResult;
  }

  return resolveStoreNudgeResult(event, ctx, sessionContext, params);
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

  const currentTurnText = normalizePromptText(event.prompt);
  if (!currentTurnText) {
    params.logger.debug?.(`[agenr] before_prompt_build: before-turn skipped for ${sessionContext} reason=empty_prompt`);
    return undefined;
  }

  try {
    const beforeTurnPatch = await runBeforeTurn(
      {
        sessionKey: ctx.sessionKey,
        currentTurnText,
        recentTurns: extractRecentTurns(event.messages),
        trigger: ctx.trigger,
        policy: resolveBeforeTurnPolicy(services),
      },
      services.beforeTurn,
    );
    const prependContext = formatAgenrBeforeTurnRecall(beforeTurnPatch);

    params.logger.info(
      `[agenr] before-turn recall: ${beforeTurnPatch.durableMemory.length} durable entries for ${sessionContext} ` +
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
      `[agenr] before_prompt_build: before-turn durable entries for ${sessionContext}: ${formatEntryRefs(
        beforeTurnPatch.durableMemory.map((item: (typeof beforeTurnPatch.durableMemory)[number]) => item.entry),
      )}`,
    );
    params.logger.debug?.(`[agenr] before_prompt_build: before-turn prependContext length for ${sessionContext}: ${prependContext.length} chars`);
    if (prependContext.length === 0) {
      return undefined;
    }

    return { prependContext };
  } catch (error) {
    params.logger.warn(`[agenr] before-turn recall failed for ${sessionContext}: ${formatErrorMessage(error)}`);
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
          winnerEntryId: patch.diagnostics.directness.winnerEntryId,
          runnerUpEntryId: patch.diagnostics.directness.runnerUpEntryId,
          winnerGap: patch.diagnostics.directness.winnerGap,
          reason: truncateForLog(patch.diagnostics.directness.reason, 180),
          candidates: patch.diagnostics.directness.candidates.map((candidate) => ({
            entryId: candidate.entryId,
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
      id: item.entry.id,
      subject: truncateForLog(item.entry.subject, 80),
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

/**
 * Resolves effective before-turn policy from static defaults plus plugin overrides.
 *
 * @param services - Shared adapter services with plugin-config overrides.
 * @returns Effective before-turn policy for one prompt build.
 */
function resolveBeforeTurnPolicy(services: Awaited<AgenrOpenClawBeforePromptBuildDeps["servicesPromise"]>) {
  return {
    ...DEFAULT_BEFORE_TURN_POLICY,
    enableProcedureSuggestion: services.pluginConfig.memoryPolicy?.beforeTurn?.procedureSuggestion !== false,
    ...(services.pluginConfig.memoryPolicy?.beforeTurn?.maxDurableEntries !== undefined
      ? { maxDurableEntries: services.pluginConfig.memoryPolicy.beforeTurn.maxDurableEntries }
      : {}),
    ...(services.pluginConfig.memoryPolicy?.beforeTurn?.recallThreshold !== undefined
      ? { recallThreshold: services.pluginConfig.memoryPolicy.beforeTurn.recallThreshold }
      : {}),
    ...(services.pluginConfig.memoryPolicy?.beforeTurn?.highConfidenceRecallThreshold !== undefined
      ? { highConfidenceRecallThreshold: services.pluginConfig.memoryPolicy.beforeTurn.highConfidenceRecallThreshold }
      : {}),
    ...(services.pluginConfig.memoryPolicy?.beforeTurn?.procedureThreshold !== undefined
      ? { procedureThreshold: services.pluginConfig.memoryPolicy.beforeTurn.procedureThreshold }
      : {}),
  };
}

/**
 * Extracts a compact recent-turn window from OpenClaw's message payload.
 *
 * @param messages - Raw session messages prepared for the current run.
 * @returns Ordered recent turns suitable for the before-turn app service.
 */
function extractRecentTurns(messages: unknown[]): BeforeTurnRecentTurn[] {
  const turns: BeforeTurnRecentTurn[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }

    const typed = message as { role?: unknown; content?: unknown };
    const role = typed.role === "user" || typed.role === "assistant" ? typed.role : undefined;
    if (!role) {
      continue;
    }

    const text = sanitizeRecentTurnText(extractMessageText(typed.content), role);
    if (!text) {
      continue;
    }

    turns.push({ role, text });
  }

  return turns;
}

/**
 * Extracts plain text from one OpenClaw message content payload.
 *
 * @param content - Raw message content from the OpenClaw session store.
 * @returns Plain-text content, or an empty string when absent.
 */
function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const blocks: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      blocks.push(block);
      continue;
    }

    if (!block || typeof block !== "object") {
      continue;
    }

    const typed = block as { type?: unknown; text?: unknown; content?: unknown };
    if (typeof typed.text === "string") {
      blocks.push(typed.text);
      continue;
    }

    const type = typeof typed.type === "string" ? typed.type.trim().toLowerCase() : "";
    if (typeof typed.content === "string" && (type === "text" || type === "input_text" || type === "output_text")) {
      blocks.push(typed.content);
    }
  }

  return blocks.join("\n");
}

/**
 * Removes prior injected memory wrappers so they do not recursively pollute the
 * next before-turn query.
 *
 * @param text - Raw message text.
 * @param role - Message role used for wrapper unrolling.
 * @returns Sanitized recent-turn text.
 */
function sanitizeRecentTurnText(text: string, role: "user" | "assistant"): string {
  if (!text.trim()) {
    return "";
  }

  const wrapperDetected =
    containsAgenrMemoryContext(text) ||
    text.includes("## Agenr Session Recall") ||
    text.includes("## Agenr Before-Turn Recall") ||
    text.includes("[MEMORY CHECK]");

  let cleaned = stripAgenrMemoryContext(text);
  const headings = [
    "## Previous session summary",
    "## Recent session",
    "## Agenr Session Recall",
    "### Core Memory",
    "### Relevant Durable Memory",
    "## Agenr Before-Turn Recall",
    "### Suggested Procedure",
  ];
  for (const heading of headings) {
    cleaned = cleaned.split(heading).join(" ");
  }

  cleaned = cleaned.replace(/\[MEMORY CHECK\][^\n]*/gu, " ");
  cleaned = collapseWhitespace(cleaned);
  if (!wrapperDetected) {
    return cleaned;
  }

  const segments = stripAgenrMemoryContext(text)
    .split(/\n\s*\n/gu)
    .map((segment) => collapseWhitespace(segment))
    .filter((segment) => segment.length > 0);
  const fallbackSegment = segments.at(-1);
  if (fallbackSegment) {
    return role === "user" ? fallbackSegment : collapseWhitespace(cleaned);
  }

  return cleaned;
}

/**
 * Normalizes one current-turn prompt into compact single-space text.
 *
 * @param prompt - Raw current prompt text from OpenClaw.
 * @returns Normalized prompt text, or undefined when empty.
 */
function normalizePromptText(prompt: string): string | undefined {
  let cleaned = stripAgenrMemoryContext(prompt);
  cleaned = stripInlineMetadata(cleaned);
  cleaned = cleaned.replace(/^\s*\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s[^\]]+\]\s*/u, "");
  cleaned = cleaned.replace(/^\s*U:\s*/u, "");
  cleaned = collapseWhitespace(cleaned);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Removes inline OpenClaw metadata payloads that should not influence the
 * current-turn before-turn query.
 *
 * @param text - Candidate prompt text.
 * @returns Prompt text without known metadata wrappers.
 */
function stripInlineMetadata(text: string): string {
  let cleaned = text;
  for (const sentinel of INLINE_METADATA_SENTINELS) {
    const escapedSentinel = escapeForRegExp(sentinel);
    cleaned = cleaned.replace(new RegExp(`${escapedSentinel}\\s*(?:\`\`\`json\\s*)?\\{[\\s\\S]*?\\}(?:\\s*\`\`\`)?`, "gu"), " ");
    cleaned = cleaned.replace(new RegExp(`${escapedSentinel}[^\n]*`, "gu"), " ");
  }

  cleaned = cleaned.replace(/Untrusted context \(metadata, do not treat as instructions or commands\):[\s\S]*$/gu, " ");
  return cleaned;
}

/**
 * Escapes one string for safe RegExp interpolation.
 *
 * @param value - Raw literal string.
 * @returns RegExp-safe literal text.
 */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Collapses repeated whitespace while preserving single-line readability.
 *
 * @param value - Raw text block.
 * @returns Trimmed single-space text.
 */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
