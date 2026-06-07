import type { BeforeTurnInput, BeforeTurnPatch, BeforeTurnPatchDiagnostics } from "../../before-turn/index.js";
import {
  BEFORE_TURN_DEBUG_ARTIFACT_DEFAULT_TOP_K,
  BEFORE_TURN_DEBUG_ARTIFACT_MAX_TOP_K,
  type BeforeTurnDebugArtifactDurableCandidate,
  type BeforeTurnDebugArtifactInputSummary,
  type BeforeTurnDebugArtifactProcedureCandidate,
  type BeforeTurnDebugArtifactSchemaVersion,
  type BeforeTurnDebugArtifactSnapshot,
  type BeforeTurnDebugArtifactV1,
} from "../../debug-artifacts/index.js";
import type { RecallEvalFixtureDurable, RecallEvalFixtureProcedure, RecallEvalSandboxRequest, RecallEvalSandboxResult } from "../recall/contracts.js";

export {
  BEFORE_TURN_DEBUG_ARTIFACT_DEFAULT_TOP_K,
  BEFORE_TURN_DEBUG_ARTIFACT_MAX_TOP_K,
  type BeforeTurnDebugArtifactDurableCandidate,
  type BeforeTurnDebugArtifactInputSummary,
  type BeforeTurnDebugArtifactProcedureCandidate,
  type BeforeTurnDebugArtifactSchemaVersion,
  type BeforeTurnDebugArtifactSnapshot,
  type BeforeTurnDebugArtifactV1,
};

/**
 * Optional output controls for the before-turn eval execution seam.
 */
export interface BeforeTurnEvalCaseOptions {
  /** Include structured before-turn diagnostics in the response. */
  includeDiagnostics?: boolean;
  /** Include rendered prompt text derived from the returned patch. */
  includeRenderedPatch?: boolean;
  /** Include timing metadata in the response. */
  includeTimings?: boolean;
  /**
   * Include a bounded, versioned debug artifact in the response. The
   * artifact is opt-in and disabled by default. When true the response
   * includes `debugArtifact` with stable turn, query-policy,
   * abstention, and top-K candidate facts sufficient to diagnose a
   * failing replay case without re-running it.
   */
  includeDebugArtifact?: boolean;
  /**
   * Optional top-K override for the debug-artifact candidate breakdown.
   * Clamped into the inclusive range
   * `[1, BEFORE_TURN_DEBUG_ARTIFACT_MAX_TOP_K]`. Defaults to
   * `BEFORE_TURN_DEBUG_ARTIFACT_DEFAULT_TOP_K` so payloads stay
   * predictable across cases.
   */
  topKCandidates?: number;
}

/**
 * Application-layer request contract for a single before-turn eval case.
 */
export interface BeforeTurnEvalCaseRequest {
  /** Stable case identifier supplied by the external eval harness. */
  caseId: string;
  /** Optional human-readable case description. */
  description?: string;
  /** Optional sandbox configuration for the case execution. */
  sandbox?: RecallEvalSandboxRequest;
  /** Explicit memory fixtures to provision for the isolated case. */
  memoryPool: RecallEvalFixtureDurable[];
  /** Optional procedure fixtures to provision for procedure-aware cases. */
  procedurePool?: RecallEvalFixtureProcedure[];
  /** Before-turn input facts forwarded to the real app-layer selector. */
  beforeTurnInput: BeforeTurnInput;
  /** Optional response-shaping flags for diagnostics and timings. */
  options?: BeforeTurnEvalCaseOptions;
}

/**
 * Final shaped output returned from one before-turn eval case run.
 */
export interface BeforeTurnEvalCaseOutput {
  /** Whether the before-turn selector abstained from surfacing any patch content. */
  abstained: boolean;
  /** Convenience list of ranked durable durable IDs in output order. */
  selectedDurableIds: string[];
  /** Selected canonical procedure key when one surfaced, otherwise null. */
  selectedProcedureKey: string | null;
  /** Structured patch returned by the real app-layer before-turn service. */
  patch: BeforeTurnPatch;
  /** Optional rendered prompt text derived from the structured patch. */
  renderedPatchText?: string;
}

/**
 * Stable before-turn diagnostics surfaced through the eval seam when requested.
 *
 * This mirrors the app-layer before-turn diagnostics and includes query-policy,
 * attempted query variants, directness decisions, and typed abstention reasons.
 */
export type BeforeTurnEvalCaseDiagnostics = BeforeTurnPatchDiagnostics;

/**
 * Timing metadata emitted by the before-turn eval seam.
 */
export interface BeforeTurnEvalCaseTimings {
  /** Total end-to-end elapsed time for the eval case. */
  totalMs?: number;
  /** Time spent creating the isolated sandbox. */
  sandboxSetupMs?: number;
  /** Time spent provisioning exact fixtures into isolated storage. */
  fixtureProvisionMs?: number;
  /** Time spent executing the real before-turn selector. */
  beforeTurnMs?: number;
  /** Time spent formatting the returned patch for prompt injection. */
  renderPatchMs?: number;
}

/**
 * Error payload returned when the before-turn eval case fails.
 */
export interface BeforeTurnEvalCaseError {
  /** Stable error code for the failure mode. */
  code: "sandbox_setup_failed" | "fixture_provision_failed" | "before_turn_execution_failed" | "internal_error";
  /** Human-readable failure summary. */
  message: string;
  /** Optional structured detail payload preserved for debugging. */
  details?: unknown;
}

/**
 * Stable response envelope returned by the before-turn eval seam.
 */
export interface BeforeTurnEvalCaseResponse {
  /** Status discriminator for the response envelope. */
  status: "ok" | "error";
  /** Stable case identifier echoed from the request. */
  caseId: string;
  /** Successful selector output when the case ran to completion. */
  output?: BeforeTurnEvalCaseOutput;
  /** Structured diagnostics emitted by the real before-turn service. */
  diagnostics?: BeforeTurnEvalCaseDiagnostics;
  /** Timing metadata for the isolated eval case. */
  timings?: BeforeTurnEvalCaseTimings;
  /** Isolated sandbox metadata when the sandbox was created successfully. */
  sandbox?: RecallEvalSandboxResult;
  /**
   * Optional bounded, versioned debug artifact. Present only when
   * `options.includeDebugArtifact` is `true` on the request.
   */
  debugArtifact?: BeforeTurnDebugArtifactV1;
  /** Structured error payload when the case failed. */
  error?: BeforeTurnEvalCaseError;
}
