import type { SessionStartPatch } from "../../session-start/types.js";
import type { RecallEvalSandboxContext } from "../recall/ports.js";
import type {
  SessionStartEvalCaseOutput,
  SessionStartEvalCaseRequest,
  SessionStartEvalCaseResponse,
  SessionStartEvalCaseTimings,
  SessionStartEvalCaseError,
} from "./contracts.js";

/** Builds the stable success response envelope for a completed session-start eval case. */
export function buildSessionStartEvalSuccessResponse(params: {
  request: SessionStartEvalCaseRequest;
  patch: SessionStartPatch;
  timings?: SessionStartEvalCaseTimings;
  sandbox: RecallEvalSandboxContext;
}): SessionStartEvalCaseResponse {
  return {
    status: "ok",
    caseId: params.request.caseId,
    output: buildOutput(params.patch),
    ...(params.request.options?.includeDiagnostics === true ? { diagnostics: params.patch.diagnostics } : {}),
    ...(params.timings ? { timings: params.timings } : {}),
    sandbox: buildSandboxResult(params.sandbox),
  };
}

/** Builds the stable error response envelope for a failed session-start eval case. */
export function buildSessionStartEvalErrorResponse(params: {
  request: SessionStartEvalCaseRequest;
  code: SessionStartEvalCaseError["code"];
  message: string;
  details?: unknown;
  timings?: SessionStartEvalCaseTimings;
  sandbox?: RecallEvalSandboxContext;
}): SessionStartEvalCaseResponse {
  return {
    status: "error",
    caseId: params.request.caseId,
    error: {
      code: params.code,
      message: params.message,
      ...(params.details !== undefined ? { details: params.details } : {}),
    },
    ...(params.timings ? { timings: params.timings } : {}),
    ...(params.sandbox ? { sandbox: buildSandboxResult(params.sandbox) } : {}),
  };
}

/** Builds the product-facing session-start output payload. */
function buildOutput(patch: SessionStartPatch): SessionStartEvalCaseOutput {
  const sourceKindsByDurableId: SessionStartEvalCaseOutput["sourceKindsByDurableId"] = {};
  for (const item of patch.durableMemory) {
    sourceKindsByDurableId[item.durable.id] = item.sourceKind;
  }

  return {
    selectedDurableIds: patch.durableMemory.map((item) => item.durable.id),
    sourceKindsByDurableId,
  };
}

/** Builds sandbox metadata for the response envelope. */
function buildSandboxResult(sandbox: RecallEvalSandboxContext): SessionStartEvalCaseResponse["sandbox"] {
  return {
    root: sandbox.root,
    dbPath: sandbox.dbPath,
    preserved: sandbox.preserved,
    ...(sandbox.snapshot ? { snapshot: sandbox.snapshot } : {}),
  };
}
