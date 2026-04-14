import { formatAgenrBeforeTurnRecall } from "../../../adapters/openclaw/format/before-turn-format.js";
import type { BeforeTurnPatch } from "../../before-turn/index.js";
import type { RecallEvalSandboxContext } from "../recall/ports.js";
import type { BeforeTurnEvalCaseOutput, BeforeTurnEvalCaseRequest, BeforeTurnEvalCaseResponse, BeforeTurnEvalCaseTimings } from "./contracts.js";

/**
 * Builds the stable success response envelope for a completed before-turn eval case.
 *
 * @param params - Case request, sandbox references, timings, and before-turn patch.
 * @returns Normalized success response for the isolated before-turn seam.
 */
export function buildBeforeTurnEvalSuccessResponse(params: {
  request: BeforeTurnEvalCaseRequest;
  patch: BeforeTurnPatch;
  timings?: BeforeTurnEvalCaseTimings;
  sandbox: RecallEvalSandboxContext;
  renderedPatchText?: string;
}): BeforeTurnEvalCaseResponse {
  const output = buildOutput(params.patch, params.renderedPatchText);

  return {
    status: "ok",
    caseId: params.request.caseId,
    output,
    diagnostics: params.request.options?.includeDiagnostics === true ? params.patch.diagnostics : undefined,
    timings: params.timings,
    sandbox: buildSandboxResult(params.sandbox),
  };
}

/**
 * Builds the stable error response envelope for a failed before-turn eval case.
 *
 * @param params - Case request, stable error payload, and optional sandbox data.
 * @returns Normalized error response for the isolated before-turn seam.
 */
export function buildBeforeTurnEvalErrorResponse(params: {
  request: BeforeTurnEvalCaseRequest;
  code: NonNullable<NonNullable<BeforeTurnEvalCaseResponse["error"]>["code"]>;
  message: string;
  details?: unknown;
  timings?: BeforeTurnEvalCaseTimings;
  sandbox?: RecallEvalSandboxContext;
}): BeforeTurnEvalCaseResponse {
  return {
    status: "error",
    caseId: params.request.caseId,
    error: {
      code: params.code,
      message: params.message,
      details: params.details,
    },
    timings: params.timings,
    sandbox: params.sandbox ? buildSandboxResult(params.sandbox) : undefined,
  };
}

/**
 * Renders the patch only when the caller explicitly requested prompt text.
 *
 * @param request - Before-turn eval request controls.
 * @param patch - Structured before-turn patch returned by the real service.
 * @returns Rendered prompt text when requested, otherwise undefined.
 */
export function maybeRenderBeforeTurnPatch(request: BeforeTurnEvalCaseRequest, patch: BeforeTurnPatch): string | undefined {
  if (request.options?.includeRenderedPatch !== true) {
    return undefined;
  }

  return formatAgenrBeforeTurnRecall(patch);
}

/** Maps sandbox execution context into the stable response sandbox shape. */
function buildSandboxResult(sandbox: RecallEvalSandboxContext): BeforeTurnEvalCaseResponse["sandbox"] {
  return {
    root: sandbox.root,
    dbPath: sandbox.dbPath,
    preserved: sandbox.preserved,
  };
}

/** Builds the product-facing before-turn output payload. */
function buildOutput(patch: BeforeTurnPatch, renderedPatchText: string | undefined): BeforeTurnEvalCaseOutput {
  return {
    abstained: patch.diagnostics.abstained,
    selectedEntryIds: patch.durableMemory.map((item) => item.entry.id),
    selectedProcedureKey: patch.procedure?.procedure.procedure_key ?? null,
    patch,
    ...(renderedPatchText !== undefined ? { renderedPatchText } : {}),
  };
}
