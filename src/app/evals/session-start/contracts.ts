import type { SessionStartInput, SessionStartPatchDiagnostics } from "../../session-start/types.js";
import type { RecallEvalFixtureDurable, RecallEvalSandboxRequest, RecallEvalSandboxResult } from "../recall/contracts.js";

/**
 * Optional response-shaping flags for session-start eval cases.
 */
export interface SessionStartEvalCaseOptions {
  /** Include structured session-start diagnostics in the response. */
  includeDiagnostics?: boolean;
  /** Include timing metadata in the response. */
  includeTimings?: boolean;
}

/**
 * Application-layer request contract for a single session-start eval case.
 */
export interface SessionStartEvalCaseRequest {
  /** Stable case identifier supplied by the external eval harness. */
  caseId: string;
  /** Optional human-readable case description. */
  description?: string;
  /** Optional sandbox configuration for the case execution. */
  sandbox?: RecallEvalSandboxRequest;
  /** Explicit memory fixtures to provision for the isolated case. */
  memoryPool: RecallEvalFixtureDurable[];
  /** Session-start input facts forwarded to the real app-layer service. */
  sessionStartInput: SessionStartInput;
  /** Optional response-shaping flags for diagnostics and timings. */
  options?: SessionStartEvalCaseOptions;
}

/**
 * Final shaped output returned from one session-start eval case run.
 */
export interface SessionStartEvalCaseOutput {
  /** Convenience list of ranked durable durable IDs in output order. */
  selectedDurableIds: string[];
  /** Source kind for each selected durable durable id. */
  sourceKindsByDurableId: Record<string, "profile" | "directive" | "core" | "artifact_recall">;
}

/**
 * Timing metadata emitted by the session-start eval seam.
 */
export interface SessionStartEvalCaseTimings {
  /** Total end-to-end elapsed time for the eval case. */
  totalMs?: number;
  /** Time spent creating the isolated sandbox. */
  sandboxSetupMs?: number;
  /** Time spent provisioning exact fixtures into isolated storage. */
  fixtureProvisionMs?: number;
  /** Time spent executing the real session-start selector. */
  sessionStartMs?: number;
}

/**
 * Error payload returned when the session-start eval case fails.
 */
export interface SessionStartEvalCaseError {
  /** Stable error code for the failure mode. */
  code: "sandbox_setup_failed" | "fixture_provision_failed" | "session_start_execution_failed" | "internal_error";
  /** Human-readable failure summary. */
  message: string;
  /** Optional structured detail payload preserved for debugging. */
  details?: unknown;
}

/**
 * Stable response envelope returned by the session-start eval seam.
 */
export interface SessionStartEvalCaseResponse {
  /** Status discriminator for the response envelope. */
  status: "ok" | "error";
  /** Stable case identifier echoed from the request. */
  caseId: string;
  /** Successful selector output when the case ran to completion. */
  output?: SessionStartEvalCaseOutput;
  /** Structured diagnostics emitted by the real session-start service. */
  diagnostics?: SessionStartPatchDiagnostics;
  /** Timing metadata for the isolated eval case. */
  timings?: SessionStartEvalCaseTimings;
  /** Isolated sandbox metadata when the sandbox was created successfully. */
  sandbox?: RecallEvalSandboxResult;
  /** Structured error payload when the case failed. */
  error?: SessionStartEvalCaseError;
}
