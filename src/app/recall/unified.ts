import type { EpisodeDatabasePort, ProcedureDatabasePort, RecallPorts } from "../../core/ports.js";
import type { ClaimSlotPolicyConfig } from "../../core/claim-slot-policy.js";
import { tokenize } from "../../core/recall/lexical.js";
import { recall } from "../../core/recall/search.js";
import { parseTemporalWindow } from "../../core/episode/temporal-window.js";
import { searchEpisodes } from "../../core/episode/search.js";
import type { EpisodeCrossEncoderOptions, EpisodeMmrOptions } from "../../core/episode/types.js";
import type { RecallExecutionOptions, RecallExecutionTraceSummary, RecallRankingPolicy, RecallTraceSink } from "../../core/recall/trace.js";
import type { EntityAttributeKind, EntityAttributeQueryShape, RecallInput } from "../../core/recall/types.js";
import type { ProcedureCrossEncoderOptions, ProcedureMmrOptions } from "../procedures/recall/types.js";
import { runProcedureRecall } from "../procedures/recall/service.js";

import { flattenClaimCentricRecallFamilies, projectClaimCentricRecallEntries } from "./claim-centric.js";
import { buildClaimTransitionExplanations } from "./transitions.js";
import type { UnifiedRecallInput, UnifiedRecallMode, UnifiedRecallResult, UnifiedRecallRouting } from "./types.js";

const EPISODE_FRESHNESS_NOTICE = "Episodes cover consolidated prior sessions only; the most recent completed session may not appear yet.";
const EPISODE_SEMANTIC_FALLBACK_NOTICE = "Semantic episode search unavailable - showing temporal results only.";
const EPISODE_SEMANTIC_UNAVAILABLE_NOTICE = "Semantic episode search unavailable - no semantic episode results could be returned.";
const ENTRY_FILTER_NOTICE = "Type and tag filters were applied to entries only.";
const HISTORICAL_STATE_PATTERNS = [
  "what was the previous",
  "what was the earlier",
  "what did we use before",
  "what was the old",
  "what changed",
  "changed from",
  "replaced by",
  "before we switched",
  "before we migrated",
  "previous approach",
  "earlier plan",
  "old workflow",
] as const;
const HISTORICAL_STATE_REGEX_PATTERNS = [
  /\bwhat\b.*\bused?\b.*\bbefore\b/u,
  /\bwhat\b.*\bworkflow\b.*\bbefore\b/u,
  /\bwhat\b.*\bplan\b.*\bearlier\b/u,
  /\bwhat\b.*\bplan\b.*\bbefore\b/u,
] as const;
const PROCEDURAL_PATTERNS = [
  "how do i",
  "how should i",
  "how can i",
  "what steps",
  "which steps",
  "walk me through",
  "guide me through",
  "step by step",
  "step-by-step",
  "checklist for",
  "process for",
  "procedure for",
  "method for",
  "instructions for",
  "best way to",
  "recommended way to",
] as const;
const PROCEDURAL_REGEX_PATTERNS = [
  /\bhow (?:do|should|can) (?:i|we)\b/u,
  /\bhow to\b/u,
  /\bwhat (?:are the )?steps\b/u,
  /\bwhich steps\b/u,
  /\bwalk me through\b/u,
  /\bguide me through\b/u,
  /\bstep(?: |-)?by(?: |-)?step\b/u,
  /\b(?:checklist|playbook|runbook|procedure|process|instructions?|workflow|method)\b.*\b(?:for|to)\b/u,
  /\bwhat(?:'s| is) the (?:best|recommended|right) way to\b/u,
] as const;
const ENTITY_ATTRIBUTE_MAX_WORDS = 5;
const ENTITY_ATTRIBUTE_CONTEXTUAL_PREFIX_RE = /^(?:on|in|at|for|about|during|after|before)\b/u;
const ENTITY_ATTRIBUTE_CONTEXTUAL_TIME_RE =
  /\b(?:today|tomorrow|yesterday|tonight|currently|right now|this week|next week|last week|this month|next month|last month|this year|next year|last year)\b/u;
const ENTITY_ATTRIBUTE_CONTEXTUAL_ACTIVITY_RE = /\b(?:on call|available|working|assigned|scheduled|responsible)\b/u;
const ENTITY_ATTRIBUTE_GENERIC_ENTITY_RE = /^(?:it|this|that|these|those|they|them|he|she|someone|anyone|anything|everything)\b/u;
const ENTITY_ATTRIBUTE_KIND_TOKENS: Readonly<Record<EntityAttributeKind, readonly string[]>> = {
  identity: ["identity", "profile", "bio", "biography", "summary"],
  location: ["location", "live", "lives", "reside", "resides", "located", "home", "city"],
  email: ["email", "e-mail", "mail"],
  phone: ["phone", "number", "mobile", "cell", "telephone"],
  address: ["address", "street", "mailing"],
};

/**
 * Dependencies needed by the unified recall orchestration layer.
 */
export interface UnifiedRecallDeps {
  database: EpisodeDatabasePort;
  procedures: ProcedureDatabasePort;
  recall: RecallPorts;
  embeddingAvailable: boolean;
  embeddingError?: string;
  embedQuery?: (text: string) => Promise<number[]>;
  recallOptions?: RecallExecutionOptions;
  claimSlotPolicyConfig?: ClaimSlotPolicyConfig;
  debugLog?: (message: string) => void;
  now?: Date;
}

/**
 * Runs unified recall across semantic entries and episodic memory using routing rules.
 *
 * @param input - Agent-facing recall request.
 * @param deps - Episode database, entry recall ports, and embedding availability facts.
 * @returns Structured recall response with routing metadata and separate result sections.
 */
export async function runUnifiedRecall(input: UnifiedRecallInput, deps: UnifiedRecallDeps): Promise<UnifiedRecallResult> {
  const now = deps.now ?? new Date();
  const requested = normalizeMode(input.mode);
  const parsedTimeWindow = parseTemporalWindow(input.text, now);
  const hasEntryFilters = hasEntryScopedFilters(input);
  const topicAnchor = hasTopicAnchor(input.text, hasEntryFilters);
  const entityAttributeQuery = detectEntityAttributeQuery(input.text);
  const historicalStatePattern = detectHistoricalStatePattern(input.text);
  const proceduralPattern = detectProceduralPattern(input.text);
  if (entityAttributeQuery) {
    deps.debugLog?.(
      `[agenr] unified recall matched entity-attribute kind=${JSON.stringify(entityAttributeQuery.attributeKind)} entity=${JSON.stringify(entityAttributeQuery.entityText)} query=${JSON.stringify(input.text)}`,
    );
  }
  if (historicalStatePattern) {
    deps.debugLog?.(`[agenr] unified recall matched historical-state pattern=${JSON.stringify(historicalStatePattern)} query=${JSON.stringify(input.text)}`);
  }
  if (proceduralPattern) {
    deps.debugLog?.(`[agenr] unified recall matched procedural pattern=${JSON.stringify(proceduralPattern)} query=${JSON.stringify(input.text)}`);
  }
  const routing = routeRecall({
    requested,
    text: input.text,
    parsedTimeWindow: parsedTimeWindow !== null,
    hasEntryFilters,
  });
  const notices: string[] = [];
  const episodePlan = routing.queried.includes("episodes")
    ? await buildEpisodeQueryPlan({
        text: input.text,
        limit: input.limit,
        requested,
        detectedIntent: routing.detectedIntent,
        parsedTimeWindow,
        topicAnchor,
        embedQuery: deps.embedQuery,
        rankingPolicy: deps.recallOptions?.rankingPolicy,
        crossEncoder: deps.recall.crossEncoder,
      })
    : {
        notices: [],
      };
  const episodes = routing.queried.includes("episodes") && episodePlan.query ? await searchEpisodes(episodePlan.query, deps.database, now) : [];

  if (routing.queried.includes("episodes")) {
    notices.push(EPISODE_FRESHNESS_NOTICE);
    notices.push(...episodePlan.notices);
  }

  if (routing.queried.includes("episodes") && hasEntryScopedFilters(input)) {
    notices.push(ENTRY_FILTER_NOTICE);
  }

  const procedureMmr = resolveProcedureMmrOptions(deps.recallOptions?.rankingPolicy);
  const procedureCrossEncoder = resolveProcedureCrossEncoderOptions(deps.recallOptions?.rankingPolicy, deps.recall.crossEncoder);
  const procedureResults = routing.queried.includes("procedures")
    ? await runProcedureRecall(
        {
          text: input.text,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
          ...(procedureMmr ? { mmr: procedureMmr } : {}),
          ...(procedureCrossEncoder ? { crossEncoder: procedureCrossEncoder } : {}),
        },
        {
          db: deps.procedures,
          ...(deps.embedQuery ? { embedQuery: deps.embedQuery } : {}),
        },
      )
    : {
        candidates: [],
        notices: [],
      };
  const entries = await maybeRunEntryRecall({
    input,
    deps,
    parsedTimeWindow,
    routing,
  });
  if (routing.queried.includes("entries") && entries.kind === "skipped") {
    notices.push(entries.notice);
  }
  if (entries.kind === "results") {
    notices.push(...entries.notices);
  }

  const rawEntries = entries.kind === "results" ? entries.results : [];
  const entryFamilies = projectClaimCentricRecallEntries(rawEntries, {
    asOf: input.asOf,
    slotPolicyConfig: deps.claimSlotPolicyConfig,
  });
  const projectedEntries = flattenClaimCentricRecallFamilies(entryFamilies);
  const claimTransitions = buildClaimTransitionExplanations({
    families: entryFamilies,
    episodes,
    detectedIntent: routing.detectedIntent,
  });

  return {
    routing,
    ...(parsedTimeWindow
      ? {
          parsedTimeWindow,
          timeWindow: {
            start: parsedTimeWindow.bounds.start.toISOString(),
            end: parsedTimeWindow.bounds.end.toISOString(),
            timezone: parsedTimeWindow.timezone,
            resolvedFrom: parsedTimeWindow.resolvedFrom,
          },
        }
      : {}),
    ...(input.asOf ? { asOf: input.asOf.trim() } : {}),
    ...(procedureResults.canonicalProcedure ? { procedure: procedureResults.canonicalProcedure } : {}),
    procedureCandidates: procedureResults.candidates,
    procedureNotices: dedupePreservingOrder(procedureResults.notices),
    episodes,
    entries: rawEntries,
    projectedEntries,
    entryFamilies,
    claimTransitions,
    notices: dedupePreservingOrder(notices),
    count: procedureResults.candidates.length + episodes.length + rawEntries.length,
  };
}

/**
 * Routes one unified recall request into entry and/or episode subqueries.
 *
 * @param params - Recall mode, query text, and detected signals.
 * @returns Stable routing metadata reported to the caller.
 */
export function routeRecall(params: { requested: UnifiedRecallMode; text: string; parsedTimeWindow: boolean; hasEntryFilters: boolean }): UnifiedRecallRouting {
  const lower = params.text.trim().toLowerCase();
  const factual = /^(when did|when was|what decision|what preference|what(?:'s| is) the default|which version|what threshold)\b/.test(lower);
  const narrative = /\b(what happened|what were we doing|what was going on|summarize|catch me up)\b/.test(lower);
  const entityAttributeQuery = detectEntityAttributeQuery(params.text);
  const historicalState = detectHistoricalStatePattern(params.text) !== undefined;
  const procedural = detectProceduralPattern(params.text) !== undefined;
  const topicAnchor = hasTopicAnchor(params.text, params.hasEntryFilters);

  if (params.requested === "entries") {
    return {
      requested: params.requested,
      detectedIntent: entityAttributeQuery
        ? "entity_attribute"
        : historicalState
          ? "historical_state"
          : factual
            ? "factual"
            : params.parsedTimeWindow
              ? "mixed"
              : "factual",
      queried: ["entries"],
      reason: "Explicit mode=entries override.",
    };
  }

  if (params.requested === "episodes") {
    return {
      requested: params.requested,
      detectedIntent: historicalState ? "historical_state" : params.parsedTimeWindow ? "temporal_narrative" : "mixed",
      queried: ["episodes"],
      reason: params.parsedTimeWindow
        ? "Explicit mode=episodes override with a resolved time window."
        : "Explicit mode=episodes override without a resolved time window.",
    };
  }

  if (params.requested === "procedures") {
    return {
      requested: params.requested,
      detectedIntent: "procedural",
      queried: ["procedures"],
      reason: "Explicit mode=procedures override.",
    };
  }

  if (entityAttributeQuery) {
    return {
      requested: params.requested,
      detectedIntent: "entity_attribute",
      queried: ["entries"],
      reason: "The query asks for a specific entity attribute, so precision-first entry recall was used.",
    };
  }

  if (historicalState) {
    return {
      requested: params.requested,
      detectedIntent: "historical_state",
      queried: procedural ? ["procedures", "entries", "episodes"] : ["entries", "episodes"],
      reason: params.parsedTimeWindow
        ? procedural
          ? "The query asks for steps around a previous state or transition and includes a supported time expression, so procedures, entries, and episodes were queried."
          : "The query asks about a previous state or transition and includes a supported time expression, so both entries and episodes were queried."
        : procedural
          ? "The query asks for steps around a previous state or transition, so procedures, entries, and episodes were queried."
          : "The query asks about a previous state or transition, so both entries and episodes were queried.",
    };
  }

  if (factual && params.parsedTimeWindow) {
    return {
      requested: params.requested,
      detectedIntent: "mixed",
      queried: procedural ? ["procedures", "entries", "episodes"] : ["entries", "episodes"],
      reason: procedural
        ? "The query combines a procedural ask with factual and time-based signals, so procedures, entries, and episodes were queried."
        : "The query combines a factual phrase with a supported time expression, so both entries and episodes were queried.",
    };
  }

  if (procedural && params.parsedTimeWindow && topicAnchor) {
    return {
      requested: params.requested,
      detectedIntent: "mixed",
      queried: ["procedures", "episodes", "entries"],
      reason:
        "The query asks for steps, includes a supported time expression, and names a topic anchor, so procedures were queried first with supporting episodes and entries.",
    };
  }

  if (procedural && params.parsedTimeWindow) {
    return {
      requested: params.requested,
      detectedIntent: "mixed",
      queried: ["procedures", "episodes"],
      reason: "The query asks for steps and includes a supported time expression, so procedures were queried first with supporting episodes.",
    };
  }

  if (procedural && topicAnchor) {
    return {
      requested: params.requested,
      detectedIntent: "mixed",
      queried: ["procedures", "entries"],
      reason: "The query asks for steps and includes a topic anchor, so procedures were queried first with supporting entries.",
    };
  }

  if (procedural) {
    return {
      requested: params.requested,
      detectedIntent: "procedural",
      queried: ["procedures"],
      reason: "The query asks how to do something or requests a step-by-step method, so procedure recall was used first.",
    };
  }

  if (factual) {
    return {
      requested: params.requested,
      detectedIntent: "factual",
      queried: ["entries"],
      reason: "The query looks like an exact fact lookup, so entry recall was used.",
    };
  }

  if (params.parsedTimeWindow && narrative && topicAnchor) {
    return {
      requested: params.requested,
      detectedIntent: "mixed",
      queried: ["episodes", "entries"],
      reason: "The query combines narrative time-based recall with a topic anchor, so both episodes and entries were queried.",
    };
  }

  if (params.parsedTimeWindow && narrative) {
    return {
      requested: params.requested,
      detectedIntent: "temporal_narrative",
      queried: ["episodes"],
      reason: "The query asks for what happened during a time period, so episode recall was used first.",
    };
  }

  if (params.parsedTimeWindow && topicAnchor) {
    return {
      requested: params.requested,
      detectedIntent: "mixed",
      queried: ["episodes", "entries"],
      reason: "The query contains both a supported time expression and a topic anchor, so both episodes and entries were queried.",
    };
  }

  return {
    requested: params.requested,
    detectedIntent: "factual",
    queried: ["entries"],
    reason: params.parsedTimeWindow
      ? "The query did not clearly ask for narrative recall, so entry recall was used."
      : "No supported episode time window was detected, so entry recall was used.",
  };
}

/**
 * Builds the episode-query payload for temporal, semantic, or hybrid search.
 *
 * @param params - Routing facts and optional embedding helper.
 * @returns Episode query plus any user-facing notices.
 */
async function buildEpisodeQueryPlan(params: {
  text: string;
  limit: number | undefined;
  requested: UnifiedRecallMode;
  detectedIntent: UnifiedRecallRouting["detectedIntent"];
  parsedTimeWindow: ReturnType<typeof parseTemporalWindow>;
  topicAnchor: boolean;
  embedQuery?: (text: string) => Promise<number[]>;
  rankingPolicy?: RecallRankingPolicy;
  crossEncoder?: RecallPorts["crossEncoder"];
}): Promise<{
  query?: import("../../core/episode/types.js").EpisodeQuery;
  notices: string[];
}> {
  const notices: string[] = [];
  const shouldUseSemantic = params.detectedIntent === "historical_state" || (params.parsedTimeWindow ? params.topicAnchor : params.requested === "episodes");

  let embedding: number[] | undefined;
  if (shouldUseSemantic) {
    embedding = await maybeEmbedEpisodeQuery(params.text, params.embedQuery);
    if (!embedding) {
      notices.push(params.parsedTimeWindow ? EPISODE_SEMANTIC_FALLBACK_NOTICE : EPISODE_SEMANTIC_UNAVAILABLE_NOTICE);
    }
  }

  if (!params.parsedTimeWindow && !embedding) {
    return {
      notices,
    };
  }

  const mmr = resolveEpisodeMmrOptions(params.detectedIntent, params.rankingPolicy);
  const crossEncoder = resolveEpisodeCrossEncoderOptions(params.rankingPolicy, params.crossEncoder);

  return {
    query: {
      text: params.text,
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(params.parsedTimeWindow ? { timeWindow: params.parsedTimeWindow.window } : {}),
      ...(embedding ? { embedding } : {}),
      ...(mmr ? { mmr } : {}),
      ...(crossEncoder ? { crossEncoder } : {}),
    },
    notices,
  };
}

/**
 * Decide whether to apply MMR diversification to episode hybrid ranking.
 *
 * MMR is enabled for factual and mixed intents, where broad queries can
 * pull many same-session episodes into the shortlist. Narrative-only or
 * historical-state intents skip MMR so temporal ordering can dominate.
 * The kill switch on `rankingPolicy.mmr === "disabled"` always wins.
 *
 * @param detectedIntent - Intent derived by the unified recall router.
 * @param rankingPolicy - Optional ranking policy overrides.
 * @returns Episode MMR options when enabled, undefined otherwise.
 */
function resolveEpisodeMmrOptions(
  detectedIntent: UnifiedRecallRouting["detectedIntent"],
  rankingPolicy: RecallRankingPolicy | undefined,
): EpisodeMmrOptions | undefined {
  if (rankingPolicy?.mmr === "disabled") {
    return undefined;
  }

  if (detectedIntent !== "factual" && detectedIntent !== "mixed") {
    return undefined;
  }

  return {
    enabled: true,
    ...(typeof rankingPolicy?.mmrLambda === "number" ? { lambda: rankingPolicy.mmrLambda } : {}),
    ...(typeof rankingPolicy?.mmrMinPoolSize === "number" ? { minPoolSize: rankingPolicy.mmrMinPoolSize } : {}),
  };
}

/**
 * Resolve MMR diversification options for dedicated procedure recall.
 *
 * Procedure recall runs MMR unconditionally when the policy does not
 * disable it. Procedures routinely share recall text across revisions,
 * so diversification is useful even for narrow procedural queries.
 *
 * @param rankingPolicy - Optional ranking policy overrides.
 * @returns Procedure MMR options when enabled, undefined otherwise.
 */
function resolveProcedureMmrOptions(rankingPolicy: RecallRankingPolicy | undefined): ProcedureMmrOptions | undefined {
  if (rankingPolicy?.mmr === "disabled") {
    return undefined;
  }

  return {
    enabled: true,
    ...(typeof rankingPolicy?.mmrLambda === "number" ? { lambda: rankingPolicy.mmrLambda } : {}),
    ...(typeof rankingPolicy?.mmrMinPoolSize === "number" ? { minPoolSize: rankingPolicy.mmrMinPoolSize } : {}),
  };
}

/**
 * Resolve cross-encoder rerank options for hybrid episode recall.
 *
 * The rerank is enabled whenever a cross-encoder port is wired and the
 * ranking policy does not explicitly disable the stage. Episodes keep
 * the same policy-driven top-K and alpha overrides as entries so the
 * surface stays uniform across result kinds.
 *
 * @param rankingPolicy - Optional ranking policy overrides.
 * @param crossEncoder - Optional cross-encoder port from the recall ports.
 * @returns Episode cross-encoder options when enabled, undefined otherwise.
 */
function resolveEpisodeCrossEncoderOptions(
  rankingPolicy: RecallRankingPolicy | undefined,
  crossEncoder: RecallPorts["crossEncoder"],
): EpisodeCrossEncoderOptions | undefined {
  if (!crossEncoder || rankingPolicy?.crossEncoder === "disabled") {
    return undefined;
  }

  return {
    enabled: true,
    port: crossEncoder,
    ...(typeof rankingPolicy?.crossEncoderTopK === "number" ? { topK: rankingPolicy.crossEncoderTopK } : {}),
    ...(typeof rankingPolicy?.crossEncoderAlpha === "number" ? { alpha: rankingPolicy.crossEncoderAlpha } : {}),
  };
}

/**
 * Resolve cross-encoder rerank options for dedicated procedure recall.
 *
 * The rerank is enabled whenever a cross-encoder port is wired and the
 * ranking policy does not explicitly disable the stage. Procedures
 * reuse the entry top-K / alpha overrides so callers can tune every
 * rerank stage with one policy.
 *
 * @param rankingPolicy - Optional ranking policy overrides.
 * @param crossEncoder - Optional cross-encoder port from the recall ports.
 * @returns Procedure cross-encoder options when enabled, undefined otherwise.
 */
function resolveProcedureCrossEncoderOptions(
  rankingPolicy: RecallRankingPolicy | undefined,
  crossEncoder: RecallPorts["crossEncoder"],
): ProcedureCrossEncoderOptions | undefined {
  if (!crossEncoder || rankingPolicy?.crossEncoder === "disabled") {
    return undefined;
  }

  return {
    enabled: true,
    port: crossEncoder,
    ...(typeof rankingPolicy?.crossEncoderTopK === "number" ? { topK: rankingPolicy.crossEncoderTopK } : {}),
    ...(typeof rankingPolicy?.crossEncoderAlpha === "number" ? { alpha: rankingPolicy.crossEncoderAlpha } : {}),
  };
}

/**
 * Executes entry recall when the router selected it and embeddings are available.
 *
 * @param params - Recall inputs, dependencies, parsed time window, and routing result.
 * @returns Entry results, a skip notice, or an error for explicit entry mode failures.
 */
async function maybeRunEntryRecall(params: {
  input: UnifiedRecallInput;
  deps: UnifiedRecallDeps;
  parsedTimeWindow: ReturnType<typeof parseTemporalWindow>;
  routing: UnifiedRecallRouting;
}): Promise<
  | {
      kind: "results";
      results: import("../../core/recall/types.js").RecallOutput[];
      notices: string[];
    }
  | {
      kind: "skipped";
      notice: string;
    }
> {
  if (!params.routing.queried.includes("entries")) {
    return {
      kind: "results",
      results: [],
      notices: [],
    };
  }
  const notices: string[] = [];
  const trace = composeRecallTrace(params.deps.recallOptions?.trace, (summary) => {
    if (summary.degraded.active) {
      for (const notice of summary.degraded.notices) {
        if (!notices.includes(notice)) {
          notices.push(notice);
        }
      }
    }
  });

  return {
    kind: "results",
    results: await recall(buildEntryRecallInput(params.input, params.parsedTimeWindow, params.routing), params.deps.recall, {
      ...params.deps.recallOptions,
      trace,
    }),
    notices,
  };
}

/**
 * Fan out one recall trace summary to both the upstream observer and a local
 * degraded-mode notice collector.
 *
 * @param upstream - Optional upstream trace sink supplied by the caller.
 * @param onSummary - Local callback used to observe the final recall summary.
 * @returns Composite trace sink safe to pass into the core recall call.
 */
function composeRecallTrace(upstream: RecallTraceSink | undefined, onSummary: (summary: RecallExecutionTraceSummary) => void): RecallTraceSink {
  return {
    reportSummary(summary: RecallExecutionTraceSummary): void {
      onSummary(summary);
      upstream?.reportSummary(summary);
    },
  };
}

/**
 * Builds the internal semantic-recall request, including derived temporal bias.
 *
 * @param input - Unified recall request.
 * @param parsedTimeWindow - Optional resolved episode-style time window.
 * @returns Core entry recall input.
 */
function buildEntryRecallInput(
  input: UnifiedRecallInput,
  parsedTimeWindow: ReturnType<typeof parseTemporalWindow>,
  routing: UnifiedRecallRouting,
): RecallInput {
  const entityAttributeQuery = routing.detectedIntent === "entity_attribute" ? detectEntityAttributeQuery(input.text) : undefined;
  const request: RecallInput = {
    text: input.text,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
    ...(input.types && input.types.length > 0 ? { types: input.types } : {}),
    ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    ...(input.asOf ? { asOf: input.asOf } : {}),
    ...(routing.detectedIntent === "historical_state" ? { rankingProfile: "historical_state" } : {}),
    ...(routing.detectedIntent === "entity_attribute" ? { rankingProfile: "entity_attribute" as const } : {}),
    ...(entityAttributeQuery ? { queryShape: entityAttributeQuery } : {}),
  };

  if (!parsedTimeWindow || input.asOf) {
    return request;
  }

  const start = parsedTimeWindow.bounds.start;
  const end = parsedTimeWindow.bounds.end;
  const midpoint = new Date((start.getTime() + end.getTime()) / 2);
  const radiusDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 2 / (24 * 60 * 60 * 1000)));

  return {
    ...request,
    since: start.toISOString(),
    until: end.toISOString(),
    around: midpoint.toISOString(),
    aroundRadius: radiusDays,
  };
}

/**
 * Detects whether a query is explicitly asking for prior state rather than current truth.
 *
 * @param text - Raw recall query.
 * @returns Matched cue text, or undefined when the query is not a historical-state ask.
 */
function detectHistoricalStatePattern(text: string): string | undefined {
  const lower = text.trim().toLowerCase();
  const explicitPattern = HISTORICAL_STATE_PATTERNS.find((pattern) => lower.includes(pattern));
  if (explicitPattern) {
    return explicitPattern;
  }

  const regexPattern = HISTORICAL_STATE_REGEX_PATTERNS.find((pattern) => pattern.test(lower));
  return regexPattern?.source;
}

/**
 * Detects whether a query is asking for a method, checklist, or step-by-step workflow.
 *
 * @param text - Raw recall query.
 * @returns Matched cue text, or undefined when the query is not procedural.
 */
function detectProceduralPattern(text: string): string | undefined {
  const lower = text.trim().toLowerCase();
  const explicitPattern = PROCEDURAL_PATTERNS.find((pattern) => lower.includes(pattern));
  if (explicitPattern) {
    return explicitPattern;
  }

  const regexPattern = PROCEDURAL_REGEX_PATTERNS.find((pattern) => pattern.test(lower));
  return regexPattern?.source;
}

/**
 * Detects whether a query asks for one supported entity attribute.
 *
 * @param text - Raw recall query.
 * @returns Structured entity-attribute query shape, or `undefined` when absent.
 */
function detectEntityAttributeQuery(text: string): EntityAttributeQueryShape | undefined {
  const normalizedText = normalizeEntityAttributeWhitespace(text);

  const whereDoesLive = /^where\s+does\s+(.+?)\s+live[?!.,]*$/iu.exec(normalizedText);
  if (whereDoesLive) {
    return buildEntityAttributeQueryShape(whereDoesLive[1], "location");
  }

  const whereIs = /^where\s+is\s+(.+?)[?!.,]*$/iu.exec(normalizedText);
  if (whereIs) {
    return buildEntityAttributeQueryShape(whereIs[1], "location");
  }

  const possessiveAttribute = /^(?:what\s+is|what's)\s+(.+?)'s\s+(.+?)[?!.,]*$/iu.exec(normalizedText);
  if (possessiveAttribute) {
    const attributeKind = resolveEntityAttributeKind(possessiveAttribute[2]);
    if (attributeKind) {
      return buildEntityAttributeQueryShape(possessiveAttribute[1], attributeKind);
    }
  }

  const whoIs = /^(?:who\s+is|who's)\s+(.+?)(?:\s+again)?[?!.,]*$/iu.exec(normalizedText);
  if (whoIs) {
    return buildEntityAttributeQueryShape(whoIs[1], "identity");
  }

  const whatIs = /^what\s+is\s+(.+?)(?:\s+again)?[?!.,]*$/iu.exec(normalizedText);
  if (whatIs) {
    return buildEntityAttributeQueryShape(whatIs[1], "identity");
  }

  return undefined;
}

/**
 * Builds one structured entity-attribute query shape after validation.
 *
 * @param rawEntityText - Raw captured entity text from the query pattern.
 * @param attributeKind - Supported attribute bucket resolved from the query.
 * @returns Structured shape, or `undefined` when the capture is too broad.
 */
function buildEntityAttributeQueryShape(rawEntityText: string | undefined, attributeKind: EntityAttributeKind): EntityAttributeQueryShape | undefined {
  const entityText = normalizeEntityAttributeEntity(rawEntityText);
  if (!entityText) {
    return undefined;
  }

  const entityTokens = tokenize(entityText);
  if (entityTokens.length === 0) {
    return undefined;
  }

  return {
    kind: "entity_attribute",
    entityText,
    normalizedEntity: normalizeEntityAttributeText(entityText),
    entityTokens,
    attributeKind,
    attributeTokens: [...ENTITY_ATTRIBUTE_KIND_TOKENS[attributeKind]],
  };
}

/**
 * Resolves a supported attribute bucket from raw attribute text.
 *
 * @param rawAttributeText - Raw captured attribute segment.
 * @returns Supported attribute kind, or `undefined` when unsupported.
 */
function resolveEntityAttributeKind(rawAttributeText: string | undefined): EntityAttributeKind | undefined {
  const tokens = tokenize(rawAttributeText ?? "");

  if (tokens.some((token) => token === "email" || token === "e-mail" || token === "mail")) {
    return "email";
  }

  if (tokens.some((token) => token === "phone" || token === "number" || token === "mobile" || token === "cell" || token === "telephone")) {
    return "phone";
  }

  if (tokens.some((token) => token === "address" || token === "street" || token === "mailing")) {
    return "address";
  }

  if (
    tokens.some(
      (token) =>
        token === "location" ||
        token === "live" ||
        token === "lives" ||
        token === "reside" ||
        token === "resides" ||
        token === "located" ||
        token === "home" ||
        token === "city",
    )
  ) {
    return "location";
  }

  if (tokens.some((token) => ENTITY_ATTRIBUTE_KIND_TOKENS.identity.includes(token))) {
    return "identity";
  }

  return undefined;
}

/**
 * Normalizes a raw entity capture and rejects broad contextual lookalikes.
 *
 * @param rawEntityText - Raw captured entity string from the query pattern.
 * @returns Narrow entity text, or `undefined` when too broad.
 */
function normalizeEntityAttributeEntity(rawEntityText: string | undefined): string | undefined {
  const cleaned = rawEntityText
    ? normalizeEntityAttributeWhitespace(rawEntityText)
        .replace(/^[("'`]+/u, "")
        .replace(/[)"'`?!.,]+$/u, "")
        .replace(/^(?:the|a|an)\s+/iu, "")
        .trim()
    : "";
  if (cleaned.length === 0) {
    return undefined;
  }

  const normalized = normalizeEntityAttributeText(cleaned);
  const wordCount = cleaned.split(/\s+/u).filter((token) => token.length > 0).length;
  if (
    wordCount === 0 ||
    wordCount > ENTITY_ATTRIBUTE_MAX_WORDS ||
    ENTITY_ATTRIBUTE_GENERIC_ENTITY_RE.test(normalized) ||
    ENTITY_ATTRIBUTE_CONTEXTUAL_PREFIX_RE.test(normalized) ||
    ENTITY_ATTRIBUTE_CONTEXTUAL_TIME_RE.test(normalized) ||
    ENTITY_ATTRIBUTE_CONTEXTUAL_ACTIVITY_RE.test(normalized)
  ) {
    return undefined;
  }

  return cleaned;
}

/**
 * Collapses repeated whitespace while preserving other query text.
 *
 * @param text - Raw text value.
 * @returns Whitespace-normalized text.
 */
function normalizeEntityAttributeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Normalizes one entity/attribute string for case-insensitive comparisons.
 *
 * @param text - Raw text value.
 * @returns Lowercased normalized comparison string.
 */
function normalizeEntityAttributeText(text: string): string {
  return normalizeEntityAttributeWhitespace(text).normalize("NFKC").toLocaleLowerCase();
}

/**
 * Normalizes the public recall mode into a supported value.
 *
 * @param value - Optional caller-supplied mode.
 * @returns Normalized recall mode.
 */
function normalizeMode(value: UnifiedRecallMode | undefined): UnifiedRecallMode {
  return value === "entries" || value === "episodes" || value === "procedures" ? value : "auto";
}

/**
 * Returns whether the request uses filters that only affect entry recall in phase 4.
 *
 * @param input - Unified recall input.
 * @returns True when entry-only filters were supplied.
 */
function hasEntryScopedFilters(input: UnifiedRecallInput): boolean {
  return Boolean(hasNonEmptyArray(input.types) || hasNonEmptyArray(input.tags));
}

/**
 * Returns whether one optional array contains at least one item.
 *
 * @param value - Candidate array input.
 * @returns True when the array is present and non-empty.
 */
function hasNonEmptyArray<TValue>(value: TValue[] | undefined): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * Detects whether a query includes a topic anchor that benefits from semantic episode search.
 *
 * @param text - Raw user query.
 * @param hasEntryFilters - Whether entry-scoped filters were supplied.
 * @returns True when the query carries topical anchor text.
 */
function hasTopicAnchor(text: string, hasEntryFilters: boolean): boolean {
  const lower = text.trim().toLowerCase();
  return hasEntryFilters || /\b(about|regarding|with)\b/.test(lower) || /\bon\s+[a-z][a-z0-9_-]{1,}\b/.test(lower);
}

/**
 * Computes a best-effort query embedding for episode semantic search.
 *
 * @param text - Raw user query text.
 * @param embedQuery - Optional embedding function.
 * @returns Query embedding, or undefined when unavailable.
 */
async function maybeEmbedEpisodeQuery(text: string, embedQuery: UnifiedRecallDeps["embedQuery"]): Promise<number[] | undefined> {
  if (!embedQuery) {
    return undefined;
  }

  try {
    const embedding = await embedQuery(text);
    return embedding.length > 0 ? embedding : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Removes duplicate notices while keeping stable insertion order.
 *
 * @param values - Ordered notice list.
 * @returns Deduplicated notice list.
 */
function dedupePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}
