import type { UnifiedRecallResult } from "../../../app/recall/index.js";
import {
  RECALL_DEBUG_ARTIFACT_DEFAULT_TOP_K,
  RECALL_DEBUG_ARTIFACT_MAX_TOP_K,
  type RecallDebugArtifactTopCandidate,
  type RecallDebugArtifactV1,
} from "../../../app/debug-artifacts/index.js";

/**
 * Shapes the unified-recall live debug artifact from a tool-time result.
 *
 * The live artifact stays aligned with the eval-seam artifact shape so
 * one replay tool can consume artifacts from either loop. Top-K
 * candidate breakdowns are included only when the sink is configured
 * with the `detailed` event level.
 *
 * @param params - Live recall result, correlation id, and adapter caps.
 * @returns Bounded versioned artifact suitable for JSONL emission.
 */
export function buildLiveRecallDebugArtifact(params: {
  caseId: string;
  query: string;
  result: UnifiedRecallResult;
  eventLevel: "basic" | "detailed";
  maxTopCandidates: number;
}): RecallDebugArtifactV1 {
  const { caseId, query, result, eventLevel, maxTopCandidates } = params;
  const selectedDurableIds = result.durables.map((entry) => entry.durable.id);
  const includeCandidateBreakdown = eventLevel === "detailed";
  const topK = includeCandidateBreakdown ? clampTopK(maxTopCandidates) : 0;
  const reasonsByDurableId = new Map<string, string[]>();
  for (const projected of result.projectedDurables) {
    if (projected.whySurfaced.reasons.length > 0) {
      reasonsByDurableId.set(projected.durableId, [...projected.whySurfaced.reasons]);
    }
  }
  const topCandidates = includeCandidateBreakdown ? buildTopCandidates(result, reasonsByDurableId, topK) : [];

  return {
    schemaVersion: "recall-debug-artifact.v1",
    caseId,
    request: {
      recallPath: "unified",
      query,
    },
    routing: result.routing,
    selectedDurableIds,
    ...(topCandidates.length > 0 ? { topCandidates } : {}),
  };
}

/** Clamps a requested top-K value into the inclusive artifact bounds. */
function clampTopK(requested: number): number {
  if (!Number.isFinite(requested) || !Number.isInteger(requested)) {
    return RECALL_DEBUG_ARTIFACT_DEFAULT_TOP_K;
  }

  if (requested < 1) {
    return 0;
  }

  if (requested > RECALL_DEBUG_ARTIFACT_MAX_TOP_K) {
    return RECALL_DEBUG_ARTIFACT_MAX_TOP_K;
  }

  return requested;
}

/** Shapes the bounded top-K recall candidate breakdown for live emission. */
function buildTopCandidates(result: UnifiedRecallResult, reasonsByDurableId: Map<string, string[]>, topK: number): RecallDebugArtifactTopCandidate[] {
  if (topK < 1) {
    return [];
  }

  return result.durables.slice(0, topK).map((entry) => {
    const reasons = reasonsByDurableId.get(entry.durable.id);
    return {
      id: entry.durable.id,
      score: entry.score,
      lexicalScore: entry.scores.lexical,
      vectorScore: entry.scores.vector,
      recencyScore: entry.scores.recency,
      importanceScore: entry.scores.importance,
      ...(reasons && reasons.length > 0 ? { reasons } : {}),
    };
  });
}
