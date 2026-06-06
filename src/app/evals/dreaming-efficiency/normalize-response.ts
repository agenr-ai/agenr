import type { RecallEvalSandboxContext } from "../recall/ports.js";
import type {
  DreamingEfficiencyEvalCaseError,
  DreamingEfficiencyEvalCaseRequest,
  DreamingEfficiencyEvalCaseResponse,
  DreamingEfficiencyEvalCaseTimings,
} from "./contracts.js";
import type { DreamEfficiencySummary } from "../../../core/dreaming/types.js";

/** Builds the stable success response envelope for a completed dreaming-efficiency eval case. */
export function buildDreamingEfficiencyEvalSuccessResponse(params: {
  request: DreamingEfficiencyEvalCaseRequest;
  efficiency: DreamEfficiencySummary;
  profileInjectionTokenEstimate: number;
  storeOnlyEquivalentTokenEstimate?: number;
  timings?: DreamingEfficiencyEvalCaseTimings;
  sandbox: RecallEvalSandboxContext;
}): DreamingEfficiencyEvalCaseResponse {
  return {
    status: "ok",
    caseId: params.request.caseId,
    efficiency: params.efficiency,
    profileInjectionTokenEstimate: params.profileInjectionTokenEstimate,
    ...(params.storeOnlyEquivalentTokenEstimate !== undefined ? { storeOnlyEquivalentTokenEstimate: params.storeOnlyEquivalentTokenEstimate } : {}),
    ...(params.timings ? { timings: params.timings } : {}),
    sandbox: buildSandboxResult(params.sandbox),
  };
}

/** Builds the stable error response envelope for a failed dreaming-efficiency eval case. */
export function buildDreamingEfficiencyEvalErrorResponse(params: {
  request: DreamingEfficiencyEvalCaseRequest;
  code: DreamingEfficiencyEvalCaseError["code"];
  message: string;
  details?: unknown;
  timings?: DreamingEfficiencyEvalCaseTimings;
  sandbox?: RecallEvalSandboxContext;
}): DreamingEfficiencyEvalCaseResponse {
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

/** Builds sandbox metadata for the response envelope. */
function buildSandboxResult(sandbox: RecallEvalSandboxContext): DreamingEfficiencyEvalCaseResponse["sandbox"] {
  return {
    root: sandbox.root,
    dbPath: sandbox.dbPath,
    preserved: sandbox.preserved,
    ...(sandbox.snapshot ? { snapshot: sandbox.snapshot } : {}),
  };
}
