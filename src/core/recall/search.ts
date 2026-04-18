import type { RecallPorts } from "../ports.js";
import { resolveClaimSlotPolicy } from "../claim-slot-policy.js";

import { rrfFuse } from "./fusion.js";
import { computeLexicalScore, tokenize } from "./lexical.js";
import { cosineSimilarity, gaussianRecency, importanceScore, recencyScore, scoreCandidate } from "./scoring.js";
import { inferAroundDate, parseRelativeDate } from "./temporal.js";
import {
  createNoopRecallTraceSink,
  type RecallDegradedReason,
  type RecallExecutionOptions,
  type RecallExecutionTraceSummary,
  type RecallNoResultReason,
} from "./trace.js";
import type {
  EntryFilters,
  FtsCandidate,
  HistoricalPredecessorLookupParams,
  RecallCandidateEntry,
  RecallInput,
  RecallOutput,
  RecallRankingProfile,
  VectorCandidate,
} from "./types.js";

const MIN_VECTOR_ONLY_EVIDENCE = 0.3;
const HISTORICAL_STATE_FLAT_RECENCY = 0.5;
const HISTORICAL_PREDECESSOR_BOOST = 0.08;
const HISTORICAL_RETIRED_PREDECESSOR_BOOST = 0.06;
const HISTORICAL_OLDER_STATE_BOOST = 0.08;
const HISTORICAL_TOPIC_SHARED_PREFIX_MIN = 2;
const HISTORICAL_TOPIC_PREFIX_OF_CANDIDATE_MIN = 0.6;
const CLAIM_KEY_TENTATIVE_CURRENT_PENALTY = 0.08;
const CLAIM_KEY_REDUNDANT_TRUSTED_SLOT_PENALTY = 0.05;
const CLAIM_KEY_REDUNDANT_TRUSTED_SLOT_MAX_PENALTY = 0.15;
const QUERY_EMBEDDING_FAILURE_NOTICE = "Embeddings failed during recall, so Agenr fell back to lexical-only entry ranking.";
const VECTOR_SEARCH_FAILURE_NOTICE = "Vector search failed during recall, so Agenr continued with lexical entry candidates only.";

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
    const expansionRanks = await expandHistoricalCandidates(mergeOutcome.merged, queryEmbedding, ports, {
      activeEntryIds: Array.from(mergeOutcome.merged.keys()),
      rankingProfile: query.rankingProfile,
    });
    // Fuse the ordered candidate rank lists from every active retrieval
    // channel into one normalized relevance map. Channels that produced no
    // candidates are ignored so RRF does not dilute the remaining signal.
    const relevanceByEntryId = rrfFuse([mergeOutcome.vectorRanks, mergeOutcome.ftsRanks, expansionRanks]);
    summary.candidateCounts.merged = mergeOutcome.merged.size;
    summary.timings.mergeCandidatesMs = elapsedMs(mergeStartedAt);

    const scoreStartedAt = Date.now();
    const scored = applyClaimKeyResultShaping(
      applyHistoricalLineageBoosts(
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
      ),
      summary.claimKey,
      slotPolicyConfig,
    ).sort((left, right) => right.score - left.score);
    summary.timings.scoreCandidatesMs = elapsedMs(scoreStartedAt);

    const thresholdStartedAt = Date.now();
    const thresholded = scored.filter((result) => hasSufficientReturnEvidence(result) && result.score >= threshold);
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
    const ranked = budgeted.slice(0, limit);
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
      claimKeyTrustPenalty: 0,
      claimKeyRedundancyPenalty: 0,
    },
  };
}

/**
 * Expand the historical-state candidate pool with inactive lineage-linked rows.
 *
 * The returned array is the ordered rank list for the expansion retrieval
 * channel. Predecessors are ranked by cosine similarity against the query so
 * stronger lineage matches dominate the channel contribution during RRF.
 *
 * @param mergedCandidates - Current merged active candidate map.
 * @param queryEmbedding - Query embedding used to compute fallback vector scores.
 * @param ports - Recall ports that may expose historical expansion.
 * @param params - Active candidate IDs plus the active ranking profile.
 * @returns Rank-ordered predecessor IDs for RRF, or an empty list when disabled.
 */
async function expandHistoricalCandidates(
  mergedCandidates: Map<string, MergedCandidate>,
  queryEmbedding: number[],
  ports: RecallPorts,
  params: HistoricalPredecessorLookupParams & { rankingProfile?: RecallRankingProfile },
): Promise<string[]> {
  if (params.rankingProfile !== "historical_state" || mergedCandidates.size === 0 || !ports.fetchPredecessors) {
    return [];
  }

  const predecessors = await ports.fetchPredecessors({
    activeEntryIds: params.activeEntryIds,
  });
  // Collect predecessors with a computed cosine similarity so we can order
  // them into a deterministic rank list feeding the expansion RRF channel.
  const ranked = predecessors
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

  return ranked.map((candidate) => candidate.entry.id);
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
  return candidates.map((candidate) => {
    const decision = resolveHistoricalLineageBonus(candidate.entry, entries, params.aroundDate, slotPolicyConfig);
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
 * @param aroundDate - Optional explicit around-date anchor.
 * @returns Additive historical bonus and any trust-aware suppression facts.
 */
function resolveHistoricalLineageBonus(
  entry: RecallCandidateEntry,
  entries: RecallCandidateEntry[],
  aroundDate: Date | null,
  slotPolicyConfig?: RecallExecutionOptions["slotPolicyConfig"],
): {
  bonus: number;
  tentativeLineageSuppressed: boolean;
} {
  if (entries.some((peer) => peer.id !== entry.id && entry.superseded_by === peer.id)) {
    return {
      bonus: HISTORICAL_PREDECESSOR_BOOST,
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

    return {
      bonus: entry.retired ? HISTORICAL_RETIRED_PREDECESSOR_BOOST : HISTORICAL_OLDER_STATE_BOOST,
      tentativeLineageSuppressed,
    };
  }

  return {
    bonus: 0,
    tentativeLineageSuppressed,
  };
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
function hasSufficientReturnEvidence(candidate: RankedCandidate): boolean {
  if (candidate.scores.lexical > 0) {
    return true;
  }

  return candidate.scores.vector >= MIN_VECTOR_ONLY_EVIDENCE;
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
