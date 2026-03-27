import type { RecallPorts } from "../ports.js";

import { computeLexicalScore } from "./lexical.js";
import { cosineSimilarity, gaussianRecency, importanceScore, recencyScore, scoreCandidate } from "./scoring.js";
import { inferAroundDate, parseRelativeDate } from "./temporal.js";
import type { EntryFilters, FtsCandidate, RecallCandidateEntry, RecallInput, RecallOutput, VectorCandidate } from "./types.js";

/**
 * Execute the v1 recall pipeline against the provided adapter ports.
 *
 * @param query - Recall query and optional filters.
 * @param ports - Adapter implementations for embedding, retrieval, and event recording.
 * @returns Ranked recall results with score breakdowns.
 */
export async function recall(query: RecallInput, ports: RecallPorts): Promise<RecallOutput[]> {
  const text = query.text.trim();
  if (text.length === 0) {
    return [];
  }

  const limit = normalizeLimit(query.limit);
  if (limit === 0) {
    return [];
  }

  const threshold = normalizeThreshold(query.threshold);
  const budget = normalizeBudget(query.budget);
  const aroundDate = query.around !== undefined ? parseAroundDate(query.around) : inferAroundDate(text);
  const since = query.since ? parseRelativeDate(query.since) : null;
  const until = query.until ? parseRelativeDate(query.until) : null;
  const filters = buildEntryFilters(query.types, query.tags, since, until);
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

  const scored = Array.from(mergeCandidates(vectorCandidates, ftsCandidates).values())
    .map((candidate) => scoreMergedCandidate(candidate, text, queryEmbedding, aroundDate, query.aroundRadius))
    .sort((left, right) => right.score - left.score);

  const thresholded = scored.filter((result) => result.score >= threshold);
  if (thresholded.length === 0) {
    return [];
  }

  const budgeted = budget === null ? thresholded : applyBudget(thresholded, budget);
  const ranked = budgeted.slice(0, limit);
  if (ranked.length === 0) {
    return [];
  }

  const hydratedEntries = await ports.hydrateEntries(ranked.map((result) => result.entry.id));
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

  if (results.length > 0) {
    await ports
      .recordRecallEvents({
        entryIds: results.map((result) => result.entry.id),
        query: text,
        sessionKey: query.sessionKey,
      })
      .catch(() => undefined);
  }

  return results;
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
  aroundDate: Date | null,
  aroundRadius?: number,
): RankedCandidate {
  const vector = candidate.vectorSim ?? cosineSimilarity(candidate.entry.embedding ?? [], queryEmbedding);
  const lexical = computeLexicalScore(queryText, candidate.entry.subject, candidate.entry.content);
  const recency = aroundDate
    ? gaussianRecency(candidate.entry.created_at, aroundDate, normalizeAroundRadius(aroundRadius))
    : recencyScore(candidate.entry.created_at, candidate.entry.expiry);
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
