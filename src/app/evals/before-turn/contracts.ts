import type { BeforeTurnInput, BeforeTurnPatch, BeforeTurnPatchDiagnostics } from "../../before-turn/index.js";
import type { RecallEvalFixtureEntry, RecallEvalFixtureProcedure, RecallEvalSandboxRequest, RecallEvalSandboxResult } from "../recall/contracts.js";

/**
 * Default top-K candidate cap applied when a before-turn eval case
 * requests a bounded debug artifact without supplying an explicit
 * override.
 */
export const BEFORE_TURN_DEBUG_ARTIFACT_DEFAULT_TOP_K = 10;

/**
 * Hard upper bound for the before-turn debug-artifact top-K candidate
 * list. The boundary rejects values above this cap and the artifact
 * builder clamps any larger in-process request defensively so
 * artifacts stay bounded and predictable for agent consumers.
 */
export const BEFORE_TURN_DEBUG_ARTIFACT_MAX_TOP_K = 25;

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
  memoryPool: RecallEvalFixtureEntry[];
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
  /** Convenience list of ranked durable entry IDs in output order. */
  selectedEntryIds: string[];
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
 * Stable schema version tag for the before-turn replay debug artifact.
 */
export type BeforeTurnDebugArtifactSchemaVersion = "before-turn-debug-artifact.v1";

/**
 * Snapshot provenance block included in a before-turn debug artifact
 * when the sandbox was seeded from a copied corpus snapshot. Aligned
 * with the recall artifact so snapshot metadata looks identical
 * regardless of which eval seam produced the artifact.
 */
export interface BeforeTurnDebugArtifactSnapshot {
  /** Optional stable snapshot identifier echoed from the request. */
  id?: string;
  /** Optional human-readable snapshot label echoed from the request. */
  label?: string;
  /** Base filename of the source snapshot DB, never a full path. */
  dbPathBasename: string;
}

/**
 * Compact turn summary preserved inside the before-turn debug
 * artifact. Only the fields that are useful for post-hoc diagnosis are
 * included; raw transcript payloads are intentionally not echoed.
 */
export interface BeforeTurnDebugArtifactInputSummary {
  /** Host-provided trigger hint, or `unspecified` when omitted. */
  trigger: string;
  /** Current user-turn text preserved for replay analysis. */
  currentTurnText: string;
}

/**
 * Bounded durable-recall candidate breakdown for the before-turn debug
 * artifact. Mirrors the compact before-turn patch entry shape rather
 * than raw recall candidate dumps.
 */
export interface BeforeTurnDebugArtifactDurableCandidate {
  /** Stable durable entry identifier. */
  id: string;
  /** Final durable-memory score for the candidate. */
  score: number;
  /** Concise reasons explaining why the candidate surfaced. */
  reasons?: string[];
}

/**
 * Bounded procedure candidate breakdown for the before-turn debug
 * artifact. Today the selector exposes only its chosen procedure, so
 * the list is typically empty or size 1.
 */
export interface BeforeTurnDebugArtifactProcedureCandidate {
  /** Canonical procedure key for the candidate. */
  procedureKey: string;
  /** Final leader score from dedicated procedure recall. */
  score: number;
  /** Concise reasons explaining why the procedure surfaced. */
  reasons?: string[];
}

/**
 * Bounded, versioned debug artifact surfaced by the before-turn eval
 * seam when `options.includeDebugArtifact` is `true`. Aligned with the
 * recall artifact contract so one replay tool can consume artifacts
 * from either eval seam.
 */
export interface BeforeTurnDebugArtifactV1 {
  /** Stable schema version for this artifact payload. */
  schemaVersion: BeforeTurnDebugArtifactSchemaVersion;
  /** Stable case identifier echoed from the request for correlation. */
  caseId: string;
  /** Optional snapshot provenance when the sandbox was snapshot-seeded. */
  snapshot?: BeforeTurnDebugArtifactSnapshot;
  /** Compact turn summary preserved for offline diagnosis. */
  input: BeforeTurnDebugArtifactInputSummary;
  /** Query-policy decision surfaced by the before-turn selector. */
  queryPolicy?: NonNullable<BeforeTurnPatchDiagnostics["queryPolicy"]>;
  /** Actual durable-query variants attempted during selection. */
  queryVariants?: BeforeTurnPatchDiagnostics["queryVariants"];
  /** Stable abstention reasons mirrored from diagnostics. */
  abstentionReasons?: string[];
  /** Ranked durable entry IDs returned by the selector. */
  selectedEntryIds: string[];
  /** Selected canonical procedure key when one surfaced, otherwise null. */
  selectedProcedureKey: string | null;
  /** Optional bounded durable-recall top-K candidate breakdown. */
  durableRecallTopCandidates?: BeforeTurnDebugArtifactDurableCandidate[];
  /** Optional bounded procedure top-K candidate breakdown. */
  procedureTopCandidates?: BeforeTurnDebugArtifactProcedureCandidate[];
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
