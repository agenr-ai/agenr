import { projectClaimCentricRecallDurable } from "../../recall/claim-centric.js";
import type { RecallOutput } from "../../../core/recall/types.js";
import type { UnifiedRecallResult } from "../../recall/types.js";
import { buildRecallDebugArtifact } from "./build-debug-artifact.js";
import type { RecallEvalObservedArtifactFacts } from "./collect-diagnostics.js";
import type {
  RecallDebugArtifactV1,
  RecallEvalCaseDiagnostics,
  RecallEvalCaseMetadata,
  RecallEvalCaseRequest,
  RecallEvalCaseResponse,
  RecallEvalCaseTimings,
  RecallEvalClaimFamilyMetadata,
  RecallEvalProjectedDurableMetadata,
  RecallEvalSandboxResult,
} from "./contracts.js";
import type { RecallEvalSandboxContext } from "./ports.js";

/**
 * Builds the stable success response envelope for a completed recall eval case.
 *
 * @param params - Case request, sandbox references, timings, and recall results.
 * @returns Normalized success response aligned to the Phase 2 contract.
 */
export function buildRecallEvalSuccessResponse(params: {
  request: RecallEvalCaseRequest;
  results: RecallOutput[] | UnifiedRecallResult;
  diagnostics?: RecallEvalCaseDiagnostics;
  timings?: RecallEvalCaseTimings;
  sandbox: RecallEvalSandboxContext;
  observedArtifactFacts?: RecallEvalObservedArtifactFacts;
}): RecallEvalCaseResponse {
  const durableResults = Array.isArray(params.results) ? params.results : params.results.durables;
  const projectedDurables = Array.isArray(params.results)
    ? durableResults.map((result) => projectClaimCentricRecallDurable(result, { asOf: params.request.recallRequest.asOf }))
    : params.results.projectedDurables;
  const metadata = buildMetadata(params.request, params.results, projectedDurables);
  const debugArtifact: RecallDebugArtifactV1 | undefined =
    params.request.options?.includeDebugArtifact === true && params.observedArtifactFacts
      ? buildRecallDebugArtifact({
          request: params.request,
          results: params.results,
          projectedDurables,
          sandbox: params.sandbox,
          observed: params.observedArtifactFacts,
        })
      : undefined;

  return {
    status: "ok",
    caseId: params.request.caseId,
    result: {
      durables: durableResults.map((result, index) => ({
        id: result.durable.id,
        subject: result.durable.subject,
        content: result.durable.content,
        type: result.durable.type,
        importance: result.durable.importance,
        expiry: result.durable.expiry,
        tags: result.durable.tags,
        created_at: result.durable.created_at,
        score: result.score,
        scores: result.scores,
        claim: {
          familyKey: projectedDurables[index]?.familyKey ?? `durable:${result.durable.id}`,
          claimKey: projectedDurables[index]?.claimKey,
          slotPolicy: projectedDurables[index]?.slotPolicy ?? "exclusive",
          memoryState: projectedDurables[index]?.memoryState ?? "current",
          claimStatus: projectedDurables[index]?.claimStatus ?? "no_key",
          freshness: projectedDurables[index]?.freshness ?? {
            createdAt: result.durable.created_at,
            isCurrent: true,
            label: `created ${result.durable.created_at} | current state`,
          },
          provenance: projectedDurables[index]?.provenance ?? {},
          whySurfaced: projectedDurables[index]?.whySurfaced ?? {
            summary: `ranked score ${result.score.toFixed(2)}`,
            reasons: [],
          },
        },
      })),
      durableIds: durableResults.map((result) => result.durable.id),
    },
    metadata,
    diagnostics: params.diagnostics,
    timings: params.timings,
    sandbox: buildSandboxResult(params.sandbox),
    ...(debugArtifact ? { debugArtifact } : {}),
  };
}

/**
 * Builds the stable error response envelope for a failed recall eval case.
 *
 * @param params - Case request, stable error payload, and optional sandbox data.
 * @returns Normalized error response aligned to the Phase 2 contract.
 */
export function buildRecallEvalErrorResponse(params: {
  request: RecallEvalCaseRequest;
  code: NonNullable<NonNullable<RecallEvalCaseResponse["error"]>["code"]>;
  message: string;
  details?: unknown;
  diagnostics?: RecallEvalCaseDiagnostics;
  timings?: RecallEvalCaseTimings;
  sandbox?: RecallEvalSandboxContext;
}): RecallEvalCaseResponse {
  return {
    status: "error",
    caseId: params.request.caseId,
    error: {
      code: params.code,
      message: params.message,
      details: params.details,
    },
    diagnostics: params.diagnostics,
    timings: params.timings,
    sandbox: params.sandbox ? buildSandboxResult(params.sandbox) : undefined,
  };
}

/** Maps sandbox execution context into the stable response sandbox shape. */
function buildSandboxResult(sandbox: RecallEvalSandboxContext): RecallEvalSandboxResult {
  return {
    root: sandbox.root,
    dbPath: sandbox.dbPath,
    preserved: sandbox.preserved,
    ...(sandbox.snapshot ? { snapshot: sandbox.snapshot } : {}),
  };
}

/** Builds product-facing metadata for the normalized recall eval response. */
function buildMetadata(
  request: RecallEvalCaseRequest,
  results: RecallOutput[] | UnifiedRecallResult,
  projectedDurables: Array<{
    durableId: string;
    familyKey: string;
    claimKey?: string;
    slotPolicy: RecallEvalProjectedDurableMetadata["slotPolicy"];
    memoryState: RecallEvalProjectedDurableMetadata["memoryState"];
    claimStatus: RecallEvalProjectedDurableMetadata["claimStatus"];
    freshness: RecallEvalProjectedDurableMetadata["freshness"];
    provenance: RecallEvalProjectedDurableMetadata["provenance"];
    whySurfaced: RecallEvalProjectedDurableMetadata["whySurfaced"];
  }>,
): RecallEvalCaseMetadata {
  if (Array.isArray(results)) {
    return {
      path: request.recallPath ?? "core",
      claim: {
        projectedDurables: projectedDurables.map(buildProjectedDurableMetadata),
      },
    };
  }

  return {
    path: "unified",
    claim: {
      projectedDurables: projectedDurables.map(buildProjectedDurableMetadata),
      durableFamilies: results.durableFamilies.map(buildClaimFamilyMetadata),
      transitions: results.claimTransitions,
    },
    unified: {
      routing: results.routing,
      timeWindow: results.timeWindow,
      asOf: results.asOf,
      procedure: results.procedure
        ? {
            id: results.procedure.id,
            procedureKey: results.procedure.procedure_key,
            title: results.procedure.title,
            goal: results.procedure.goal,
          }
        : undefined,
      procedureCandidates: results.procedureCandidates.map((candidate) => ({
        id: candidate.procedure.id,
        procedureKey: candidate.procedure.procedure_key,
        title: candidate.procedure.title,
        score: candidate.score,
        lexicalScore: candidate.scores.lexical,
        vectorScore: candidate.scores.vector,
      })),
      procedureNotices: results.procedureNotices,
      notices: results.notices,
      episodeCount: results.episodes.length,
    },
  };
}

/** Maps one projected claim-centric row into stable response metadata. */
function buildProjectedDurableMetadata(entry: {
  durableId: string;
  familyKey: string;
  claimKey?: string;
  slotPolicy: RecallEvalProjectedDurableMetadata["slotPolicy"];
  memoryState: RecallEvalProjectedDurableMetadata["memoryState"];
  claimStatus: RecallEvalProjectedDurableMetadata["claimStatus"];
  freshness: RecallEvalProjectedDurableMetadata["freshness"];
  provenance: RecallEvalProjectedDurableMetadata["provenance"];
  whySurfaced: RecallEvalProjectedDurableMetadata["whySurfaced"];
}): RecallEvalProjectedDurableMetadata {
  return {
    durableId: entry.durableId,
    familyKey: entry.familyKey,
    claimKey: entry.claimKey,
    slotPolicy: entry.slotPolicy,
    memoryState: entry.memoryState,
    claimStatus: entry.claimStatus,
    freshness: entry.freshness,
    provenance: entry.provenance,
    whySurfaced: entry.whySurfaced,
  };
}

/** Maps one claim family into compact family metadata for eval assertions. */
function buildClaimFamilyMetadata(family: UnifiedRecallResult["durableFamilies"][number]): RecallEvalClaimFamilyMetadata {
  return {
    familyKey: family.familyKey,
    claimKey: family.claimKey,
    slotPolicy: family.slotPolicy,
    subject: family.subject,
    primaryDurableId: family.primary.durableId,
    durables: family.durables.map((durable) => ({
      id: durable.durableId,
      memoryState: durable.memoryState,
      claimStatus: durable.claimStatus,
    })),
  };
}
