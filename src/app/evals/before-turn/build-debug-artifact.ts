import type { BeforeTurnPatch } from "../../before-turn/index.js";
import type { RecallEvalSandboxContext } from "../recall/ports.js";
import {
  BEFORE_TURN_DEBUG_ARTIFACT_DEFAULT_TOP_K,
  BEFORE_TURN_DEBUG_ARTIFACT_MAX_TOP_K,
  type BeforeTurnDebugArtifactDurableCandidate,
  type BeforeTurnDebugArtifactProcedureCandidate,
  type BeforeTurnDebugArtifactSnapshot,
  type BeforeTurnDebugArtifactV1,
  type BeforeTurnEvalCaseRequest,
} from "./contracts.js";

/**
 * Builds the stable, versioned before-turn replay debug artifact.
 *
 * The artifact is populated from the before-turn patch and its
 * diagnostics; it never re-runs selection or reaches into raw internal
 * fields. Any absent diagnostic collapses to `undefined` so the shape
 * stays stable across abstained and degraded cases.
 *
 * @param params - Request, patch, and sandbox used to shape the artifact.
 * @returns Bounded artifact suitable for offline replay diagnosis.
 */
export function buildBeforeTurnDebugArtifact(params: {
  request: BeforeTurnEvalCaseRequest;
  patch: BeforeTurnPatch;
  sandbox: RecallEvalSandboxContext;
}): BeforeTurnDebugArtifactV1 {
  const { request, patch, sandbox } = params;
  const diagnostics = patch.diagnostics;
  const topK = resolveTopK(request.options?.topKCandidates);
  const durableTopCandidates = buildDurableCandidates(patch, topK);
  const procedureTopCandidates = buildProcedureCandidates(patch, topK);
  const trigger = request.beforeTurnInput.trigger ?? "unspecified";

  return {
    schemaVersion: "before-turn-debug-artifact.v1",
    caseId: request.caseId,
    ...(sandbox.snapshot ? { snapshot: buildSnapshot(sandbox.snapshot) } : {}),
    input: {
      trigger,
      currentTurnText: request.beforeTurnInput.currentTurnText,
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

/** Shapes the artifact snapshot block from sandbox metadata. */
function buildSnapshot(snapshot: NonNullable<RecallEvalSandboxContext["snapshot"]>): BeforeTurnDebugArtifactSnapshot {
  return {
    ...(snapshot.id !== undefined ? { id: snapshot.id } : {}),
    ...(snapshot.label !== undefined ? { label: snapshot.label } : {}),
    dbPathBasename: snapshot.dbPathBasename,
  };
}

/** Clamps a requested top-K into the inclusive artifact bounds. */
function resolveTopK(requested: number | undefined): number {
  if (requested === undefined) {
    return BEFORE_TURN_DEBUG_ARTIFACT_DEFAULT_TOP_K;
  }

  if (!Number.isFinite(requested) || !Number.isInteger(requested)) {
    return BEFORE_TURN_DEBUG_ARTIFACT_DEFAULT_TOP_K;
  }

  if (requested < 1) {
    return 1;
  }

  if (requested > BEFORE_TURN_DEBUG_ARTIFACT_MAX_TOP_K) {
    return BEFORE_TURN_DEBUG_ARTIFACT_MAX_TOP_K;
  }

  return requested;
}

/** Shapes the durable-recall top-K candidate breakdown. */
function buildDurableCandidates(patch: BeforeTurnPatch, topK: number): BeforeTurnDebugArtifactDurableCandidate[] {
  return patch.durableMemory.slice(0, topK).map((item) => {
    const reasons = item.whySurfaced.reasons.length > 0 ? [...item.whySurfaced.reasons] : undefined;
    return {
      id: item.entry.id,
      score: item.score,
      ...(reasons ? { reasons } : {}),
    };
  });
}

/** Shapes the procedure top-K candidate breakdown. */
function buildProcedureCandidates(patch: BeforeTurnPatch, topK: number): BeforeTurnDebugArtifactProcedureCandidate[] {
  if (!patch.procedure) {
    return [];
  }

  if (topK < 1) {
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
