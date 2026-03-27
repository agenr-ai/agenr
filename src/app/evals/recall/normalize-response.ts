import type { RecallOutput } from "../../../core/recall/types.js";
import type { RecallEvalCaseRequest, RecallEvalCaseResponse, RecallEvalSandboxResult } from "./contracts.js";
import type { RecallEvalSandboxContext } from "./sandbox.js";

/**
 * Builds the stable success response envelope for a completed recall eval case.
 *
 * @param params - Case request, sandbox references, timings, and recall results.
 * @returns Normalized success response aligned to the Phase 2 contract.
 */
export function buildRecallEvalSuccessResponse(params: {
  request: RecallEvalCaseRequest;
  results: RecallOutput[];
  provisionedCount: number;
  totalMs: number;
  sandbox: RecallEvalSandboxContext;
}): RecallEvalCaseResponse {
  return {
    status: "ok",
    caseId: params.request.caseId,
    result: {
      entries: params.results.map((result) => ({
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
      })),
      entryIds: params.results.map((result) => result.entry.id),
    },
    diagnostics: shouldIncludeDiagnostics(params.request)
      ? {
          execution: {
            mode: "isolated-case",
            provisioning: "exact-fixture-seed",
            memoryPoolCount: params.request.memoryPool.length,
            provisionedCount: params.provisionedCount,
            requestedDiagnostics: params.request.options?.includeDiagnostics === true,
            requestedCandidates: params.request.options?.includeCandidates === true,
          },
        }
      : undefined,
    timings: params.request.options?.includeTimings === true ? { totalMs: params.totalMs } : undefined,
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
  totalMs: number;
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
    timings: params.request.options?.includeTimings === true ? { totalMs: params.totalMs } : undefined,
    sandbox: params.sandbox ? buildSandboxResult(params.sandbox) : undefined,
  };
}

/** Returns true when the caller requested diagnostics in the response. */
function shouldIncludeDiagnostics(request: RecallEvalCaseRequest): boolean {
  return request.options?.includeDiagnostics === true || request.options?.includeCandidates === true;
}

/** Maps sandbox execution context into the stable response sandbox shape. */
function buildSandboxResult(sandbox: RecallEvalSandboxContext): RecallEvalSandboxResult {
  return {
    root: sandbox.root,
    dbPath: sandbox.dbPath,
    preserved: sandbox.preserved,
  };
}
