import type {
  RecallEvalCaseDiagnostics,
  RecallEvalCaseRequest,
  RecallEvalCaseResponse,
  RecallEvalSandboxRequest,
  RecallEvalSandboxResult,
} from "./contracts.js";

/**
 * Executes one recall eval case behind a stable app-layer service seam.
 *
 * Phase 1 intentionally returns a placeholder success envelope only. Later
 * phases will replace the placeholder internals with real sandbox provisioning
 * and real recall execution without changing the route boundary.
 *
 * @param request - Typed recall eval case request from the HTTP adapter.
 * @returns Stable response envelope for the requested recall eval case.
 */
export async function runRecallEvalCase(request: RecallEvalCaseRequest): Promise<RecallEvalCaseResponse> {
  const startedAt = Date.now();
  const includeDiagnostics = request.options?.includeDiagnostics === true || request.options?.includeCandidates === true;

  return {
    status: "ok",
    caseId: request.caseId,
    result: {
      entries: [],
      entryIds: [],
    },
    diagnostics: includeDiagnostics ? buildPlaceholderDiagnostics(request) : undefined,
    timings: request.options?.includeTimings === true ? { totalMs: Math.max(0, Date.now() - startedAt) } : undefined,
    sandbox: buildSandboxResult(request.sandbox),
  };
}

/** Builds the small typed Phase 1 diagnostics payload. */
const buildPlaceholderDiagnostics = (request: RecallEvalCaseRequest): RecallEvalCaseDiagnostics => ({
  execution: {
    mode: "phase1-placeholder",
    memoryPoolCount: request.memoryPool.length,
    requestedDiagnostics: request.options?.includeDiagnostics === true,
    requestedCandidates: request.options?.includeCandidates === true,
  },
});

/** Maps request sandbox controls into the stable response sandbox shape. */
const buildSandboxResult = (sandbox: RecallEvalSandboxRequest | undefined): RecallEvalSandboxResult | undefined => {
  if (!sandbox) {
    return undefined;
  }

  return {
    root: sandbox.root,
    preserved: sandbox.preserve === true,
  };
};
