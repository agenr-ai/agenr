import {
  DEFAULT_SEEDED_RERANK_WEIGHT,
  DEFAULT_STRONG_SEED_SCORE_GAP,
  DEFAULT_STRONG_SEED_TOP_N,
  computeLexicalScore,
  rrfFuseVectorLexical,
  seededRerank,
  selectStrongSeeds,
  sharesProcedureLineage,
} from "../../../core/recall/index.js";

import type { Procedure } from "../../../core/types.js";

import type { ProcedureRecallCandidate, ProcedureRecallDeps, ProcedureRecallInput, ProcedureRecallResult } from "./types.js";

const DEFAULT_LIMIT = 5;
const DEFAULT_CANONICAL_THRESHOLD = 0.55;
const DEFAULT_CANONICAL_MARGIN = 0.08;
const LEXICAL_CANDIDATE_MULTIPLIER = 3;
const VECTOR_CANDIDATE_MULTIPLIER = 4;
const VECTOR_ONLY_CANONICAL_FLOOR = 0.6;
const LEXICAL_ONLY_NOTICE = "Semantic procedure search unavailable - using lexical-only procedure ranking.";
const LEXICAL_ONLY_FALLBACK_NOTICE = "Semantic procedure search failed during procedure recall - using lexical-only procedure ranking.";

/**
 * Merged lexical and vector evidence tracked before final ranking.
 */
interface ProcedureCandidateSignals {
  procedure: Procedure;
  lexical: number;
  vector: number;
}

/**
 * Runs dedicated procedure recall without crossing into unified recall routing.
 *
 * @param input - Procedure recall request.
 * @param deps - Procedure database port plus optional embedding helper.
 * @returns Ranked procedure candidates and one canonical top match when stable.
 */
export async function runProcedureRecall(input: ProcedureRecallInput, deps: ProcedureRecallDeps): Promise<ProcedureRecallResult> {
  const text = input.text.trim();
  const limit = normalizeLimit(input.limit);
  if (text.length === 0 || limit === 0) {
    return {
      candidates: [],
      notices: [],
    };
  }

  const lexicalLimit = limit * LEXICAL_CANDIDATE_MULTIPLIER;
  const vectorLimit = limit * VECTOR_CANDIDATE_MULTIPLIER;
  const notices: string[] = [];

  const lexicalMatches = await deps.db.procedureFtsSearch({
    text,
    limit: lexicalLimit,
  });

  const queryEmbedding = await maybeEmbedQuery(text, deps.embedQuery, notices);
  const vectorMatches =
    queryEmbedding.length > 0
      ? await deps.db
          .procedureVectorSearch({
            embedding: queryEmbedding,
            limit: vectorLimit,
          })
          .catch(() => {
            notices.push(LEXICAL_ONLY_FALLBACK_NOTICE);
            return [];
          })
      : [];

  const ranked = rankProcedureCandidates(text, lexicalMatches, vectorMatches).slice(0, limit);
  const canonicalProcedure = selectCanonicalProcedure(ranked, input.threshold);

  return {
    ...(canonicalProcedure ? { canonicalProcedure } : {}),
    candidates: ranked,
    notices: dedupePreservingOrder(notices),
  };
}

/**
 * Computes a best-effort embedding for one procedure-recall query.
 *
 * @param text - Raw procedure-recall text.
 * @param embedQuery - Optional embedding callback.
 * @param notices - Mutable degraded-mode notice sink.
 * @returns Query embedding, or an empty vector when unavailable.
 */
async function maybeEmbedQuery(text: string, embedQuery: ProcedureRecallDeps["embedQuery"], notices: string[]): Promise<number[]> {
  if (!embedQuery) {
    notices.push(LEXICAL_ONLY_NOTICE);
    return [];
  }

  try {
    const embedding = await embedQuery(text);
    if (embedding.length === 0) {
      notices.push(LEXICAL_ONLY_NOTICE);
      return [];
    }

    return embedding;
  } catch {
    notices.push(LEXICAL_ONLY_FALLBACK_NOTICE);
    return [];
  }
}

/**
 * Merges lexical and vector candidates, then assigns stable ranking scores.
 *
 * @param query - Procedure recall query text.
 * @param lexicalMatches - Lexical candidates from the procedure FTS adapter.
 * @param vectorMatches - Semantic candidates from the vector adapter.
 * @returns Ordered ranked procedure candidates.
 */
function rankProcedureCandidates(
  query: string,
  lexicalMatches: Array<{ procedure: Procedure; rank: number }>,
  vectorMatches: Array<{ procedure: Procedure; vectorSim: number }>,
): ProcedureRecallCandidate[] {
  const merged = new Map<string, ProcedureCandidateSignals>();

  for (const match of lexicalMatches) {
    const lexical = computeProcedureLexicalScore(query, match.procedure);
    merged.set(match.procedure.id, {
      procedure: match.procedure,
      lexical,
      vector: 0,
    });
  }

  for (const match of vectorMatches) {
    const existing = merged.get(match.procedure.id);
    merged.set(match.procedure.id, {
      procedure: match.procedure,
      lexical: existing?.lexical ?? computeProcedureLexicalScore(query, match.procedure),
      vector: Math.max(existing?.vector ?? 0, match.vectorSim),
    });
  }

  // Build each RRF channel from our own per-candidate signal so ties resolve
  // on locally-computed evidence rather than raw BM25 rank quirks. Candidates
  // with zero evidence in a channel are excluded from that channel so they do
  // not accidentally contribute near-top RRF mass there.
  const lexicalRanks = rankByDescending(merged, (signals) => signals.lexical);
  const vectorRanks = rankByDescending(merged, (signals) => signals.vector);

  const relevanceByProcedureId = rrfFuseVectorLexical(vectorRanks, lexicalRanks);

  const ranked = Array.from(merged.values())
    .map((candidate) => {
      const relevance = relevanceByProcedureId.get(candidate.procedure.id) ?? 0;
      return {
        procedure: candidate.procedure,
        score: relevance,
        scores: {
          relevance,
          rrf: relevance,
          lexical: candidate.lexical,
          vector: candidate.vector,
        },
      };
    })
    .filter((candidate) => candidate.score > 0);

  return applySeededProcedureRerank(ranked).sort(compareProcedureCandidates);
}

/**
 * Apply a bounded seeded rerank over procedure candidates by lineage.
 *
 * When multiple rows share one `procedure_key` (rare in the live pipeline
 * but possible across fixture or future revision-surfacing queries), this
 * stage groups them near each other without overturning a clear RRF leader
 * that lives on its own lineage. The added delta is always smaller than
 * the canonical-selection margin so it can never manufacture a canonical
 * answer on its own.
 *
 * @param candidates - Ranked procedure candidates after RRF.
 * @returns Candidates with seeded lineage rerank applied.
 */
function applySeededProcedureRerank(candidates: ProcedureRecallCandidate[]): ProcedureRecallCandidate[] {
  if (candidates.length === 0) {
    return candidates;
  }

  const seeds = selectStrongSeeds(
    candidates.map((candidate) => ({ id: candidate.procedure.id, score: candidate.score, procedure: candidate.procedure })),
    {
      topN: DEFAULT_STRONG_SEED_TOP_N,
      scoreGapFloor: DEFAULT_STRONG_SEED_SCORE_GAP,
    },
  );
  if (seeds.length === 0) {
    return candidates;
  }

  const payloads = candidates.map((candidate) => ({
    id: candidate.procedure.id,
    score: candidate.score,
    procedure: candidate.procedure,
  }));
  const reranked = seededRerank(payloads, seeds, (candidate, seed) => sharesProcedureLineage(candidate.procedure, seed.procedure), {
    weight: DEFAULT_SEEDED_RERANK_WEIGHT,
  });
  const scoreById = new Map(reranked.candidates.map((candidate) => [candidate.id, candidate.score]));
  return candidates.map((candidate) => {
    const nextScore = scoreById.get(candidate.procedure.id);
    if (nextScore === undefined || nextScore === candidate.score) {
      return candidate;
    }

    return {
      ...candidate,
      score: nextScore,
      scores: {
        ...candidate.scores,
        relevance: nextScore,
        rrf: nextScore,
      },
    };
  });
}

/**
 * Computes lexical relevance for one stored procedure.
 *
 * @param query - Procedure recall query.
 * @param procedure - Candidate procedure.
 * @returns Lexical score in the 0-1 range.
 */
function computeProcedureLexicalScore(query: string, procedure: Procedure): number {
  return computeLexicalScore(query, procedure.title, procedure.recall_text);
}

/**
 * Produces one RRF channel by sorting merged candidates on a per-candidate
 * signal and filtering out zeros so they do not count as ranked in that channel.
 *
 * @param merged - Merged lexical and vector evidence keyed by procedure id.
 * @param signalOf - Selector returning the positive signal to rank by.
 * @returns Procedure ids sorted from strongest to weakest signal.
 */
function rankByDescending(merged: Map<string, ProcedureCandidateSignals>, signalOf: (signals: ProcedureCandidateSignals) => number): string[] {
  return Array.from(merged.values())
    .filter((signals) => signalOf(signals) > 0)
    .sort((left, right) => {
      const delta = signalOf(right) - signalOf(left);
      if (delta !== 0) {
        return delta;
      }
      return left.procedure.procedure_key.localeCompare(right.procedure.procedure_key);
    })
    .map((signals) => signals.procedure.id);
}

/**
 * Selects one canonical procedure only when the lead is clearly strong enough.
 *
 * The RRF-derived `score` drives candidate ordering. The canonical-selection
 * margin check uses raw signal strength (`max(vector, lexical)`) so symmetric
 * channel disagreements that produce tied RRF scores can still resolve to one
 * canonical answer when the raw evidence clearly favors the leader.
 *
 * @param ranked - Ranked procedure candidates.
 * @param threshold - Optional caller-specified canonical threshold.
 * @returns Canonical procedure, or undefined when no answer is stable enough.
 */
function selectCanonicalProcedure(ranked: ProcedureRecallCandidate[], threshold: number | undefined): Procedure | undefined {
  const leader = ranked[0];
  if (!leader) {
    return undefined;
  }

  const minimumScore = normalizeThreshold(threshold);
  if (leader.score < minimumScore) {
    return undefined;
  }

  if (leader.scores.lexical === 0 && leader.scores.vector < VECTOR_ONLY_CANONICAL_FLOOR) {
    return undefined;
  }

  const runnerUp = ranked[1];
  if (runnerUp && signalStrength(leader) - signalStrength(runnerUp) < DEFAULT_CANONICAL_MARGIN) {
    return undefined;
  }

  return leader.procedure;
}

/**
 * Compute a canonical-selection signal strength for one procedure candidate.
 *
 * Uses the strongest raw retrieval evidence available (vector similarity or
 * lexical overlap) so canonical selection stays grounded in real retrieval
 * scores even when reciprocal rank fusion produces tied relevance for
 * symmetrically ranked candidates.
 *
 * @param candidate - Ranked procedure candidate.
 * @returns Signal strength in the 0-1 range.
 */
function signalStrength(candidate: ProcedureRecallCandidate): number {
  return Math.max(candidate.scores.vector, candidate.scores.lexical);
}

/**
 * Orders ranked procedure candidates from strongest to weakest deterministically.
 *
 * @param left - Left candidate.
 * @param right - Right candidate.
 * @returns Negative when `left` should sort first.
 */
function compareProcedureCandidates(left: ProcedureRecallCandidate, right: ProcedureRecallCandidate): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }

  if (left.scores.lexical !== right.scores.lexical) {
    return right.scores.lexical - left.scores.lexical;
  }

  if (left.scores.vector !== right.scores.vector) {
    return right.scores.vector - left.scores.vector;
  }

  if (left.procedure.updated_at !== right.procedure.updated_at) {
    return right.procedure.updated_at.localeCompare(left.procedure.updated_at);
  }

  return left.procedure.procedure_key.localeCompare(right.procedure.procedure_key);
}

/**
 * Normalizes one optional result limit into a bounded positive integer.
 *
 * @param value - Optional caller-supplied limit.
 * @returns Positive integer result limit.
 */
function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_LIMIT;
  }

  return Math.max(0, Math.trunc(value));
}

/**
 * Normalizes the canonical procedure threshold.
 *
 * @param value - Optional caller-supplied threshold.
 * @returns Threshold clamped into the inclusive 0-1 range.
 */
function normalizeThreshold(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_CANONICAL_THRESHOLD;
  }

  return Math.min(1, Math.max(0, value));
}

/**
 * Removes duplicate notices while preserving the original order.
 *
 * @param values - Ordered notice list.
 * @returns Stable deduplicated notice list.
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
