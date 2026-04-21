import type { BeforeTurnPatch } from "../../../app/before-turn/index.js";
import {
  BEFORE_TURN_DEBUG_ARTIFACT_DEFAULT_TOP_K,
  BEFORE_TURN_DEBUG_ARTIFACT_MAX_TOP_K,
  type BeforeTurnDebugArtifactDurableCandidate,
  type BeforeTurnDebugArtifactProcedureCandidate,
  type BeforeTurnDebugArtifactV1,
} from "../../../app/debug-artifacts/index.js";

/**
 * Shapes the before-turn live debug artifact from a structured patch.
 *
 * Mirrors the eval seam's artifact builder but targets live OpenClaw
 * paths where no eval case identifier or sandbox context exists.
 *
 * @param params - Live patch, correlation id, and adapter caps.
 * @returns Bounded versioned artifact suitable for JSONL emission.
 */
export function buildLiveBeforeTurnDebugArtifact(params: {
  caseId: string;
  patch: BeforeTurnPatch;
  currentTurnText: string;
  trigger: string | undefined;
  eventLevel: "basic" | "detailed";
  maxTopCandidates: number;
}): BeforeTurnDebugArtifactV1 {
  const { caseId, patch, currentTurnText, trigger, eventLevel, maxTopCandidates } = params;
  const diagnostics = patch.diagnostics;
  const includeCandidateBreakdown = eventLevel === "detailed";
  const topK = includeCandidateBreakdown ? clampTopK(maxTopCandidates) : 0;
  const durableTopCandidates = includeCandidateBreakdown ? buildDurableCandidates(patch, topK) : [];
  const procedureTopCandidates = includeCandidateBreakdown ? buildProcedureCandidates(patch, topK) : [];
  const normalizedTrigger = trigger?.trim() || "unspecified";

  return {
    schemaVersion: "before-turn-debug-artifact.v1",
    caseId,
    input: {
      trigger: normalizedTrigger,
      currentTurnText,
    },
    ...(diagnostics.queryPolicy ? { queryPolicy: diagnostics.queryPolicy } : {}),
    ...(diagnostics.queryVariants.length > 0 ? { queryVariants: [...diagnostics.queryVariants] } : {}),
    ...(diagnostics.abstentionReasons.length > 0 ? { abstentionReasons: [...diagnostics.abstentionReasons] } : {}),
    selectedEntryIds: patch.durableMemory.map((item) => item.entry.id),
    selectedProcedureKey: patch.procedure?.procedure.procedure_key ?? null,
    ...(durableTopCandidates.length > 0 ? { durableRecallTopCandidates: durableTopCandidates } : {}),
    ...(procedureTopCandidates.length > 0 ? { procedureTopCandidates: procedureTopCandidates } : {}),
  };
}

/**
 * Clamps a requested top-K value into the inclusive artifact bounds.
 *
 * @param requested - Adapter-provided top-K hint.
 * @returns Bounded top-K value applied to candidate breakdowns.
 */
function clampTopK(requested: number): number {
  if (!Number.isFinite(requested) || !Number.isInteger(requested)) {
    return BEFORE_TURN_DEBUG_ARTIFACT_DEFAULT_TOP_K;
  }

  if (requested < 1) {
    return 0;
  }

  if (requested > BEFORE_TURN_DEBUG_ARTIFACT_MAX_TOP_K) {
    return BEFORE_TURN_DEBUG_ARTIFACT_MAX_TOP_K;
  }

  return requested;
}

/** Shapes the durable-recall top-K candidate breakdown for live emission. */
function buildDurableCandidates(patch: BeforeTurnPatch, topK: number): BeforeTurnDebugArtifactDurableCandidate[] {
  if (topK < 1) {
    return [];
  }

  return patch.durableMemory.slice(0, topK).map((item) => {
    const reasons = item.whySurfaced.reasons.length > 0 ? [...item.whySurfaced.reasons] : undefined;
    return {
      id: item.entry.id,
      score: item.score,
      ...(reasons ? { reasons } : {}),
    };
  });
}

/** Shapes the procedure top-K candidate breakdown for live emission. */
function buildProcedureCandidates(patch: BeforeTurnPatch, topK: number): BeforeTurnDebugArtifactProcedureCandidate[] {
  if (!patch.procedure || topK < 1) {
    return [];
  }

  const reasons = patch.procedure.whySurfaced.reasons.length > 0 ? [...patch.procedure.whySurfaced.reasons] : undefined;
  return [
    {
      procedureKey: patch.procedure.procedure.procedure_key,
      score: patch.procedure.score,
      ...(reasons ? { reasons } : {}),
    },
  ];
}
