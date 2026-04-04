import type { RecallPorts } from "../ports.js";

import { computeLexicalScore, tokenize } from "./lexical.js";
import { cosineSimilarity, gaussianRecency, importanceScore, recencyScore, scoreCandidate } from "./scoring.js";
import { inferAroundDate, parseRelativeDate } from "./temporal.js";
import { createNoopRecallTraceSink, type RecallExecutionOptions, type RecallExecutionTraceSummary, type RecallNoResultReason } from "./trace.js";
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
  const aroundDate = query.around !== undefined ? parseAroundDate(query.around) : inferAroundDate(text);
  const since = query.since ? parseRelativeDate(query.since) : null;
  const until = query.until ? parseRelativeDate(query.until) : null;
  const filters = buildEntryFilters(query.types, query.tags, since, until);
  const trace = options.trace ?? createNoopRecallTraceSink();
  const summary = buildRecallTraceSummary({
    filters,
    limit,
    threshold,
    budget,
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
    const queryEmbedding = await ports.embed(text);

    const [vectorCandidates, ftsCandidates] = await Promise.all([
      ports.vectorSearch({
        embedding: queryEmbedding,
        limit: limit * 4,
        filters,
      }),
      ports.ftsSearch({
        text,
        limit: limit * 2,
        filters,
      }),
    ]);

    const mergeStartedAt = Date.now();
    const mergedCandidates = mergeCandidates(vectorCandidates, ftsCandidates);
    await expandHistoricalCandidates(mergedCandidates, queryEmbedding, ports, {
      activeEntryIds: Array.from(mergedCandidates.keys()),
      rankingProfile: query.rankingProfile,
    });
    summary.candidateCounts.merged = mergedCandidates.size;
    summary.timings.mergeCandidatesMs = elapsedMs(mergeStartedAt);

    const scoreStartedAt = Date.now();
    const scored = applyHistoricalLineageBoosts(
      Array.from(mergedCandidates.values()).map((candidate) =>
        scoreMergedCandidate(candidate, text, queryEmbedding, {
          aroundDate,
          aroundRadius: query.aroundRadius,
          rankingProfile: query.rankingProfile,
        }),
      ),
      {
        aroundDate,
        rankingProfile: query.rankingProfile,
      },
    ).sort((left, right) => right.score - left.score);
    summary.timings.scoreCandidatesMs = elapsedMs(scoreStartedAt);

    const thresholdStartedAt = Date.now();
    const thresholded = scored.filter((result) => hasSufficientReturnEvidence(result) && result.score >= threshold);
    summary.candidateCounts.thresholdQualified = thresholded.length;
    summary.timings.thresholdMs = elapsedMs(thresholdStartedAt);
    if (thresholded.length === 0) {
      reportTrace(scored.length === 0 ? "no_candidates" : "below_threshold");
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
      reportTrace("hydrate_missing");
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
    timings: {
      mergeCandidatesMs: 0,
      scoreCandidatesMs: 0,
      thresholdMs: 0,
      budgetMs: 0,
      shapeResultsMs: 0,
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
 * Score a merged candidate using the v1 recall signal model.
 *
 * @param candidate - Merged candidate data from vector and FTS retrieval.
 * @param queryText - Raw recall query text.
 * @param queryEmbedding - Query embedding vector.
 * @param aroundDate - Optional temporal anchor for gaussian recency scoring.
 * @param aroundRadius - Optional gaussian radius override in days.
 * @returns Ranked candidate with score breakdown metadata.
 */
function scoreMergedCandidate(
  candidate: MergedCandidate,
  queryText: string,
  queryEmbedding: number[],
  params: {
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
    vectorSim: vector,
    lexical,
    recency,
    importance,
  });

  return {
    entry: candidate.entry,
    score: scored.score,
    scores: scored.scores,
  };
}

/**
 * Expand the historical-state candidate pool with inactive lineage-linked rows.
 *
 * @param mergedCandidates - Current merged active candidate map.
 * @param queryEmbedding - Query embedding used to compute fallback vector scores.
 * @param ports - Recall ports that may expose historical expansion.
 * @param params - Active candidate IDs plus the active ranking profile.
 * @returns Promise that resolves after the candidate map has been updated in place.
 */
async function expandHistoricalCandidates(
  mergedCandidates: Map<string, MergedCandidate>,
  queryEmbedding: number[],
  ports: RecallPorts,
  params: HistoricalPredecessorLookupParams & { rankingProfile?: RecallRankingProfile },
): Promise<void> {
  if (params.rankingProfile !== "historical_state" || mergedCandidates.size === 0 || !ports.fetchPredecessors) {
    return;
  }

  const predecessors = await ports.fetchPredecessors({
    activeEntryIds: params.activeEntryIds,
  });
  for (const entry of predecessors) {
    if (mergedCandidates.has(entry.id)) {
      continue;
    }

    mergedCandidates.set(entry.id, {
      entry,
      vectorSim: cosineSimilarity(entry.embedding ?? [], queryEmbedding),
    });
  }
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
    aroundDate: Date | null;
    aroundRadius?: number;
    rankingProfile?: RecallRankingProfile;
  },
): number {
  if (params.aroundDate) {
    return gaussianRecency(entry.created_at, params.aroundDate, normalizeAroundRadius(params.aroundRadius));
  }

  if (params.rankingProfile === "historical_state") {
    return HISTORICAL_STATE_FLAT_RECENCY;
  }

  return recencyScore(entry.created_at, entry.expiry);
}

/**
 * Apply historical-only lineage boosts after the base score is computed.
 *
 * Direct predecessors receive the strongest boost. When explicit lineage is
 * absent, retired same-topic predecessors and older same-topic peers can still
 * get a smaller boost against an active successor candidate.
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
): RankedCandidate[] {
  if (params.rankingProfile !== "historical_state") {
    return candidates;
  }

  const entries = candidates.map((candidate) => candidate.entry);
  return candidates.map((candidate) => {
    const bonus = resolveHistoricalLineageBonus(candidate.entry, entries, params.aroundDate);
    if (bonus <= 0) {
      return candidate;
    }

    return {
      ...candidate,
      score: Math.min(1, candidate.score + bonus),
    };
  });
}

/**
 * Resolve the lineage-relative historical bonus for one candidate.
 *
 * @param entry - Candidate being evaluated.
 * @param entries - All candidate entries currently in the result set.
 * @param aroundDate - Optional explicit around-date anchor.
 * @returns Additive historical bonus on the 0-1 scale.
 */
function resolveHistoricalLineageBonus(entry: RecallCandidateEntry, entries: RecallCandidateEntry[], aroundDate: Date | null): number {
  if (entries.some((peer) => peer.id !== entry.id && entry.superseded_by === peer.id)) {
    return HISTORICAL_PREDECESSOR_BOOST;
  }

  if (aroundDate) {
    return 0;
  }

  const activePeers = entries.filter((peer) => peer.id !== entry.id && isPotentialCurrentPeer(peer) && isOlderSameTopicPeer(entry, peer));
  if (activePeers.length === 0) {
    return 0;
  }

  return entry.retired ? HISTORICAL_RETIRED_PREDECESSOR_BOOST : HISTORICAL_OLDER_STATE_BOOST;
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
 * Check whether the left candidate is an older same-topic peer of the right one.
 *
 * @param left - Potential prior-state candidate.
 * @param right - Potential current-state peer.
 * @returns True when the pair looks like a historical state transition.
 */
function isOlderSameTopicPeer(left: RecallCandidateEntry, right: RecallCandidateEntry): boolean {
  return createdAtMs(left.created_at) < createdAtMs(right.created_at) && sharesHistoricalTopic(left, right);
}

/**
 * Compare two candidate subjects for same-topic historical lineage.
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
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
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
 * Merge vector and FTS candidate sets into a unique entry-id keyed map.
 *
 * Vector similarity is preserved when an entry appears in both retrieval paths.
 *
 * @param vectorCandidates - Candidates admitted by vector similarity search.
 * @param ftsCandidates - Candidates admitted by lexical FTS search.
 * @returns Unique candidate map keyed by entry ID.
 */
function mergeCandidates(vectorCandidates: VectorCandidate[], ftsCandidates: FtsCandidate[]): Map<string, MergedCandidate> {
  const merged = new Map<string, MergedCandidate>();

  for (const candidate of vectorCandidates) {
    merged.set(candidate.entry.id, {
      entry: candidate.entry,
      vectorSim: candidate.vectorSim,
    });
  }

  for (const candidate of ftsCandidates) {
    const existing = merged.get(candidate.entry.id);
    if (existing) {
      existing.entry = existing.entry.embedding ? existing.entry : candidate.entry;
      continue;
    }

    merged.set(candidate.entry.id, {
      entry: candidate.entry,
    });
  }

  return merged;
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
  if (!Number.isFinite(value)) {
    return 10;
  }

  return Math.max(0, Math.floor(value ?? 10));
}

/**
 * Normalize a recall score threshold into the supported 0-1 range.
 *
 * @param value - Raw threshold input.
 * @returns Effective threshold.
 */
function normalizeThreshold(value?: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value ?? 0));
}

/**
 * Normalize a token budget input when one is provided.
 *
 * @param value - Raw budget input.
 * @returns Normalized budget, or null when no budget should apply.
 */
function normalizeBudget(value?: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, value ?? 0);
}

/**
 * Normalize the gaussian around-date radius into a positive day count.
 *
 * @param value - Raw radius input in days.
 * @returns Effective radius value.
 */
function normalizeAroundRadius(value?: number): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
    return 14;
  }

  return value!;
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
