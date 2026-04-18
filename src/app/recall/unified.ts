import type { EpisodeDatabasePort, ProcedureDatabasePort, RecallPorts } from "../../core/ports.js";
import type { ClaimSlotPolicyConfig } from "../../core/claim-slot-policy.js";
import { recall } from "../../core/recall/search.js";
import { parseTemporalWindow } from "../../core/episode/temporal-window.js";
import { searchEpisodes } from "../../core/episode/search.js";
import type { EpisodeMmrOptions } from "../../core/episode/types.js";
import type { RecallExecutionOptions, RecallExecutionTraceSummary, RecallRankingPolicy, RecallTraceSink } from "../../core/recall/trace.js";
import type { RecallInput } from "../../core/recall/types.js";
import type { ProcedureMmrOptions } from "../procedures/recall/types.js";
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
  const historicalStatePattern = detectHistoricalStatePattern(input.text);
  const proceduralPattern = detectProceduralPattern(input.text);
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
  const procedureResults = routing.queried.includes("procedures")
    ? await runProcedureRecall(
        {
          text: input.text,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
          ...(procedureMmr ? { mmr: procedureMmr } : {}),
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
  const historicalState = detectHistoricalStatePattern(params.text) !== undefined;
  const procedural = detectProceduralPattern(params.text) !== undefined;
  const topicAnchor = hasTopicAnchor(params.text, params.hasEntryFilters);

  if (params.requested === "entries") {
    return {
      requested: params.requested,
      detectedIntent: historicalState ? "historical_state" : factual ? "factual" : params.parsedTimeWindow ? "mixed" : "factual",
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

  return {
    query: {
      text: params.text,
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(params.parsedTimeWindow ? { timeWindow: params.parsedTimeWindow.window } : {}),
      ...(embedding ? { embedding } : {}),
      ...(mmr ? { mmr } : {}),
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
  const request: RecallInput = {
    text: input.text,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
    ...(input.types && input.types.length > 0 ? { types: input.types } : {}),
    ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    ...(input.asOf ? { asOf: input.asOf } : {}),
    ...(routing.detectedIntent === "historical_state" ? { rankingProfile: "historical_state" } : {}),
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
