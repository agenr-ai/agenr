import type { RecallPorts } from "../ports.js";
import { resolveClaimSlotPolicy } from "../claim-slot-policy.js";

import { applyCrossEncoderRerank, DEFAULT_CROSS_ENCODER_ALPHA, DEFAULT_CROSS_ENCODER_TOP_K } from "./cross-encoder.js";
import { DEFAULT_RRF_RANK_CONSTANT, DEFAULT_RRF_SMALL_POOL_RANK_CONSTANT, SMALL_POOL_RRF_POOL_SIZE, rrfFuse } from "./fusion.js";
import { computeLexicalScore, tokenize } from "./lexical.js";
import { DEFAULT_MMR_LAMBDA, DEFAULT_MMR_MIN_POOL_SIZE, maximalMarginalRelevance } from "./mmr.js";
import {
  DEFAULT_NEIGHBORHOOD_BUDGET,
  DEFAULT_SEEDED_RERANK_WEIGHT,
  DEFAULT_STRONG_SEED_SCORE_GAP,
  DEFAULT_STRONG_SEED_TOP_N,
  type NeighborhoodFamily,
  seededRerank,
  selectStrongSeeds,
  sharesEntryLineage,
} from "./neighborhood.js";
import { cosineSimilarity, gaussianRecency, importanceScore, recencyScore, scoreCandidate } from "./scoring.js";
import { inferAroundDate, parseRelativeDate } from "./temporal.js";
import {
  createNoopRecallTraceSink,
  type RecallCrossEncoderTrace,
  type RecallDegradedReason,
  type RecallExecutionOptions,
  type RecallExecutionTraceSummary,
  type RecallMmrTrace,
  type RecallNeighborhoodTrace,
  type RecallNoResultReason,
  type RecallRankingPolicy,
  type RecallRrfTrace,
} from "./trace.js";
import type { EntryFilters, FtsCandidate, RecallCandidateEntry, RecallInput, RecallOutput, RecallRankingProfile, VectorCandidate } from "./types.js";

const HISTORICAL_NEIGHBORHOOD_FAMILIES: readonly NeighborhoodFamily[] = ["supersession_chain", "claim_key_sibling", "topic_family"];

const MIN_VECTOR_ONLY_EVIDENCE = 0.3;
const HISTORICAL_STATE_FLAT_RECENCY = 0.5;
const HISTORICAL_PREDECESSOR_BOOST = 0.08;
const HISTORICAL_RETIRED_PREDECESSOR_BOOST = 0.06;
const HISTORICAL_OLDER_STATE_BOOST = 0.08;
/**
 * Extra score margin the historical-state lineage bonus must clear over the
 * highest-scoring active peer. Kept small so the proportional boost only
 * narrowly beats the successor rather than dominating the entire score
 * surface, which preserves claim-key shaping and downstream MMR diagnostics.
 */
const HISTORICAL_LINEAGE_GAP_MARGIN = 0.02;
/**
 * Hard upper bound on the historical-state lineage bonus. Without a cap an
 * RRF-dominant successor with a near-1.0 composite could otherwise push the
 * predecessor bonus close to 1.0 and hide claim-key redundancy penalties or
 * trust suppression. 0.45 is comfortably above any pool-derived gap observed
 * in the phase-0 attribution sweep.
 */
const HISTORICAL_LINEAGE_MAX_BONUS = 0.45;
const HISTORICAL_TOPIC_SHARED_PREFIX_MIN = 2;
const HISTORICAL_TOPIC_PREFIX_OF_CANDIDATE_MIN = 0.6;
const CLAIM_KEY_TENTATIVE_CURRENT_PENALTY = 0.08;
const CLAIM_KEY_REDUNDANT_TRUSTED_SLOT_PENALTY = 0.05;
const CLAIM_KEY_REDUNDANT_TRUSTED_SLOT_MAX_PENALTY = 0.15;
const QUERY_EMBEDDING_FAILURE_NOTICE = "Embeddings failed during recall, so Agenr fell back to lexical-only entry ranking.";
const VECTOR_SEARCH_FAILURE_NOTICE = "Vector search failed during recall, so Agenr continued with lexical entry candidates only.";
const ENTITY_ATTRIBUTE_IDENTITY_WRAPPERS = new Set(["identity", "profile", "bio", "biography", "summary"]);
const WEAK_QUERY_GROUNDING_TOKENS = new Set([
  "earlier",
  "last",
  "mention",
  "mentioned",
  "number",
  "order",
  "remember",
  "remind",
  "reminder",
  "run",
  "runs",
  "thing",
  "time",
  "use",
  "uses",
  "using",
]);
const WEAKLY_GROUNDED_REMINDER_PATTERN = /\b(earlier|last time|mention(?:ed)?|remember|remind(?:er)?)\b/iu;
const MIN_VECTOR_WITHOUT_GROUNDED_LEXICAL_SUPPORT = 0.45;
const GROUNDING_SORT_MAX_SCORE_GAP = 0.03;

/**
 * Execute the v1 recall pipeline against the provided adapter ports.
 *
 * @param query - Recall query and optional filters.
 * @param ports - Adapter implementations for embedding, retrieval, and event recording.
 * @param options - Optional execution controls such as a typed trace sink.
 * @returns Ranked recall results with score breakdowns.
 */
export async function recall(query: RecallInput, ports: RecallPorts, options: RecallExecutionOptions = {}): Promise<RecallOutput[]> {
  const text = query.text.trim();
  const limit = normalizeLimit(query.limit);
  const threshold = normalizeThreshold(query.threshold);
  const budget = normalizeBudget(query.budget);
  const asOfDate = query.asOf ? parseAroundDate(query.asOf) : null;
  const aroundDate = query.around !== undefined ? parseAroundDate(query.around) : inferAroundDate(text);
  const since = query.since ? parseRelativeDate(query.since) : null;
  const until = query.until ? parseRelativeDate(query.until) : null;
  const filters = buildEntryFilters(query.types, query.tags, since, until);
  const trace = options.trace ?? createNoopRecallTraceSink();
  const slotPolicyConfig = options.slotPolicyConfig;
  const summary = buildRecallTraceSummary({
    filters,
    limit,
    threshold,
    budget,
    asOfDate,
    aroundDate,
    aroundSource: query.around !== undefined ? "explicit" : "inferred",
    aroundRadius: aroundDate ? normalizeAroundRadius(query.aroundRadius) : undefined,
  });
  let traceReported = false;
  const reportTrace = (noResultReason?: RecallNoResultReason): void => {
    if (traceReported) {
      return;
    }

    traceReported = true;
    finishRecallTrace(summary, trace, noResultReason);
  };

  if (text.length === 0) {
    reportTrace("empty_query");
    return [];
  }

  if (limit === 0) {
    reportTrace("limit_zero");
    return [];
  }

  try {
    let queryEmbedding: number[] = [];
    try {
      queryEmbedding = await ports.embed(text);
    } catch {
      markRecallDegraded(summary, "query_embedding_failed", QUERY_EMBEDDING_FAILURE_NOTICE);
    }

    const vectorSearchLimit = limit * 4;
    const lexicalSearchLimit = limit * 2;
    const [vectorCandidates, ftsCandidates] =
      queryEmbedding.length > 0
        ? await Promise.all([
            ports
              .vectorSearch({
                embedding: queryEmbedding,
                limit: vectorSearchLimit,
                filters,
              })
              .catch(() => {
                markRecallDegraded(summary, "vector_search_failed", VECTOR_SEARCH_FAILURE_NOTICE);
                return [];
              }),
            ports.ftsSearch({
              text,
              limit: lexicalSearchLimit,
              filters,
            }),
          ])
        : [
            [],
            await ports.ftsSearch({
              text,
              limit: lexicalSearchLimit,
              filters,
            }),
          ];
    summary.degraded.lexicalOnly = summary.degraded.active && queryEmbedding.length === 0;

    const mergeStartedAt = Date.now();
    const mergeOutcome = mergeCandidates(vectorCandidates, ftsCandidates);
    const neighborhoodEnabled = options.rankingPolicy?.neighborhood !== "disabled";
    const expansionRanks = neighborhoodEnabled
      ? await expandEntryNeighborhood(mergeOutcome.merged, queryEmbedding, ports, {
          rankingProfile: query.rankingProfile,
          neighborhoodTrace: summary.neighborhood,
        })
      : [];
    // Fuse the ordered candidate rank lists from every active retrieval
    // channel into one normalized relevance map. Channels that produced no
    // candidates are ignored so RRF does not dilute the remaining signal.
    // When the caller disables RRF, fall back to single-channel vector ranking
    // (with a lexical fallback when the vector channel is empty) so evals can
    // isolate fusion effects without stripping channels from the pipeline.
    const relevanceByEntryId = resolveEntryRelevance({
      vectorRanks: mergeOutcome.vectorRanks,
      ftsRanks: mergeOutcome.ftsRanks,
      expansionRanks,
      policy: options.rankingPolicy,
      trace: summary.rrf,
    });
    summary.candidateCounts.merged = mergeOutcome.merged.size;
    summary.timings.mergeCandidatesMs = elapsedMs(mergeStartedAt);

    const scoreStartedAt = Date.now();
    const historicallyBoosted = applyHistoricalLineageBoosts(
      Array.from(mergeOutcome.merged.values()).map((candidate) =>
        scoreMergedCandidate(candidate, text, queryEmbedding, relevanceByEntryId.get(candidate.entry.id) ?? 0, {
          asOfDate,
          aroundDate,
          aroundRadius: query.aroundRadius,
          rankingProfile: query.rankingProfile,
        }),
      ),
      {
        aroundDate,
        rankingProfile: query.rankingProfile,
      },
      summary.claimKey,
      slotPolicyConfig,
    );
    const rerankedCandidates = neighborhoodEnabled ? applySeededEntryRerank(historicallyBoosted, summary.neighborhood) : historicallyBoosted;
    const shaped = applyClaimKeyResultShaping(rerankedCandidates, summary.claimKey, slotPolicyConfig).sort((left, right) => right.score - left.score);
    // MMR diversifies the final shortlist after claim-key shaping so trust
    // penalties and redundancy shaping still have the last word on which
    // rows dominate. MMR only reorders; it never mutates the composite
    // score, keeping the threshold check grounded in the shaped score.
    const diversified = applyMmrDiversification(shaped, queryEmbedding, options.rankingPolicy, summary.mmr);
    // Cross-encoder reranks the top-K shortlist after diversification so
    // it observes the post-MMR ordering, and before thresholding so the
    // rerank-adjusted composite score is what decides admission to the
    // final result set. The helper fails closed on adapter errors.
    const scored = await applyEntryCrossEncoderRerank(diversified, text, ports.crossEncoder, options.rankingPolicy, summary.crossEncoder);
    summary.timings.scoreCandidatesMs = elapsedMs(scoreStartedAt);

    const thresholdStartedAt = Date.now();
    const thresholded = scored.filter((result) => hasSufficientReturnEvidence(result, query) && result.score >= threshold);
    summary.candidateCounts.thresholdQualified = thresholded.length;
    summary.timings.thresholdMs = elapsedMs(thresholdStartedAt);
    if (thresholded.length === 0) {
      reportTrace(resolveNoResultReason(summary, scored.length === 0 ? "no_candidates" : "below_threshold"));
      return [];
    }

    const budgetStartedAt = Date.now();
    const budgeted = budget === null ? thresholded : applyBudget(thresholded, budget);
    summary.candidateCounts.budgetAccepted = budgeted.length;
    summary.timings.budgetMs = budget === null ? 0 : elapsedMs(budgetStartedAt);
    const ranked = sortAcceptedCandidates(budgeted.slice(0, limit), text, query.rankingProfile);
    summary.candidateCounts.finalRanked = ranked.length;
    if (ranked.length === 0) {
      reportTrace("limit_zero");
      return [];
    }

    const hydratedEntries = await ports.hydrateEntries(ranked.map((result) => result.entry.id));
    const shapeStartedAt = Date.now();
    const hydratedById = new Map(hydratedEntries.map((entry) => [entry.id, entry]));
    const results = ranked.flatMap((result) => {
      const entry = hydratedById.get(result.entry.id);
      if (!entry) {
        return [];
      }

      return [
        {
          entry,
          score: result.score,
          scores: result.scores,
        },
      ];
    });
    summary.candidateCounts.returned = results.length;
    summary.timings.shapeResultsMs = elapsedMs(shapeStartedAt);

    if (results.length === 0) {
      reportTrace(resolveNoResultReason(summary, "hydrate_missing"));
      return [];
    }

    if (results.length > 0) {
      await ports
        .recordRecallEvents({
          entryIds: results.map((result) => result.entry.id),
          query: text,
          sessionKey: query.sessionKey,
        })
        .catch(() => undefined);
    }

    reportTrace();
    return results;
  } catch (error) {
    reportTrace();
    throw error;
  }
}

/**
 * Build the typed execution summary that can be emitted after recall completes.
 *
 * @param params - Normalized recall inputs and active filters.
 * @returns Mutable summary object populated during recall execution.
 */
function buildRecallTraceSummary(params: {
  filters: EntryFilters | undefined;
  limit: number;
  threshold: number;
  budget: number | null;
  asOfDate: Date | null;
  aroundDate: Date | null;
  aroundSource: "explicit" | "inferred";
  aroundRadius?: number;
}): RecallExecutionTraceSummary {
  return {
    filtering: {
      types: params.filters?.types ?? [],
      tags: params.filters?.tags ?? [],
      since: params.filters?.since?.toISOString(),
      until: params.filters?.until?.toISOString(),
      around: params.aroundDate
        ? {
            source: params.aroundSource,
            anchor: params.aroundDate.toISOString(),
            radiusDays: params.aroundRadius ?? 14,
          }
        : undefined,
      ...(params.asOfDate
        ? {
            asOf: {
              anchor: params.asOfDate.toISOString(),
            },
          }
        : {}),
    },
    ranking: {
      limit: params.limit,
      threshold: params.threshold,
      budget: params.budget,
    },
    candidateCounts: {
      merged: 0,
      thresholdQualified: 0,
      budgetAccepted: 0,
      finalRanked: 0,
      returned: 0,
    },
    claimKey: {
      historicalBoosted: 0,
      tentativeLineageSuppressed: 0,
      trustPenalized: 0,
      redundancyPenalized: 0,
    },
    rrf: {
      applied: false,
      channelCount: 0,
      rankConstant: DEFAULT_RRF_RANK_CONSTANT,
      fusedCandidateCount: 0,
      maxFusedScore: 0,
    },
    neighborhood: {
      expansionRequested: false,
      expansionAvailable: false,
      familiesRequested: [],
      includeRetired: false,
      seedIds: [],
      expansionCandidates: 0,
      strongSeedIds: [],
      rerankBoostedIds: [],
    },
    mmr: {
      applied: false,
      lambda: DEFAULT_MMR_LAMBDA,
      droppedDuplicateCount: 0,
      reorderedIds: [],
    },
    crossEncoder: {
      applied: false,
      k: 0,
      alpha: DEFAULT_CROSS_ENCODER_ALPHA,
      latencyMs: 0,
      rescoredIds: [],
    },
    timings: {
      mergeCandidatesMs: 0,
      scoreCandidatesMs: 0,
      thresholdMs: 0,
      budgetMs: 0,
      shapeResultsMs: 0,
    },
    degraded: {
      active: false,
      reasons: [],
      lexicalOnly: false,
      notices: [],
    },
  };
}

/**
 * Emit the final typed recall trace summary exactly once before returning.
 *
 * @param summary - Mutable execution summary accumulated during recall.
 * @param trace - Optional typed trace sink supplied by the caller.
 * @param noResultReason - Stable no-result reason when recall returns no entries.
 */
function finishRecallTrace(
  summary: RecallExecutionTraceSummary,
  trace: { reportSummary(summary: RecallExecutionTraceSummary): void },
  noResultReason?: RecallNoResultReason,
): void {
  if (noResultReason) {
    summary.ranking.noResultReason = noResultReason;
  }

  trace.reportSummary(summary);
}

/**
 * Records one degraded-mode cause exactly once on the mutable trace summary.
 *
 * @param summary - Mutable recall execution summary.
 * @param reason - Stable degraded-mode cause.
 * @param notice - User-facing explanation of the degraded path.
 */
function markRecallDegraded(summary: RecallExecutionTraceSummary, reason: RecallDegradedReason, notice: string): void {
  summary.degraded.active = true;
  if (!summary.degraded.reasons.includes(reason)) {
    summary.degraded.reasons.push(reason);
  }
  if (!summary.degraded.notices.includes(notice)) {
    summary.degraded.notices.push(notice);
  }
}

/**
 * Refines no-result reasons when recall already degraded earlier in execution.
 *
 * @param summary - Mutable recall execution summary.
 * @param reason - Baseline no-result reason derived from the ranking flow.
 * @returns Stable no-result reason for trace emission.
 */
function resolveNoResultReason(summary: RecallExecutionTraceSummary, reason: RecallNoResultReason): RecallNoResultReason {
  if (!summary.degraded.active) {
    return reason;
  }
  if (reason === "no_candidates") {
    return "degraded_no_candidates";
  }
  if (reason === "below_threshold") {
    return "degraded_below_threshold";
  }
  return reason;
}

/**
 * Score a merged candidate using the reciprocal rank fusion recall model.
 *
 * @param candidate - Merged candidate data from vector and FTS retrieval.
 * @param queryText - Raw recall query text.
 * @param queryEmbedding - Query embedding vector.
 * @param rrfScore - Normalized RRF relevance score for this candidate.
 * @param params - Temporal anchors and ranking profile for scoring.
 * @returns Ranked candidate with score breakdown metadata.
 */
function scoreMergedCandidate(
  candidate: MergedCandidate,
  queryText: string,
  queryEmbedding: number[],
  rrfScore: number,
  params: {
    asOfDate: Date | null;
    aroundDate: Date | null;
    aroundRadius?: number;
    rankingProfile?: RecallRankingProfile;
  },
): RankedCandidate {
  const vector = candidate.vectorSim ?? cosineSimilarity(candidate.entry.embedding ?? [], queryEmbedding);
  const lexical = computeLexicalScore(queryText, candidate.entry.subject, candidate.entry.content);
  const recency = resolveRecencyScore(candidate.entry, params);
  const importance = importanceScore(candidate.entry.importance);
  const scored = scoreCandidate({
    relevance: rrfScore,
    vectorSim: vector,
    lexical,
    recency,
    importance,
  });

  return {
    entry: candidate.entry,
    score: scored.score,
    scores: {
      ...scored.scores,
      // `rrf` mirrors `relevance` and makes the reciprocal rank fusion source
      // explicit for trace summaries and cross-stage reasoning in later phases.
      rrf: scored.scores.relevance,
      historicalLineage: 0,
      neighborhoodBoost: 0,
      claimKeyTrustPenalty: 0,
      claimKeyRedundancyPenalty: 0,
    },
  };
}

/**
 * Resolve the fused relevance score per entry id for the current policy.
 *
 * When RRF is enabled (the default), the three ordered channels (vector,
 * lexical FTS, and optional neighborhood expansion) are fused into a single
 * normalized 0-1 score using the configured rank constant. When RRF is
 * explicitly disabled via `rankingPolicy.rrf === "disabled"`, the fallback
 * ranks candidates using only the vector channel; if the vector channel is
 * empty (degraded mode), the lexical channel takes over. Expansion ranks
 * are ignored in the fallback because they cannot be attributed to either
 * the query vector or its lexical form in isolation.
 *
 * The helper mutates `trace` in place with the same fused-candidate facts
 * the rest of the pipeline wants to see whether or not RRF actually ran.
 *
 * @param params - Per-channel ordered rank lists, policy overrides, and the mutable RRF trace branch.
 * @returns Map from entry id to normalized 0-1 relevance score.
 */
function resolveEntryRelevance(params: {
  vectorRanks: readonly string[];
  ftsRanks: readonly string[];
  expansionRanks: readonly string[];
  policy: RecallRankingPolicy | undefined;
  trace: RecallRrfTrace;
}): Map<string, number> {
  const { vectorRanks, ftsRanks, expansionRanks, policy, trace } = params;

  if (policy?.rrf === "disabled") {
    // Single-channel fallback: assign a shrinking relevance in vector-rank
    // order (or lexical order when vectors degraded out), so downstream
    // scoring still has a usable relevance signal without running RRF.
    const fallbackChannel = vectorRanks.length > 0 ? vectorRanks : ftsRanks;
    const fallback = new Map<string, number>();
    fallbackChannel.forEach((id, index) => {
      if (!fallback.has(id)) {
        fallback.set(id, 1 / (index + 1));
      }
    });
    trace.applied = false;
    trace.channelCount = fallbackChannel.length > 0 ? 1 : 0;
    trace.rankConstant = resolveRrfRankConstant(policy, fallback.size);
    trace.fusedCandidateCount = fallback.size;
    trace.maxFusedScore = fallback.size > 0 ? Math.max(...fallback.values()) : 0;
    return fallback;
  }

  const channels: readonly string[][] = [Array.from(vectorRanks), Array.from(ftsRanks), Array.from(expansionRanks)];
  const activeChannels = channels.filter((channel) => channel.length > 0);
  // Count unique fused IDs across channels so the small-pool rank-constant
  // override only applies when the fused shortlist is genuinely narrow.
  // Running RRF twice would be wasteful, so we collect IDs here and pass
  // the chosen rank constant into `rrfFuse` below.
  const uniqueFusedIds = new Set<string>();
  for (const channel of channels) {
    for (const id of channel) {
      uniqueFusedIds.add(id);
    }
  }
  const rankConstant = resolveRrfRankConstant(policy, uniqueFusedIds.size);
  trace.rankConstant = rankConstant;

  const fused = rrfFuse(channels, rankConstant);

  trace.applied = fused.size > 0;
  trace.channelCount = activeChannels.length;
  trace.fusedCandidateCount = fused.size;
  trace.maxFusedScore = fused.size > 0 ? Math.max(...fused.values()) : 0;

  return fused;
}

/**
 * Resolve the effective RRF rank constant from caller-supplied policy.
 *
 * When the fused pool is narrow (at or below `SMALL_POOL_RRF_POOL_SIZE`),
 * prefer the small-pool override (`rrfSmallPoolRankConstant`, default
 * `DEFAULT_RRF_SMALL_POOL_RANK_CONSTANT`) which sharpens rank-1 vs.
 * rank-2 differentiation enough to keep recency and importance
 * differences from flipping a clear vector leader. Larger pools fall
 * back to the canonical Cormack et al. `k = 60` unless the caller
 * explicitly overrides via `rrfRankConstant`.
 *
 * Non-finite or non-positive overrides are ignored in favor of the
 * documented defaults.
 *
 * @param policy - Optional ranking policy overrides.
 * @param fusedPoolSize - Size of the fused candidate pool, used to pick
 *   between the small-pool and general-pool rank constants.
 * @returns Positive finite rank constant.
 */
function resolveRrfRankConstant(policy: RecallRankingPolicy | undefined, fusedPoolSize: number): number {
  const rawGeneral = policy?.rrfRankConstant;
  const hasExplicitGeneral = typeof rawGeneral === "number" && Number.isFinite(rawGeneral) && rawGeneral > 0;
  const generalConstant = hasExplicitGeneral ? rawGeneral : DEFAULT_RRF_RANK_CONSTANT;

  const isSmallPool = Number.isFinite(fusedPoolSize) && fusedPoolSize > 0 && fusedPoolSize <= SMALL_POOL_RRF_POOL_SIZE;
  if (!isSmallPool) {
    return generalConstant;
  }

  const rawSmall = policy?.rrfSmallPoolRankConstant;
  if (typeof rawSmall === "number" && Number.isFinite(rawSmall) && rawSmall > 0) {
    return rawSmall;
  }

  // When a caller explicitly overrides the general rank constant but
  // leaves the small-pool override unset, treat the general override as
  // the caller's deliberate choice for every pool size; this preserves
  // the prior semantic of `rrfRankConstant` as a single knob. Callers
  // who want phase-4 sharpening either leave `rrfRankConstant` at its
  // default or set `rrfSmallPoolRankConstant` explicitly.
  if (hasExplicitGeneral) {
    return generalConstant;
  }

  return DEFAULT_RRF_SMALL_POOL_RANK_CONSTANT;
}

/**
 * Expand the candidate pool with bounded typed-neighborhood lineage.
 *
 * This is the generalized successor of the original historical-state
 * predecessor expansion. Only the `historical_state` ranking profile
 * asks the adapter for expansion today, since the default profile's
 * vector and FTS retrieval already excludes superseded and retired
 * rows, and therefore has nothing active left to expand to. Keeping
 * expansion historical-only preserves the phase 1 behavior that default
 * recall never surfaces retired or predecessor material while still
 * routing the historical profile through the generalized port.
 *
 * Returned candidates are ranked by cosine similarity against the query
 * so stronger lineage matches dominate the expansion RRF channel. The
 * function mutates `params.neighborhoodTrace` in place with the facts
 * needed for the neighborhood trace branch.
 *
 * @param mergedCandidates - Current merged active candidate map.
 * @param queryEmbedding - Query embedding used to rank adapter output.
 * @param ports - Recall ports that may expose neighborhood expansion.
 * @param params - Ranking profile plus mutable neighborhood trace branch.
 * @returns Rank-ordered expansion IDs for RRF, or an empty list when disabled.
 */
async function expandEntryNeighborhood(
  mergedCandidates: Map<string, MergedCandidate>,
  queryEmbedding: number[],
  ports: RecallPorts,
  params: {
    rankingProfile?: RecallRankingProfile;
    neighborhoodTrace: RecallNeighborhoodTrace;
  },
): Promise<string[]> {
  const trace = params.neighborhoodTrace;
  trace.expansionAvailable = Boolean(ports.expandNeighborhood);
  if (mergedCandidates.size === 0 || !ports.expandNeighborhood || params.rankingProfile !== "historical_state") {
    return [];
  }

  const families = HISTORICAL_NEIGHBORHOOD_FAMILIES;
  const includeRetired = true;
  const seedIds = Array.from(mergedCandidates.keys());

  trace.expansionRequested = true;
  trace.familiesRequested = [...families];
  trace.includeRetired = includeRetired;
  trace.seedIds = seedIds;

  const expanded = await ports.expandNeighborhood({
    seedIds,
    budget: DEFAULT_NEIGHBORHOOD_BUDGET,
    families,
    includeRetired,
  });
  // Rank the adapter-returned rows by cosine similarity against the
  // query so the expansion channel contributes a meaningful order to
  // RRF rather than an arbitrary adapter sort.
  const ranked = expanded
    .filter((entry) => !mergedCandidates.has(entry.id))
    .map((entry) => ({
      entry,
      vectorSim: cosineSimilarity(entry.embedding ?? [], queryEmbedding),
    }))
    .sort((left, right) => right.vectorSim - left.vectorSim || left.entry.id.localeCompare(right.entry.id));

  for (const candidate of ranked) {
    mergedCandidates.set(candidate.entry.id, {
      entry: candidate.entry,
      vectorSim: candidate.vectorSim,
    });
  }

  trace.expansionCandidates = ranked.length;
  return ranked.map((candidate) => candidate.entry.id);
}

/**
 * Apply a bounded seeded rerank over entry candidates using lineage matches.
 *
 * The rerank runs after historical lineage boosts so the historical profile
 * can still produce its strongest signals before lineage proximity is
 * considered, and it runs before claim-key shaping so trust or redundancy
 * penalties still have the final say on which rows dominate the answer.
 *
 * @param candidates - Ranked candidates after historical lineage boosts.
 * @param trace - Mutable neighborhood trace branch for the execution.
 * @returns Candidates with seeded lineage rerank boosts applied.
 */
function applySeededEntryRerank(candidates: RankedCandidate[], trace: RecallNeighborhoodTrace): RankedCandidate[] {
  if (candidates.length === 0) {
    return candidates;
  }

  const seeds = selectStrongSeeds(
    candidates.map((candidate) => ({ id: candidate.entry.id, score: candidate.score, entry: candidate.entry })),
    {
      topN: DEFAULT_STRONG_SEED_TOP_N,
      scoreGapFloor: DEFAULT_STRONG_SEED_SCORE_GAP,
    },
  );
  if (seeds.length === 0) {
    return candidates;
  }

  trace.strongSeedIds = seeds.map((seed) => seed.id);
  const payloads = candidates.map((candidate) => ({
    id: candidate.entry.id,
    score: candidate.score,
    entry: candidate.entry,
  }));
  const reranked = seededRerank(payloads, seeds, (candidate, seed) => sharesEntryLineage(candidate.entry, seed.entry), {
    weight: DEFAULT_SEEDED_RERANK_WEIGHT,
  });
  trace.rerankBoostedIds = reranked.boostedIds;

  const scoreById = new Map(reranked.candidates.map((candidate) => [candidate.id, candidate.score]));
  return candidates.map((candidate) => {
    const nextScore = scoreById.get(candidate.entry.id) ?? candidate.score;
    const delta = nextScore - candidate.score;
    if (delta <= 0) {
      return candidate;
    }

    return {
      ...candidate,
      score: nextScore,
      scores: {
        ...candidate.scores,
        neighborhoodBoost: candidate.scores.neighborhoodBoost + delta,
      },
    };
  });
}

/**
 * Resolve the recency contribution for one ranked candidate.
 *
 * Historical-state queries without an explicit around-date should not reward the
 * newer/current entry purely for being newer, so they use a flat neutral signal.
 *
 * @param entry - Candidate entry being ranked.
 * @param params - Optional temporal anchor and ranking profile.
 * @returns Normalized recency score in the 0-1 range.
 */
function resolveRecencyScore(
  entry: RecallCandidateEntry,
  params: {
    asOfDate: Date | null;
    aroundDate: Date | null;
    aroundRadius?: number;
    rankingProfile?: RecallRankingProfile;
  },
): number {
  if (params.asOfDate) {
    return resolveAsOfScore(entry, params.asOfDate);
  }

  if (params.aroundDate) {
    return gaussianRecency(entry.created_at, params.aroundDate, normalizeAroundRadius(params.aroundRadius));
  }

  if (params.rankingProfile === "historical_state") {
    return HISTORICAL_STATE_FLAT_RECENCY;
  }

  return recencyScore(entry.created_at, entry.expiry);
}

/**
 * Resolves how well one candidate matches an explicit as-of reference point.
 *
 * World-valid bounds win when present. If a row lacks those bounds, support
 * observation time becomes the next-best temporal signal, with created-at kept
 * as the weakest fallback clock.
 *
 * @param entry - Candidate entry being scored.
 * @param asOfDate - Explicit reference point requested by the caller.
 * @returns Normalized temporal fit score in the 0-1 range.
 */
function resolveAsOfScore(entry: RecallCandidateEntry, asOfDate: Date): number {
  const validFrom = parseTimestamp(entry.valid_from);
  const validTo = parseTimestamp(entry.valid_to);
  if (validFrom || validTo) {
    const startMs = validFrom?.getTime() ?? Number.NEGATIVE_INFINITY;
    const endMs = validTo?.getTime() ?? Number.POSITIVE_INFINITY;
    const asOfMs = asOfDate.getTime();
    if (asOfMs >= startMs && asOfMs <= endMs) {
      return 1;
    }

    const nearestBoundaryMs = asOfMs < startMs ? startMs : endMs;
    return Math.max(0.1, gaussianRecency(new Date(nearestBoundaryMs).toISOString(), asOfDate, 21) * 0.65);
  }

  const observedAt = parseTimestamp(entry.claim_support_observed_at);
  if (observedAt) {
    const observedBeforeAsOf = observedAt.getTime() <= asOfDate.getTime();
    const proximity = gaussianRecency(observedAt.toISOString(), asOfDate, 30);
    return observedBeforeAsOf ? Math.max(0.45, proximity * 0.8) : Math.max(0.05, proximity * 0.2);
  }

  const createdAt = parseTimestamp(entry.created_at);
  if (createdAt) {
    const createdBeforeAsOf = createdAt.getTime() <= asOfDate.getTime();
    const proximity = gaussianRecency(createdAt.toISOString(), asOfDate, 45);
    return createdBeforeAsOf ? Math.max(0.35, proximity * 0.7) : Math.max(0.05, proximity * 0.15);
  }

  return HISTORICAL_STATE_FLAT_RECENCY;
}

/**
 * Apply historical-only lineage boosts after the base score is computed.
 *
 * Direct predecessors receive the strongest boost. When explicit lineage is
 * absent, older claim-key siblings and same-topic peers can still get a
 * smaller boost against an active successor candidate.
 *
 * The historical_state profile was the primary regression surface in the
 * phase-0 attribution sweep: RRF places any active current-state peer well
 * above its superseded predecessor, and a fixed additive boost of 0.08 is
 * too small to flip the final composite when RRF assigns the successor a
 * much higher relevance. The bonus here is therefore shaped by the score
 * gap to the highest-scoring active peer with a qualifying historical
 * relation, so the predecessor always edges the successor by
 * `HISTORICAL_LINEAGE_GAP_MARGIN`. The floor (`HISTORICAL_PREDECESSOR_BOOST`
 * for direct supersession, `HISTORICAL_OLDER_STATE_BOOST` /
 * `HISTORICAL_RETIRED_PREDECESSOR_BOOST` otherwise) still applies when the
 * pool's RRF layout already puts the predecessor close enough that the
 * fixed delta was sufficient.
 *
 * @param candidates - Base-scored candidates before final ranking.
 * @param params - Historical ranking profile and optional around-date anchor.
 * @returns Candidate list with historical boosts applied when relevant.
 */
function applyHistoricalLineageBoosts(
  candidates: RankedCandidate[],
  params: {
    aroundDate: Date | null;
    rankingProfile?: RecallRankingProfile;
  },
  claimKeyTrace: RecallExecutionTraceSummary["claimKey"],
  slotPolicyConfig?: RecallExecutionOptions["slotPolicyConfig"],
): RankedCandidate[] {
  if (params.rankingProfile !== "historical_state") {
    return candidates;
  }

  const entries = candidates.map((candidate) => candidate.entry);
  const scoresById = new Map(candidates.map((candidate) => [candidate.entry.id, candidate.score]));
  return candidates.map((candidate) => {
    const decision = resolveHistoricalLineageBonus(candidate.entry, entries, scoresById, candidate.score, params.aroundDate, slotPolicyConfig);
    if (decision.tentativeLineageSuppressed) {
      claimKeyTrace.tentativeLineageSuppressed += 1;
    }

    const bonus = decision.bonus;
    if (bonus <= 0) {
      return candidate;
    }

    claimKeyTrace.historicalBoosted += 1;
    return {
      ...candidate,
      score: clampRecallScore(candidate.score + bonus),
      scores: {
        ...candidate.scores,
        historicalLineage: candidate.scores.historicalLineage + bonus,
      },
    };
  });
}

/**
 * Resolve the lineage-relative historical bonus for one candidate.
 *
 * @param entry - Candidate being evaluated.
 * @param entries - All candidate entries currently in the result set.
 * @param scoresById - Base score lookup used to shape the proportional bonus.
 * @param candidateScore - Candidate's pre-boost composite score.
 * @param aroundDate - Optional explicit around-date anchor.
 * @returns Additive historical bonus and any trust-aware suppression facts.
 */
function resolveHistoricalLineageBonus(
  entry: RecallCandidateEntry,
  entries: RecallCandidateEntry[],
  scoresById: ReadonlyMap<string, number>,
  candidateScore: number,
  aroundDate: Date | null,
  slotPolicyConfig?: RecallExecutionOptions["slotPolicyConfig"],
): {
  bonus: number;
  tentativeLineageSuppressed: boolean;
} {
  const directSuccessor = entries.find((peer) => peer.id !== entry.id && entry.superseded_by === peer.id);
  if (directSuccessor) {
    const successorScore = scoresById.get(directSuccessor.id) ?? 0;
    return {
      bonus: shapeHistoricalLineageBonus(HISTORICAL_PREDECESSOR_BOOST, candidateScore, successorScore),
      tentativeLineageSuppressed: false,
    };
  }

  if (aroundDate) {
    return {
      bonus: 0,
      tentativeLineageSuppressed: false,
    };
  }

  let tentativeLineageSuppressed = false;
  let bestPeerScore = 0;
  let peerMatched = false;
  for (const peer of entries) {
    if (peer.id === entry.id || !isPotentialCurrentPeer(peer) || createdAtMs(entry.created_at) >= createdAtMs(peer.created_at)) {
      continue;
    }

    const relation = resolveHistoricalPeerRelation(entry, peer, entries, slotPolicyConfig);
    if (relation === "tentative_claim_key_suppressed") {
      tentativeLineageSuppressed = true;
      continue;
    }

    if (relation === null) {
      continue;
    }

    peerMatched = true;
    const peerScore = scoresById.get(peer.id) ?? 0;
    if (peerScore > bestPeerScore) {
      bestPeerScore = peerScore;
    }
  }

  if (!peerMatched) {
    return {
      bonus: 0,
      tentativeLineageSuppressed,
    };
  }

  const base = entry.retired ? HISTORICAL_RETIRED_PREDECESSOR_BOOST : HISTORICAL_OLDER_STATE_BOOST;
  return {
    bonus: shapeHistoricalLineageBonus(base, candidateScore, bestPeerScore),
    tentativeLineageSuppressed,
  };
}

/**
 * Shape the additive historical-state lineage bonus.
 *
 * Starts from a fixed floor (direct predecessor, retired predecessor, or
 * older-state) so candidates that already outrank their successor keep the
 * previously validated delta. When the successor's composite dominates the
 * predecessor's composite, the bonus expands to close that gap plus
 * `HISTORICAL_LINEAGE_GAP_MARGIN`, so the superseded entry narrowly edges
 * the current-state peer without drowning the rest of the shortlist. The
 * result is capped at `HISTORICAL_LINEAGE_MAX_BONUS` so MMR diversification
 * and claim-key shaping still have room to operate after the boost lands.
 *
 * @param base - Fixed floor for the specific historical relation.
 * @param candidateScore - Candidate's pre-boost composite score.
 * @param successorScore - Best-scoring active peer with a qualifying historical relation.
 * @returns Bounded additive bonus for the candidate.
 */
function shapeHistoricalLineageBonus(base: number, candidateScore: number, successorScore: number): number {
  const gap = successorScore - candidateScore;
  const needed = gap > 0 ? gap + HISTORICAL_LINEAGE_GAP_MARGIN : 0;
  return Math.min(HISTORICAL_LINEAGE_MAX_BONUS, Math.max(base, needed));
}

/**
 * Check whether one candidate is an active-like current-state peer.
 *
 * @param entry - Candidate under evaluation.
 * @returns True when the entry looks like a current-state peer.
 */
function isPotentialCurrentPeer(entry: RecallCandidateEntry): boolean {
  return !entry.retired && entry.superseded_by === undefined;
}

/**
 * Resolve the historical relationship between an older candidate and a current peer.
 *
 * @param left - Potential prior-state candidate.
 * @param right - Potential current-state peer.
 * @param entries - All candidate entries currently in the result set.
 * @returns Historical peer relation, or null when the pair is unrelated.
 */
function resolveHistoricalPeerRelation(
  left: RecallCandidateEntry,
  right: RecallCandidateEntry,
  entries: RecallCandidateEntry[],
  slotPolicyConfig?: RecallExecutionOptions["slotPolicyConfig"],
): "claim_key" | "topic" | "tentative_claim_key_suppressed" | null {
  if (left.claim_key && right.claim_key && left.claim_key === right.claim_key) {
    if (resolveClaimSlotPolicy(left.claim_key, slotPolicyConfig).policy === "multivalued") {
      return null;
    }
    return canUseClaimKeyLineage(left, entries, slotPolicyConfig) ? "claim_key" : "tentative_claim_key_suppressed";
  }

  return sharesHistoricalTopic(left, right) ? "topic" : null;
}

/**
 * Decide whether a candidate can use claim-key lineage as trusted historical evidence.
 *
 * Tentative or unresolved claim keys stop contributing same-slot historical
 * boosts once a trusted competing sibling for that slot is present.
 *
 * @param entry - Candidate requesting claim-key lineage treatment.
 * @param entries - All candidate entries currently in the result set.
 * @returns True when the entry may use claim-key lineage for boosting.
 */
function canUseClaimKeyLineage(
  entry: RecallCandidateEntry,
  entries: RecallCandidateEntry[],
  slotPolicyConfig?: RecallExecutionOptions["slotPolicyConfig"],
): boolean {
  if (!entry.claim_key) {
    return false;
  }

  if (resolveClaimSlotPolicy(entry.claim_key, slotPolicyConfig).policy === "multivalued") {
    return false;
  }

  if (!hasTrustedClaimKeyEvidence(entries, entry.claim_key)) {
    return true;
  }

  return entry.claim_key_status === "trusted";
}

/**
 * Check whether a trusted claim-key sibling exists for one slot in the candidate set.
 *
 * @param entries - All candidate entries currently in the result set.
 * @param claimKey - Claim-key slot identity under inspection.
 * @returns True when at least one sibling for the slot is explicitly trusted.
 */
function hasTrustedClaimKeyEvidence(entries: RecallCandidateEntry[], claimKey: string): boolean {
  return entries.some((entry) => entry.claim_key === claimKey && entry.claim_key_status === "trusted");
}

/**
 * Compare two candidate subjects for fallback same-topic historical lineage.
 *
 * @param left - Left candidate.
 * @param right - Right candidate.
 * @returns True when the subjects share enough topical overlap.
 */
function sharesHistoricalTopic(left: RecallCandidateEntry, right: RecallCandidateEntry): boolean {
  const leftTokens = tokenize(left.subject);
  const rightTokens = tokenize(right.subject);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return false;
  }

  const sharedPrefixCount = countSharedPrefixTokens(leftTokens, rightTokens);
  return sharedPrefixCount >= HISTORICAL_TOPIC_SHARED_PREFIX_MIN && sharedPrefixCount / leftTokens.length >= HISTORICAL_TOPIC_PREFIX_OF_CANDIDATE_MIN;
}

/** Parse a candidate timestamp into milliseconds, or zero when invalid. */
function createdAtMs(value: string): number {
  return parseTimestamp(value)?.getTime() ?? 0;
}

/** Parse an optional ISO-like timestamp into a Date when valid. */
function parseTimestamp(value: string | undefined): Date | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  const timestamp = new Date(normalized);
  return Number.isFinite(timestamp.getTime()) ? timestamp : null;
}

/** Count the consecutive shared prefix tokens between two subject token lists. */
function countSharedPrefixTokens(leftTokens: string[], rightTokens: string[]): number {
  const length = Math.min(leftTokens.length, rightTokens.length);
  let sharedPrefixCount = 0;

  for (let index = 0; index < length; index += 1) {
    if (leftTokens[index] !== rightTokens[index]) {
      break;
    }

    sharedPrefixCount += 1;
  }

  return sharedPrefixCount;
}

/**
 * Apply MMR diversification over the shaped shortlist when enabled.
 *
 * The function reorders candidates without mutating their composite
 * score: MMR only changes which candidates ride the final shortlist into
 * the threshold, budget, and limit slice steps. When the caller disables
 * MMR through `rankingPolicy.mmr === "disabled"` or when fewer than two
 * candidates have embeddings, the input order is preserved and the
 * trace records `applied: false` so downstream consumers can tell the
 * diversification stage ran and no-op'd.
 *
 * @param candidates - Candidates after claim-key shaping, sorted by score.
 * @param queryEmbedding - Query embedding used as the MMR relevance signal.
 * @param policy - Optional ranking policy overrides from the caller.
 * @param trace - Mutable MMR trace branch for the execution.
 * @returns Candidates in their new MMR-driven order.
 */
function applyMmrDiversification(
  candidates: RankedCandidate[],
  queryEmbedding: number[],
  policy: RecallRankingPolicy | undefined,
  trace: RecallMmrTrace,
): RankedCandidate[] {
  if (candidates.length < 2 || policy?.mmr === "disabled") {
    trace.applied = false;
    trace.lambda = resolveMmrLambda(policy);
    return candidates;
  }

  const reorder = maximalMarginalRelevance({
    queryVector: queryEmbedding,
    candidates: candidates.map((candidate) => ({
      id: candidate.entry.id,
      relevance: candidate.score,
      ...(candidate.entry.embedding ? { embedding: candidate.entry.embedding } : {}),
    })),
    lambda: resolveMmrLambda(policy),
    minPoolSize: resolveMmrMinPoolSize(policy),
  });

  trace.applied = reorder.applied;
  trace.lambda = reorder.lambda;
  trace.droppedDuplicateCount = reorder.droppedDuplicateCount;
  trace.reorderedIds = reorder.reorderedIds;

  if (!reorder.applied) {
    return candidates;
  }

  const candidatesById = new Map(candidates.map((candidate) => [candidate.entry.id, candidate]));
  return reorder.orderedIds.flatMap((id) => {
    const candidate = candidatesById.get(id);
    return candidate ? [candidate] : [];
  });
}

/**
 * Apply the cross-encoder rerank stage over the top-K shortlist of
 * entry candidates. The helper fails closed on adapter errors and
 * records trace-visible facts for diagnostics, so the rerank can never
 * drop recall below its pre-rerank baseline.
 *
 * The stage runs after MMR diversification so the cross-encoder
 * observes the post-diversity ordering. It runs before thresholding so
 * the rerank-adjusted composite score decides admission to the final
 * result set. When the stage reorders candidates, the relevant
 * `scores.crossEncoder` fields are populated and the composite
 * `score` is blended per policy.
 *
 * @param candidates - Candidates after MMR diversification.
 * @param query - Normalized recall query text.
 * @param crossEncoder - Optional cross-encoder port from `RecallPorts`.
 * @param policy - Optional ranking policy overrides from the caller.
 * @param trace - Mutable cross-encoder trace branch for the execution.
 * @returns Candidates in their post-rerank order.
 */
async function applyEntryCrossEncoderRerank(
  candidates: RankedCandidate[],
  query: string,
  crossEncoder: RecallPorts["crossEncoder"],
  policy: RecallRankingPolicy | undefined,
  trace: RecallCrossEncoderTrace,
): Promise<RankedCandidate[]> {
  const result = await applyCrossEncoderRerank({
    query,
    candidates: candidates.map((candidate) => ({
      id: candidate.entry.id,
      text: buildCrossEncoderPassageText(candidate.entry),
      score: candidate.score,
      candidate,
    })),
    port: crossEncoder,
    disabled: policy?.crossEncoder === "disabled",
    topK: policy?.crossEncoderTopK ?? DEFAULT_CROSS_ENCODER_TOP_K,
    alpha: policy?.crossEncoderAlpha ?? DEFAULT_CROSS_ENCODER_ALPHA,
  });

  trace.applied = result.applied;
  trace.k = result.k;
  trace.alpha = result.alpha;
  trace.latencyMs = result.latencyMs;
  trace.rescoredIds = [...result.rescoredIds];
  if (result.degradedReason) {
    trace.degradedReason = result.degradedReason;
  } else {
    delete trace.degradedReason;
  }

  return result.candidates.map((entry) => {
    const scoredCandidate = entry.candidate;
    const nextScore = entry.score;
    if (typeof entry.crossEncoderScore !== "number" && nextScore === scoredCandidate.score) {
      return scoredCandidate;
    }

    return {
      ...scoredCandidate,
      score: nextScore,
      scores: {
        ...scoredCandidate.scores,
        ...(typeof entry.crossEncoderScore === "number" ? { crossEncoder: entry.crossEncoderScore } : {}),
      },
    };
  });
}

/**
 * Build the free-form passage text fed into the cross-encoder for one
 * candidate entry.
 *
 * Combining subject and content gives the rerank classifier enough
 * context to decide relevance without burning tokens on metadata the
 * classifier does not need.
 */
function buildCrossEncoderPassageText(entry: RecallCandidateEntry): string {
  const subject = entry.subject.trim();
  const content = entry.content.trim();
  if (subject.length === 0) {
    return content;
  }

  if (content.length === 0) {
    return subject;
  }

  return `${subject}\n\n${content}`;
}

/**
 * Resolve the effective MMR lambda from caller-supplied policy.
 *
 * @param policy - Optional ranking policy overrides.
 * @returns Lambda in the inclusive 0-1 range.
 */
function resolveMmrLambda(policy: RecallRankingPolicy | undefined): number {
  const rawLambda = policy?.mmrLambda;
  if (typeof rawLambda !== "number" || !Number.isFinite(rawLambda)) {
    return DEFAULT_MMR_LAMBDA;
  }

  return Math.max(0, Math.min(1, rawLambda));
}

/**
 * Resolve the effective MMR minimum-pool-size gate from caller-supplied
 * policy. Non-finite or negative overrides fall back to the core
 * `DEFAULT_MMR_MIN_POOL_SIZE` so a misconfigured eval cannot
 * accidentally widen the gate; a `0` override is honored so evals can
 * disable the gate entirely.
 *
 * @param policy - Optional ranking policy overrides.
 * @returns Effective non-negative integer gate size.
 */
function resolveMmrMinPoolSize(policy: RecallRankingPolicy | undefined): number {
  const raw = policy?.mmrMinPoolSize;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return DEFAULT_MMR_MIN_POOL_SIZE;
  }

  return Math.floor(raw);
}

/**
 * Apply light claim-key-aware penalties that reduce current-state redundancy.
 *
 * Trusted current-slot duplicates are down-ranked after the strongest sibling
 * so they do not crowd out unrelated answers. Tentative siblings for a slot
 * with a trusted current peer are also down-ranked so they cannot dominate the
 * current answer solely through recency or semantic similarity.
 *
 * @param candidates - Ranked candidates after historical lineage boosts.
 * @param claimKeyTrace - Mutable claim-key trace counters for one recall execution.
 * @returns Candidates with score penalties applied when needed.
 */
function applyClaimKeyResultShaping(
  candidates: RankedCandidate[],
  claimKeyTrace: RecallExecutionTraceSummary["claimKey"],
  slotPolicyConfig?: RecallExecutionOptions["slotPolicyConfig"],
): RankedCandidate[] {
  if (candidates.length === 0) {
    return candidates;
  }

  const trustedActiveClaimKeys = new Set(
    candidates
      .map((candidate) => candidate.entry)
      .filter(
        (entry) =>
          isPotentialCurrentPeer(entry) &&
          entry.claim_key &&
          entry.claim_key_status === "trusted" &&
          resolveClaimSlotPolicy(entry.claim_key, slotPolicyConfig).policy === "exclusive",
      )
      .map((entry) => entry.claim_key!),
  );
  const trustedSlotRankById = rankTrustedSlotSiblings(candidates, slotPolicyConfig);

  return candidates.map((candidate) => {
    const trustPenalty = shouldPenalizeTentativeCurrentSibling(candidate.entry, trustedActiveClaimKeys) ? CLAIM_KEY_TENTATIVE_CURRENT_PENALTY : 0;
    const redundancyPenalty = resolveTrustedSlotRedundancyPenalty(candidate.entry.id, trustedSlotRankById);
    if (trustPenalty <= 0 && redundancyPenalty <= 0) {
      return candidate;
    }

    if (trustPenalty > 0) {
      claimKeyTrace.trustPenalized += 1;
    }

    if (redundancyPenalty > 0) {
      claimKeyTrace.redundancyPenalized += 1;
    }

    return {
      ...candidate,
      score: clampRecallScore(candidate.score - trustPenalty - redundancyPenalty),
      scores: {
        ...candidate.scores,
        claimKeyTrustPenalty: trustPenalty,
        claimKeyRedundancyPenalty: redundancyPenalty,
      },
    };
  });
}

/**
 * Rank active trusted siblings within each claim-key slot by current score.
 *
 * @param candidates - Ranked candidates before final sorting.
 * @returns Candidate-to-rank mapping where zero is the best trusted sibling.
 */
function rankTrustedSlotSiblings(candidates: RankedCandidate[], slotPolicyConfig?: RecallExecutionOptions["slotPolicyConfig"]): Map<string, number> {
  const candidatesById = new Map(candidates.map((candidate) => [candidate.entry.id, candidate]));
  const trustedByClaimKey = new Map<string, RankedCandidate[]>();

  for (const candidate of candidates) {
    const claimKey = candidate.entry.claim_key;
    if (
      !claimKey ||
      candidate.entry.claim_key_status !== "trusted" ||
      !isPotentialCurrentPeer(candidate.entry) ||
      resolveClaimSlotPolicy(claimKey, slotPolicyConfig).policy !== "exclusive"
    ) {
      continue;
    }

    const siblings = trustedByClaimKey.get(claimKey) ?? [];
    siblings.push(candidate);
    trustedByClaimKey.set(claimKey, siblings);
  }

  const ranks = new Map<string, number>();
  for (const siblings of trustedByClaimKey.values()) {
    siblings
      .slice()
      .sort(compareCandidatesForTrustedSlotRank)
      .forEach((candidate, index) => {
        if (candidatesById.has(candidate.entry.id)) {
          ranks.set(candidate.entry.id, index);
        }
      });
  }

  return ranks;
}

/**
 * Compare active trusted same-slot siblings for redundancy shaping order.
 *
 * @param left - Left candidate.
 * @param right - Right candidate.
 * @returns Negative when the left candidate should remain ahead.
 */
function compareCandidatesForTrustedSlotRank(left: RankedCandidate, right: RankedCandidate): number {
  return right.score - left.score || createdAtMs(right.entry.created_at) - createdAtMs(left.entry.created_at) || left.entry.id.localeCompare(right.entry.id);
}

/**
 * Decide whether an active current-state candidate should defer to a trusted peer.
 *
 * @param entry - Candidate under evaluation.
 * @param trustedActiveClaimKeys - Claim-key slots that already have a trusted active sibling.
 * @returns True when a trust penalty should be applied.
 */
function shouldPenalizeTentativeCurrentSibling(entry: RecallCandidateEntry, trustedActiveClaimKeys: Set<string>): boolean {
  return isPotentialCurrentPeer(entry) && entry.claim_key !== undefined && entry.claim_key_status !== "trusted" && trustedActiveClaimKeys.has(entry.claim_key);
}

/**
 * Resolve the redundancy penalty for one trusted active slot sibling.
 *
 * @param entryId - Candidate identifier.
 * @param trustedSlotRankById - Rank of each trusted active sibling within its slot.
 * @returns Penalty to subtract from the score.
 */
function resolveTrustedSlotRedundancyPenalty(entryId: string, trustedSlotRankById: Map<string, number>): number {
  const rank = trustedSlotRankById.get(entryId) ?? 0;
  if (rank <= 0) {
    return 0;
  }

  return Math.min(CLAIM_KEY_REDUNDANT_TRUSTED_SLOT_MAX_PENALTY, rank * CLAIM_KEY_REDUNDANT_TRUSTED_SLOT_PENALTY);
}

/** Clamp a ranked recall score into the supported 0-1 range. */
function clampRecallScore(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Require raw retrieval evidence before score shaping can return a candidate.
 *
 * Lexical overlap is already a direct support signal. Vector-only matches must
 * clear a separate floor so recency and importance cannot rescue weak semantic
 * drift into a returned answer.
 *
 * @param candidate - Ranked candidate with raw score breakdowns.
 * @returns True when the candidate is return-worthy.
 */
function hasSufficientReturnEvidence(candidate: RankedCandidate, query: RecallInput): boolean {
  if (query.rankingProfile === "entity_attribute") {
    return hasEntityAttributeEvidence(candidate.entry, query.queryShape);
  }

  const groundedLexicalSupport = hasGroundedLexicalSupport(candidate.entry, query.text);
  if (candidate.scores.lexical > 0) {
    if (groundedLexicalSupport) {
      return true;
    }

    return candidate.scores.vector >= MIN_VECTOR_WITHOUT_GROUNDED_LEXICAL_SUPPORT;
  }

  if (isWeaklyGroundedReminderQuery(query.text) && !groundedLexicalSupport) {
    return false;
  }

  return candidate.scores.vector >= MIN_VECTOR_ONLY_EVIDENCE;
}

/**
 * Require at least one non-generic query token to overlap before lexical
 * evidence alone can justify a returned answer.
 *
 * Queries such as "what coffee order should I remember" or "the thing from
 * earlier" often overlap only on conversational filler like `remember`,
 * `order`, or `earlier`. Those tokens are useful for retrieval recall, but
 * they are not strong enough by themselves to ground a durable-memory answer.
 *
 * @param entry - Candidate entry under consideration.
 * @param queryText - Raw recall query text.
 * @returns True when the candidate matches at least one grounded query token.
 */
function hasGroundedLexicalSupport(entry: RecallCandidateEntry, queryText: string): boolean {
  const groundingTokens = getGroundingTokens(queryText);
  if (groundingTokens.length === 0) {
    return false;
  }

  const candidateTokens = new Set(tokenize(`${entry.subject} ${entry.content}`).map(canonicalizeRecallToken));
  return groundingTokens.some((token) => candidateTokens.has(token));
}

/**
 * Detect reminder-style queries that lack enough grounding to trust a
 * vector-only durable-memory answer.
 *
 * These turns often ask about "the thing from earlier" or what was
 * "mentioned last time". Without any lexical grounding, a medium-strength
 * embedding neighbor is usually a false positive rather than a recoverable
 * durable fact.
 *
 * @param queryText - Raw recall query text.
 * @returns True when the query reads like a weakly grounded reminder request.
 */
function isWeaklyGroundedReminderQuery(queryText: string): boolean {
  return WEAKLY_GROUNDED_REMINDER_PATTERN.test(queryText);
}

/**
 * Applies precision-first structured evidence checks for entity-attribute recall.
 *
 * @param entry - Ranking-time entry candidate.
 * @param queryShape - Structured entity-attribute query metadata.
 * @returns True when the candidate provides strong enough structured evidence.
 */
function hasEntityAttributeEvidence(entry: RecallCandidateEntry, queryShape: RecallInput["queryShape"]): boolean {
  if (queryShape?.kind !== "entity_attribute") {
    return false;
  }

  const normalizedSubject = normalizeEntityAttributeText(entry.subject);
  const normalizedContent = normalizeEntityAttributeText(entry.content);
  const combinedTokens = new Set(tokenize(`${entry.subject} ${entry.content}`));
  const entityTokenMatches = countTokenMatches(queryShape.entityTokens, combinedTokens);
  const attributeTokenMatches = countTokenMatches(queryShape.attributeTokens, combinedTokens);

  if (queryShape.attributeKind === "identity") {
    if (normalizedSubject === queryShape.normalizedEntity || isIdentityWrapperSubject(normalizedSubject, queryShape.normalizedEntity)) {
      return true;
    }
  }

  if (
    (containsNormalizedPhrase(normalizedSubject, queryShape.normalizedEntity) || containsNormalizedPhrase(normalizedContent, queryShape.normalizedEntity)) &&
    (queryShape.entityTokens.length >= 2 || attributeTokenMatches >= 1)
  ) {
    return true;
  }

  return entityTokenMatches >= 2 && attributeTokenMatches >= 1;
}

/**
 * Counts how many expected tokens appear in a candidate token set.
 *
 * @param expectedTokens - Query-derived tokens that should appear.
 * @param availableTokens - Candidate token set built from subject and content.
 * @returns Number of matching tokens.
 */
function countTokenMatches(expectedTokens: readonly string[], availableTokens: ReadonlySet<string>): number {
  let matches = 0;

  for (const token of expectedTokens) {
    if (availableTokens.has(token)) {
      matches += 1;
    }
  }

  return matches;
}

/**
 * Detects the `<entity> identity/profile/...` subject wrapper shape.
 *
 * @param normalizedSubject - Candidate subject normalized for comparison.
 * @param normalizedEntity - Normalized query entity text.
 * @returns True when the subject is a supported identity wrapper.
 */
function isIdentityWrapperSubject(normalizedSubject: string, normalizedEntity: string): boolean {
  return Array.from(ENTITY_ATTRIBUTE_IDENTITY_WRAPPERS).some((wrapper) => normalizedSubject === `${normalizedEntity} ${wrapper}`);
}

/**
 * Tests whether a normalized phrase appears in normalized candidate text.
 *
 * @param normalizedText - Candidate text normalized for comparison.
 * @param normalizedPhrase - Query phrase normalized for comparison.
 * @returns True when the phrase appears contiguously in the text.
 */
function containsNormalizedPhrase(normalizedText: string, normalizedPhrase: string): boolean {
  return normalizedPhrase.length > 0 && normalizedText.includes(normalizedPhrase);
}

/**
 * Normalizes candidate text for entity-attribute phrase comparisons.
 *
 * @param text - Raw candidate subject or content text.
 * @returns Lowercased whitespace-normalized text.
 */
function normalizeEntityAttributeText(text: string): string {
  return text.replace(/\s+/gu, " ").trim().normalize("NFKC").toLocaleLowerCase();
}

/**
 * Merge vector and FTS candidate sets into a unique entry-id keyed map and
 * preserve the per-channel rank lists needed by reciprocal rank fusion.
 *
 * Vector similarity is preserved when an entry appears in both retrieval
 * paths. The returned rank lists are ordered most-relevant first and mirror
 * the order produced by the retrieval adapters so RRF can treat channel
 * position as the rank signal for each candidate.
 *
 * @param vectorCandidates - Candidates admitted by vector similarity search.
 * @param ftsCandidates - Candidates admitted by lexical FTS search.
 * @returns Merged candidate map plus per-channel ordered rank lists.
 */
function mergeCandidates(
  vectorCandidates: VectorCandidate[],
  ftsCandidates: FtsCandidate[],
): {
  merged: Map<string, MergedCandidate>;
  vectorRanks: string[];
  ftsRanks: string[];
} {
  const merged = new Map<string, MergedCandidate>();
  const vectorRanks: string[] = [];
  const ftsRanks: string[] = [];

  for (const candidate of vectorCandidates) {
    if (!merged.has(candidate.entry.id)) {
      vectorRanks.push(candidate.entry.id);
    }
    merged.set(candidate.entry.id, {
      entry: candidate.entry,
      vectorSim: candidate.vectorSim,
    });
  }

  for (const candidate of ftsCandidates) {
    ftsRanks.push(candidate.entry.id);
    const existing = merged.get(candidate.entry.id);
    if (existing) {
      existing.entry = existing.entry.embedding ? existing.entry : candidate.entry;
      continue;
    }

    merged.set(candidate.entry.id, {
      entry: candidate.entry,
    });
  }

  return {
    merged,
    vectorRanks,
    ftsRanks,
  };
}

/**
 * Build SQL-pushable entry filters from parsed recall query parameters.
 *
 * @param types - Optional type filter list.
 * @param tags - Optional tag filter list.
 * @param since - Optional lower created-at bound.
 * @param until - Optional upper created-at bound.
 * @returns Adapter filter payload, or undefined when no filters are active.
 */
function buildEntryFilters(types: RecallInput["types"], tags: RecallInput["tags"], since: Date | null, until: Date | null): EntryFilters | undefined {
  const filters: EntryFilters = {};

  if (types && types.length > 0) {
    filters.types = types;
  }

  if (tags && tags.length > 0) {
    filters.tags = tags;
  }

  if (since) {
    filters.since = since;
  }

  if (until) {
    filters.until = until;
  }

  return Object.keys(filters).length > 0 ? filters : undefined;
}

/**
 * Apply a greedy token budget while always keeping the first qualifying result.
 *
 * @param results - Threshold-qualified results in descending score order.
 * @param budget - Maximum approximate token budget.
 * @returns Budget-constrained result list.
 */
function applyBudget(results: RankedCandidate[], budget: number): RankedCandidate[] {
  if (results.length === 0) {
    return [];
  }

  const accepted: RankedCandidate[] = [results[0]!];
  let consumed = estimateTokens(results[0]!.entry);

  for (const result of results.slice(1)) {
    const estimate = estimateTokens(result.entry);
    if (consumed + estimate > budget) {
      continue;
    }

    accepted.push(result);
    consumed += estimate;
  }

  return accepted;
}

/**
 * Sort the final accepted shortlist by descending score while preserving
 * existing order for exact score ties.
 *
 * MMR intentionally changes which candidates survive into the bounded
 * shortlist, but the user-facing output should still present that accepted
 * set in descending score order so printed scores and rank order agree.
 *
 * @param candidates - Accepted shortlist after threshold and budget shaping.
 * @returns Stable score-descending candidate order.
 */
function sortAcceptedCandidates(candidates: RankedCandidate[], queryText: string, rankingProfile?: RecallRankingProfile): RankedCandidate[] {
  if (rankingProfile === "historical_state" || rankingProfile === "entity_attribute") {
    return candidates
      .map((candidate, index) => ({ candidate, index }))
      .sort((left, right) => right.candidate.score - left.candidate.score || left.index - right.index)
      .map(({ candidate }) => candidate);
  }

  const groundingTokens = getGroundingTokens(queryText);
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      grounding: computeGroundingSupport(candidate.entry, groundingTokens),
    }))
    .sort((left, right) => {
      const scoreGap = Math.abs(left.candidate.score - right.candidate.score);
      if (scoreGap > GROUNDING_SORT_MAX_SCORE_GAP || hasStructuralScoreShaping(left.candidate) || hasStructuralScoreShaping(right.candidate)) {
        if (left.candidate.score !== right.candidate.score) {
          return right.candidate.score - left.candidate.score;
        }

        return left.index - right.index;
      }

      if (left.grounding.phraseMatches !== right.grounding.phraseMatches) {
        return right.grounding.phraseMatches - left.grounding.phraseMatches;
      }

      if (left.grounding.coverage !== right.grounding.coverage) {
        return right.grounding.coverage - left.grounding.coverage;
      }

      if (left.candidate.scores.lexical !== right.candidate.scores.lexical) {
        return right.candidate.scores.lexical - left.candidate.scores.lexical;
      }

      if (left.candidate.score !== right.candidate.score) {
        return right.candidate.score - left.candidate.score;
      }

      if (left.candidate.scores.vector !== right.candidate.scores.vector) {
        return right.candidate.scores.vector - left.candidate.scores.vector;
      }

      return left.index - right.index;
    })
    .map(({ candidate }) => candidate);
}

/**
 * Detect whether a candidate already carries a structural rank adjustment that
 * should outrank final query-grounding tie-breaks.
 *
 * Claim-key penalties and historical-lineage boosts are deliberate shaping
 * decisions. The accepted-shortlist grounding sort should not silently undo
 * them just because the query text happens to overlap more strongly.
 *
 * Cross-encoder scores are intentionally excluded here. They participate in
 * the composite score surface, but when two post-rerank candidates remain
 * nearly tied, the final grounding sort may still prefer the more directly
 * phrased answer.
 *
 * @param candidate - Ranked candidate in the accepted shortlist.
 * @returns True when the score already includes structural shaping.
 */
function hasStructuralScoreShaping(candidate: RankedCandidate): boolean {
  return (
    candidate.scores.historicalLineage > 0 ||
    candidate.scores.neighborhoodBoost > 0 ||
    candidate.scores.claimKeyTrustPenalty > 0 ||
    candidate.scores.claimKeyRedundancyPenalty > 0
  );
}

/**
 * Build canonical non-generic grounding tokens for one recall query.
 *
 * @param queryText - Raw recall query text.
 * @returns Unique canonical grounding tokens in query order.
 */
function getGroundingTokens(queryText: string): string[] {
  const seen = new Set<string>();
  const groundingTokens: string[] = [];

  for (const token of tokenize(queryText)) {
    if (WEAK_QUERY_GROUNDING_TOKENS.has(token)) {
      continue;
    }

    const canonical = canonicalizeRecallToken(token);
    if (seen.has(canonical)) {
      continue;
    }

    seen.add(canonical);
    groundingTokens.push(canonical);
  }

  return groundingTokens;
}

/**
 * Canonicalize a recall token so light inflection and repo-local shorthand do
 * not hide the same concept from grounding checks.
 *
 * @param token - Raw lexical token.
 * @returns Canonical token used for grounding comparisons.
 */
function canonicalizeRecallToken(token: string): string {
  const normalized = token.normalize("NFKC").toLocaleLowerCase();
  if (normalized === "db" || normalized === "database" || normalized === "databases") {
    return "db";
  }

  if (normalized === "resolve" || normalized === "resolves" || normalized === "resolved" || normalized === "resolving" || normalized === "resolution") {
    return "resolve";
  }

  if (normalized === "branches") {
    return "branch";
  }

  if (normalized === "prefix" || normalized === "prefixes") {
    return "prefix";
  }

  if (normalized.endsWith("ies") && normalized.length > 4) {
    return `${normalized.slice(0, -3)}y`;
  }

  if (normalized.endsWith("es") && normalized.length > 4) {
    return normalized.slice(0, -2);
  }

  if (normalized.endsWith("s") && normalized.length > 3) {
    return normalized.slice(0, -1);
  }

  return normalized;
}

/**
 * Compute lightweight grounding support facts for final shortlist ordering.
 *
 * Phrase matches and coverage are used only as a tie-break inside the bounded
 * accepted shortlist so the returned order prefers the candidate that most
 * directly answers the query without perturbing the underlying score surface.
 *
 * @param entry - Candidate entry in the accepted shortlist.
 * @param groundingTokens - Canonical grounding tokens extracted from the query.
 * @returns Grounding phrase and coverage facts for shortlist sorting.
 */
function computeGroundingSupport(
  entry: RecallCandidateEntry,
  groundingTokens: readonly string[],
): {
  phraseMatches: number;
  coverage: number;
} {
  if (groundingTokens.length === 0) {
    return {
      phraseMatches: 0,
      coverage: 0,
    };
  }

  const subjectTokens = tokenize(entry.subject).map(canonicalizeRecallToken);
  const contentTokens = tokenize(entry.content).map(canonicalizeRecallToken);
  const candidateTokens = new Set([...subjectTokens, ...contentTokens]);
  const matchedTokens = groundingTokens.filter((token) => candidateTokens.has(token));

  return {
    phraseMatches: countCanonicalPhraseMatches(groundingTokens, subjectTokens, contentTokens),
    coverage: matchedTokens.length / groundingTokens.length,
  };
}

/**
 * Count canonical 2+-token grounding phrases found in candidate token order.
 *
 * @param queryTokens - Canonical grounding tokens from the query.
 * @param subjectTokens - Canonicalized subject tokens.
 * @param contentTokens - Canonicalized content tokens.
 * @returns Number of matching canonical grounding phrases.
 */
function countCanonicalPhraseMatches(queryTokens: readonly string[], subjectTokens: readonly string[], contentTokens: readonly string[]): number {
  if (queryTokens.length < 2) {
    return 0;
  }

  const matchedPhrases = new Set<string>();
  for (let size = 2; size <= queryTokens.length; size += 1) {
    for (let index = 0; index + size <= queryTokens.length; index += 1) {
      const phraseTokens = queryTokens.slice(index, index + size);
      if (hasCanonicalConsecutivePhrase(subjectTokens, phraseTokens) || hasCanonicalConsecutivePhrase(contentTokens, phraseTokens)) {
        matchedPhrases.add(phraseTokens.join(" "));
      }
    }
  }

  return matchedPhrases.size;
}

/**
 * Check whether one canonical token phrase appears consecutively in a target.
 *
 * @param haystack - Candidate canonical tokens.
 * @param needle - Canonical phrase tokens to locate.
 * @returns True when the phrase appears consecutively.
 */
function hasCanonicalConsecutivePhrase(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || haystack.length < needle.length) {
    return false;
  }

  for (let index = 0; index + needle.length <= haystack.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return true;
    }
  }

  return false;
}

/**
 * Estimate the prompt token cost of an entry using a simple character heuristic.
 *
 * @param entry - Recall result entry.
 * @returns Approximate token count for the entry payload.
 */
function estimateTokens(entry: RecallCandidateEntry): number {
  return (entry.subject.length + entry.content.length) / 4;
}

/**
 * Parse an explicit around-date value using both strict date parsing and
 * natural-language temporal inference.
 *
 * @param value - Raw user-supplied around-date text.
 * @returns Parsed temporal anchor, or null when unsupported.
 */
function parseAroundDate(value: string): Date | null {
  return parseRelativeDate(value) ?? inferAroundDate(value);
}

/**
 * Normalize user-provided recall limits into a non-negative integer.
 *
 * @param value - Raw limit input.
 * @returns Effective result limit.
 */
function normalizeLimit(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 10;
  }

  return Math.max(0, Math.floor(value));
}

/**
 * Normalize a recall score threshold into the supported 0-1 range.
 *
 * @param value - Raw threshold input.
 * @returns Effective threshold.
 */
function normalizeThreshold(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

/**
 * Normalize a token budget input when one is provided.
 *
 * @param value - Raw budget input.
 * @returns Normalized budget, or null when no budget should apply.
 */
function normalizeBudget(value?: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, value);
}

/**
 * Normalize the gaussian around-date radius into a positive day count.
 *
 * @param value - Raw radius input in days.
 * @returns Effective radius value.
 */
function normalizeAroundRadius(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 14;
  }

  return value;
}

/** Returns a non-negative elapsed millisecond count for one stage. */
function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

/**
 * Candidate shape after vector and FTS admission paths are merged.
 */
interface MergedCandidate {
  entry: RecallCandidateEntry;
  vectorSim?: number;
}

/**
 * Ranked candidate shape before the final full-entry hydration step.
 */
interface RankedCandidate {
  entry: RecallCandidateEntry;
  score: number;
  scores: RecallOutput["scores"];
}
