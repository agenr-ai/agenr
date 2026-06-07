import type { RecallOutput } from "../../../core/recall/types.js";
import type { ClaimCentricRecallDurable } from "../../recall/claim-centric.js";
import type { UnifiedRecallResult } from "../../recall/types.js";
import type { RecallEvalObservedArtifactFacts } from "./collect-diagnostics.js";
import {
  RECALL_DEBUG_ARTIFACT_DEFAULT_TOP_K,
  RECALL_DEBUG_ARTIFACT_MAX_TOP_K,
  type RecallDebugArtifactSnapshot,
  type RecallDebugArtifactTopCandidate,
  type RecallDebugArtifactV1,
  type RecallEvalCaseRequest,
} from "./contracts.js";
import type { RecallEvalSandboxContext } from "./ports.js";

/**
 * Builds the stable, versioned recall replay debug artifact.
 *
 * The artifact is populated from already-observed facts and the final
 * recall results; it never re-runs recall or reaches into raw internals.
 * Any missing trace fields simply collapse to `undefined` so the shape
 * stays stable across degraded-mode cases.
 *
 * @param params - Observed facts and the request/results used to shape the artifact.
 * @returns Bounded artifact suitable for offline replay diagnosis.
 */
export function buildRecallDebugArtifact(params: {
  request: RecallEvalCaseRequest;
  results: RecallOutput[] | UnifiedRecallResult;
  projectedDurables: ClaimCentricRecallDurable[];
  sandbox: RecallEvalSandboxContext;
  observed: RecallEvalObservedArtifactFacts;
}): RecallDebugArtifactV1 {
  const { request, results, projectedDurables, sandbox, observed } = params;
  const recallPath = request.recallPath ?? "core";
  const durableResults: RecallOutput[] = Array.isArray(results) ? results : results.durables;
  const selectedDurableIds = durableResults.map((result) => result.durable.id);
  const topK = resolveTopK(request.options?.topKCandidates);
  const reasonsByDurableId = new Map<string, string[]>();
  for (const entry of projectedDurables) {
    if (entry.whySurfaced.reasons.length > 0) {
      reasonsByDurableId.set(entry.durableId, [...entry.whySurfaced.reasons]);
    }
  }

  const topCandidates = buildTopCandidates(durableResults, reasonsByDurableId, topK);
  const artifact: RecallDebugArtifactV1 = {
    schemaVersion: "recall-debug-artifact.v1",
    caseId: request.caseId,
    ...(sandbox.snapshot ? { snapshot: buildSnapshot(sandbox.snapshot) } : {}),
    request: {
      recallPath,
      query: request.recallRequest.text,
    },
    ...(Array.isArray(results) ? {} : { routing: results.routing }),
    ...(observed.traceObserved ? { candidateCounts: observed.candidateCounts } : {}),
    ...(observed.ranking ? { ranking: observed.ranking } : {}),
    ...(observed.degraded ? { degraded: observed.degraded } : {}),
    selectedDurableIds,
    ...(topCandidates.length > 0 ? { topCandidates } : {}),
  };

  return artifact;
}

/** Shapes the artifact snapshot block from sandbox metadata. */
function buildSnapshot(snapshot: NonNullable<RecallEvalSandboxContext["snapshot"]>): RecallDebugArtifactSnapshot {
  return {
    ...(snapshot.id !== undefined ? { id: snapshot.id } : {}),
    ...(snapshot.label !== undefined ? { label: snapshot.label } : {}),
    dbPathBasename: snapshot.dbPathBasename,
  };
}

/** Clamps a requested top-K into the inclusive artifact bounds. */
function resolveTopK(requested: number | undefined): number {
  if (requested === undefined) {
    return RECALL_DEBUG_ARTIFACT_DEFAULT_TOP_K;
  }

  if (!Number.isFinite(requested) || !Number.isInteger(requested)) {
    return RECALL_DEBUG_ARTIFACT_DEFAULT_TOP_K;
  }

  if (requested < 1) {
    return 1;
  }

  if (requested > RECALL_DEBUG_ARTIFACT_MAX_TOP_K) {
    return RECALL_DEBUG_ARTIFACT_MAX_TOP_K;
  }

  return requested;
}

/** Shapes the compact top-K candidate breakdown from recall outputs. */
function buildTopCandidates(durableResults: RecallOutput[], reasonsByDurableId: Map<string, string[]>, topK: number): RecallDebugArtifactTopCandidate[] {
  const sliced = durableResults.slice(0, topK);
  return sliced.map((result) => {
    const reasons = reasonsByDurableId.get(result.durable.id);
    return {
      id: result.durable.id,
      score: result.score,
      lexicalScore: result.scores.lexical,
      vectorScore: result.scores.vector,
      recencyScore: result.scores.recency,
      importanceScore: result.scores.importance,
      ...(reasons && reasons.length > 0 ? { reasons } : {}),
    };
  });
}
