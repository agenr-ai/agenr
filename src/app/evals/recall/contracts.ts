import type { RecallInput, RecallOutput } from "../../../core/recall/types.js";
import type { EntryType, Expiry } from "../../../core/types.js";

/**
 * Optional sandbox controls for a single recall eval case.
 */
export interface RecallEvalSandboxRequest {
  /** Optional sandbox root path to reuse or preserve for inspection. */
  root?: string;
  /** When true, keep the sandbox on disk after the case completes. */
  preserve?: boolean;
}

/**
 * Explicit fixture entry schema for seeding a recall eval memory pool.
 */
export interface RecallEvalFixtureEntry {
  /** Optional stable entry identifier supplied by the eval harness. */
  id?: string;
  /** Durable knowledge category aligned with the core entry model. */
  type: EntryType;
  /** Short subject line for the memory entry. */
  subject: string;
  /** Full memory content for the fixture entry. */
  content: string;
  /** Optional explicit importance override on the 1-10 scale. */
  importance?: number;
  /** Optional explicit expiry aligned with the core entry model. */
  expiry?: Expiry;
  /** Optional tag list used for recall filtering and ranking. */
  tags?: string[];
  /** Optional source path attached to the fixture entry. */
  source_file?: string;
  /** Optional source context attached to the fixture entry. */
  source_context?: string;
  /** Optional creation timestamp for deterministic temporal behavior. */
  created_at?: string;
  /** Optional update timestamp for deterministic temporal behavior. */
  updated_at?: string;
  /** Optional retirement flag for explicit inactive fixture entries. */
  retired?: boolean;
  /** Optional retirement timestamp when the fixture is retired. */
  retired_at?: string;
  /** Optional retirement reason attached to the fixture. */
  retired_reason?: string;
  /** Optional successor entry ID when the fixture is superseded. */
  superseded_by?: string;
}

/**
 * Recall query payload aligned with the real core recall input shape.
 */
export type RecallEvalQueryRequest = Pick<
  RecallInput,
  "text" | "limit" | "threshold" | "budget" | "types" | "tags" | "since" | "until" | "around" | "aroundRadius"
>;

/**
 * Optional output controls for the recall eval execution seam.
 */
export interface RecallEvalCaseOptions {
  /** Include structured diagnostics in the response when available. */
  includeDiagnostics?: boolean;
  /** Include candidate-level diagnostics when available in later phases. */
  includeCandidates?: boolean;
  /** Include timing metadata in the response. */
  includeTimings?: boolean;
}

/**
 * Application-layer request contract for a single recall eval case.
 */
export interface RecallEvalCaseRequest {
  /** Stable case identifier supplied by the external eval harness. */
  caseId: string;
  /** Optional human-readable case description. */
  description?: string;
  /** Optional sandbox configuration for the case execution. */
  sandbox?: RecallEvalSandboxRequest;
  /** Explicit memory fixtures to provision for the isolated case. */
  memoryPool: RecallEvalFixtureEntry[];
  /** Recall query configuration for the case under test. */
  recallRequest: RecallEvalQueryRequest;
  /** Optional response-shaping flags for diagnostics and timings. */
  options?: RecallEvalCaseOptions;
}

/**
 * Ranked recall entry returned from a recall eval case run.
 */
export interface RecallEvalResultEntry {
  /** Stable entry identifier emitted by the recall path. */
  id: string;
  /** Subject of the recalled memory entry. */
  subject: string;
  /** Content of the recalled memory entry. */
  content: string;
  /** Durable knowledge category of the recalled entry. */
  type: EntryType;
  /** Importance score of the recalled entry. */
  importance: number;
  /** Expiry level of the recalled entry. */
  expiry: Expiry;
  /** Tags attached to the recalled entry. */
  tags: string[];
  /** Creation timestamp of the recalled entry. */
  created_at: string;
  /** Final aggregate recall score for the entry. */
  score: number;
  /** Signal-level score breakdown returned by the recall engine. */
  scores: RecallOutput["scores"];
}

/**
 * Final scored output returned from a recall eval case run.
 */
export interface RecallEvalCaseResult {
  /** Fully shaped ranked entries returned by recall. */
  entries: RecallEvalResultEntry[];
  /** Convenience list of ranked entry IDs in output order. */
  entryIds: string[];
}

/**
 * Small typed diagnostics emitted by the isolated recall eval execution flow.
 */
export interface RecallEvalCaseDiagnostics {
  /** Execution metadata for the current isolated-case recall seam. */
  execution: {
    /** Stable mode marker for the Phase 2 isolated execution slice. */
    mode: "isolated-case";
    /** Default fixture provisioning mode used by recall eval execution. */
    provisioning: "exact-fixture-seed";
    /** Number of fixture entries supplied in the request. */
    memoryPoolCount: number;
    /** Number of fixture entries provisioned into isolated storage. */
    provisionedCount: number;
    /** Whether diagnostics were explicitly requested by the caller. */
    requestedDiagnostics: boolean;
    /** Whether candidate-level details were requested by the caller. */
    requestedCandidates: boolean;
  };
}

/**
 * Timing metadata for a recall eval case run.
 */
export interface RecallEvalCaseTimings {
  /** End-to-end execution time for the app-level service call. */
  totalMs: number;
}

/**
 * Sandbox references returned from a recall eval case run.
 */
export interface RecallEvalSandboxResult {
  /** Sandbox root used for the case when one was supplied or created. */
  root?: string;
  /** Future sandbox database path for deeper inspection. */
  dbPath?: string;
  /** Whether the sandbox was preserved for later inspection. */
  preserved: boolean;
}

/**
 * Structured error payload returned from a recall eval case run.
 */
export interface RecallEvalCaseError {
  /** Stable machine-readable error code when available. */
  code?: "sandbox_setup_failed" | "fixture_provision_failed" | "recall_execution_failed" | "internal_error";
  /** Human-readable error summary. */
  message: string;
  /** Optional structured details for callers that need more context. */
  details?: unknown;
}

/**
 * Application-layer response contract for a single recall eval case.
 */
export interface RecallEvalCaseResponse {
  /** Normalized execution status for the requested case. */
  status: "ok" | "error";
  /** Stable case identifier echoed from the request. */
  caseId: string;
  /** Ranked recall result payload when execution succeeds. */
  result?: RecallEvalCaseResult;
  /** Optional typed diagnostics returned for eval analysis. */
  diagnostics?: RecallEvalCaseDiagnostics;
  /** Optional timing metadata for the execution. */
  timings?: RecallEvalCaseTimings;
  /** Optional sandbox references for later inspection. */
  sandbox?: RecallEvalSandboxResult;
  /** Structured error payload when execution fails. */
  error?: RecallEvalCaseError;
}
