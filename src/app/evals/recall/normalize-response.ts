import { projectClaimCentricRecallEntry } from "../../recall/claim-centric.js";
import type { RecallOutput } from "../../../core/recall/types.js";
import type { UnifiedRecallResult } from "../../recall/types.js";
import type {
  RecallEvalCaseDiagnostics,
  RecallEvalCaseMetadata,
  RecallEvalCaseRequest,
  RecallEvalCaseResponse,
  RecallEvalCaseTimings,
  RecallEvalClaimFamilyMetadata,
  RecallEvalProjectedEntryMetadata,
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
}): RecallEvalCaseResponse {
  const entryResults = Array.isArray(params.results) ? params.results : params.results.entries;
  const projectedEntries = Array.isArray(params.results)
    ? entryResults.map((result) => projectClaimCentricRecallEntry(result, { asOf: params.request.recallRequest.asOf }))
    : params.results.projectedEntries;
  const metadata = buildMetadata(params.request, params.results, projectedEntries);

  return {
    status: "ok",
    caseId: params.request.caseId,
    result: {
      entries: entryResults.map((result, index) => ({
        id: result.entry.id,
        subject: result.entry.subject,
        content: result.entry.content,
        type: result.entry.type,
        importance: result.entry.importance,
        expiry: result.entry.expiry,
        tags: result.entry.tags,
        created_at: result.entry.created_at,
        score: result.score,
        scores: result.scores,
        claim: {
          familyKey: projectedEntries[index]?.familyKey ?? `entry:${result.entry.id}`,
          claimKey: projectedEntries[index]?.claimKey,
          slotPolicy: projectedEntries[index]?.slotPolicy ?? "exclusive",
          memoryState: projectedEntries[index]?.memoryState ?? "current",
          claimStatus: projectedEntries[index]?.claimStatus ?? "no_key",
          freshness: projectedEntries[index]?.freshness ?? {
            createdAt: result.entry.created_at,
            isCurrent: true,
            label: `created ${result.entry.created_at} | current state`,
          },
          provenance: projectedEntries[index]?.provenance ?? {},
          whySurfaced: projectedEntries[index]?.whySurfaced ?? {
            summary: `ranked score ${result.score.toFixed(2)}`,
            reasons: [],
          },
        },
      })),
      entryIds: entryResults.map((result) => result.entry.id),
    },
    metadata,
    diagnostics: params.diagnostics,
    timings: params.timings,
    sandbox: buildSandboxResult(params.sandbox),
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
  projectedEntries: Array<{
    entryId: string;
    familyKey: string;
    claimKey?: string;
    slotPolicy: RecallEvalProjectedEntryMetadata["slotPolicy"];
    memoryState: RecallEvalProjectedEntryMetadata["memoryState"];
    claimStatus: RecallEvalProjectedEntryMetadata["claimStatus"];
    freshness: RecallEvalProjectedEntryMetadata["freshness"];
    provenance: RecallEvalProjectedEntryMetadata["provenance"];
    whySurfaced: RecallEvalProjectedEntryMetadata["whySurfaced"];
  }>,
): RecallEvalCaseMetadata {
  if (Array.isArray(results)) {
    return {
      path: request.recallPath ?? "core",
      claim: {
        projectedEntries: projectedEntries.map(buildProjectedEntryMetadata),
      },
    };
  }

  return {
    path: "unified",
    claim: {
      projectedEntries: projectedEntries.map(buildProjectedEntryMetadata),
      entryFamilies: results.entryFamilies.map(buildClaimFamilyMetadata),
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
function buildProjectedEntryMetadata(entry: {
  entryId: string;
  familyKey: string;
  claimKey?: string;
  slotPolicy: RecallEvalProjectedEntryMetadata["slotPolicy"];
  memoryState: RecallEvalProjectedEntryMetadata["memoryState"];
  claimStatus: RecallEvalProjectedEntryMetadata["claimStatus"];
  freshness: RecallEvalProjectedEntryMetadata["freshness"];
  provenance: RecallEvalProjectedEntryMetadata["provenance"];
  whySurfaced: RecallEvalProjectedEntryMetadata["whySurfaced"];
}): RecallEvalProjectedEntryMetadata {
  return {
    entryId: entry.entryId,
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
function buildClaimFamilyMetadata(family: UnifiedRecallResult["entryFamilies"][number]): RecallEvalClaimFamilyMetadata {
  return {
    familyKey: family.familyKey,
    claimKey: family.claimKey,
    slotPolicy: family.slotPolicy,
    subject: family.subject,
    primaryEntryId: family.primary.entryId,
    entries: family.entries.map((entry) => ({
      id: entry.entryId,
      memoryState: entry.memoryState,
      claimStatus: entry.claimStatus,
    })),
  };
}
