import type { RecallInput, RecallOutput } from "../../../core/recall/types.js";
import type { RecallClaimKeyTrace, RecallNoResultReason } from "../../../core/recall/trace.js";
import type { ClaimKeySource, ClaimKeyStatus, ClaimSupportMode, EntryType, Expiry } from "../../../core/types.js";
import type {
  ClaimCentricClaimStatus,
  ClaimCentricFreshness,
  ClaimCentricMemoryState,
  ClaimCentricProvenance,
  ClaimCentricRecallExplanation,
} from "../../recall/claim-centric.js";
import type { UnifiedRecallRouting, UnifiedRecallTimeWindow } from "../../recall/types.js";

/**
 * Recall execution path exposed by the eval seam.
 */
export type RecallEvalPath = "core" | "unified";

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
  /** Optional canonical claim key for deterministic lineage scenarios. */
  claim_key?: string;
  /** Optional claim-key lifecycle status. */
  claim_key_status?: ClaimKeyStatus;
  /** Optional claim-key provenance source. */
  claim_key_source?: ClaimKeySource;
  /** Optional explicit supporting source kind for the claim. */
  claim_support_source_kind?: string;
  /** Optional explicit supporting source locator for the claim. */
  claim_support_locator?: string;
  /** Optional observed-at timestamp for the supporting source. */
  claim_support_observed_at?: string;
  /** Optional supporting-source normalization mode. */
  claim_support_mode?: ClaimSupportMode;
  /** Optional validity lower bound for deterministic current-vs-prior cases. */
  valid_from?: string;
  /** Optional validity upper bound for deterministic current-vs-prior cases. */
  valid_to?: string;
  /** Optional explicit supersession relationship kind. */
  supersession_kind?: string;
  /** Optional explicit supersession rationale. */
  supersession_reason?: string;
}

/**
 * Recall query payload aligned with the real core recall input shape.
 */
export type RecallEvalQueryRequest = Pick<
  RecallInput,
  "text" | "limit" | "threshold" | "budget" | "types" | "tags" | "since" | "until" | "around" | "aroundRadius" | "rankingProfile"
>;

/**
 * Optional output controls for the recall eval execution seam.
 */
export interface RecallEvalCaseOptions {
  /** Include structured diagnostics in the response when available. */
  includeDiagnostics?: boolean;
  /** Request stable aggregate candidate diagnostics, not raw candidate payload dumps. */
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
  /** Optional recall execution path. Defaults to the legacy core path. */
  recallPath?: RecallEvalPath;
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
  /** Claim-centric trust annotation projected from the recall output. */
  claim?: {
    /** Grouping key used for claim-family views. */
    familyKey: string;
    /** Shared claim key when the row belongs to a claim family. */
    claimKey?: string;
    /** High-level current vs historical state label. */
    memoryState: ClaimCentricMemoryState;
    /** Lifecycle label for trust surfaces. */
    claimStatus: ClaimCentricClaimStatus;
    /** Freshness metadata surfaced with the recalled row. */
    freshness: ClaimCentricFreshness;
    /** Provenance cues persisted on the recalled row. */
    provenance: ClaimCentricProvenance;
    /** Concise reason the row surfaced in recall. */
    whySurfaced: ClaimCentricRecallExplanation;
  };
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
 * Minimal seeded-state summary for one provisioned fixture entry.
 */
export interface RecallEvalProvisionedEntrySummary {
  /** Stable entry identifier after exact fixture seeding. */
  id: string;
  /** Seeded created-at timestamp before recall telemetry runs. */
  created_at: string;
  /** Seeded updated-at timestamp before recall telemetry runs. */
  updated_at: string;
  /** Whether the seeded fixture entry was retired. */
  retired: boolean;
  /** Optional successor entry ID preserved during exact seeding. */
  superseded_by?: string;
  /** Optional canonical claim key preserved during exact seeding. */
  claim_key?: string;
  /** Optional claim-key lifecycle status preserved during exact seeding. */
  claim_key_status?: ClaimKeyStatus;
  /** Optional validity lower bound preserved during exact seeding. */
  valid_from?: string;
  /** Optional validity upper bound preserved during exact seeding. */
  valid_to?: string;
}

/**
 * Structured provisioning diagnostics for the isolated fixture seed step.
 */
export interface RecallEvalProvisionDiagnostics {
  /** Number of fixture entries supplied in the request. */
  requestedCount: number;
  /** Number of fixture entries written into isolated storage. */
  provisionedCount: number;
  /** Number of fixtures that supplied their own IDs. */
  providedIdCount: number;
  /** Number of fixtures that received deterministic generated IDs. */
  generatedIdCount: number;
  /** Number of retired fixtures seeded into isolated storage. */
  retiredCount: number;
  /** Number of fixtures that reference a successor entry. */
  supersededCount: number;
  /** Number of fixtures that defaulted `created_at` during seeding. */
  createdAtDefaultedCount: number;
  /** Number of fixtures that defaulted `updated_at` during seeding. */
  updatedAtDefaultedCount: number;
  /** Seeded-state summary captured before recall telemetry can mutate rows. */
  seededEntries: RecallEvalProvisionedEntrySummary[];
}

/**
 * Structured retrieval diagnostics collected at adapter boundaries.
 */
export interface RecallEvalRetrievalDiagnostics {
  /** Query embedding dimensionality observed during recall execution. */
  queryEmbeddingDimensions: number;
  /** Effective vector-search candidate limit used by the recall path. */
  vectorSearchLimit: number;
  /** Effective lexical candidate limit used by the recall path. */
  lexicalSearchLimit: number;
}

/**
 * Structured ranking diagnostics emitted by the real recall algorithm.
 */
export interface RecallEvalRankingDiagnostics {
  /** Effective result limit after recall input normalization. */
  limit: number;
  /** Effective score threshold after recall input normalization. */
  threshold: number;
  /** Effective token budget after recall input normalization, or null when disabled. */
  budget: number | null;
  /** Stable no-result reason when recall returned no final entries. */
  noResultReason?: RecallNoResultReason;
}

/**
 * Active filtering summary for the executed recall query.
 */
export interface RecallEvalFilteringDiagnostics {
  /** Active type filters applied during candidate retrieval. */
  types: EntryType[];
  /** Active tag filters applied during candidate retrieval. */
  tags: string[];
  /** Applied lower created-at bound in ISO format when present. */
  since?: string;
  /** Applied upper created-at bound in ISO format when present. */
  until?: string;
  /** Applied around-date anchor when present or inferred. */
  around?: {
    /** Whether the around-date came from explicit input or query inference. */
    source: "explicit" | "inferred";
    /** Normalized around-date anchor in ISO format. */
    anchor: string;
    /** Effective gaussian radius in days. */
    radiusDays: number;
  };
}

/**
 * Candidate counts observed across retrieval, ranking, and telemetry stages.
 */
export interface RecallEvalCandidateCounts {
  /** Candidates returned by vector search after adapter-level filtering. */
  vectorRetrieved: number;
  /** Candidates returned by lexical search after adapter-level filtering. */
  lexicalRetrieved: number;
  /** Unique merged candidates admitted into scoring. */
  merged: number;
  /** Candidates that survived the score threshold. */
  thresholdQualified: number;
  /** Candidates retained after the token budget step. */
  budgetAccepted: number;
  /** Candidates retained after the final limit slice. */
  finalRanked: number;
  /** Fully hydrated entries fetched for the final ranked IDs. */
  hydrated: number;
  /** Entries returned after hydration and shaping. */
  returned: number;
  /** Entries targeted by standard recall telemetry writes. */
  telemetryAttempted: number;
}

/**
 * Unified-recall routing diagnostics emitted when the eval seam uses the
 * higher-level routing path.
 */
export interface RecallEvalUnifiedDiagnostics {
  /** Confirms that the eval seam executed through unified recall. */
  path: "unified";
  /** Router metadata explaining intent detection and queried sources. */
  routing: UnifiedRecallRouting;
  /** Optional resolved time-window metadata from unified recall. */
  timeWindow?: UnifiedRecallTimeWindow;
  /** User-facing notices returned by unified recall. */
  notices: string[];
  /** Number of episode results returned alongside entries. */
  episodeCount: number;
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
    /** Selected recall execution path for the case. */
    recallPath: RecallEvalPath;
    /** Number of fixture entries supplied in the request. */
    memoryPoolCount: number;
    /** Number of fixture entries provisioned into isolated storage. */
    provisionedCount: number;
    /** Whether diagnostics were explicitly requested by the caller. */
    requestedDiagnostics: boolean;
    /** Whether aggregate candidate diagnostics were requested by the caller. */
    requestedCandidates: boolean;
  };
  /** Exact fixture-seeding facts captured before recall execution. */
  provision?: RecallEvalProvisionDiagnostics;
  /** Retrieval-stage facts captured at adapter boundaries. */
  retrieval?: RecallEvalRetrievalDiagnostics;
  /** Ranking-stage facts emitted by the real recall algorithm. */
  ranking?: RecallEvalRankingDiagnostics;
  /** Active filtering summary for the executed recall query. */
  filtering?: RecallEvalFilteringDiagnostics;
  /** Claim-key lineage and trust shaping facts emitted by the core recall path. */
  claimKey?: RecallClaimKeyTrace;
  /** Unified-recall routing metadata when the case used the unified path. */
  unifiedRecall?: RecallEvalUnifiedDiagnostics;
  /** Stage-by-stage candidate counts across the recall pipeline. Always present when diagnostics are included. */
  candidateCounts?: RecallEvalCandidateCounts;
}

/**
 * Timing metadata for a recall eval case run.
 */
export interface RecallEvalCaseTimings {
  /** End-to-end execution time for the app-level service call. */
  totalMs: number;
  /** Time spent creating the isolated sandbox. */
  sandboxSetupMs: number;
  /** Time spent exact-seeding fixture entries into isolated storage. */
  fixtureProvisionMs: number;
  /** Time spent inside the real recall call. */
  recallMs: number;
  /** Time spent computing the query embedding. */
  queryEmbeddingMs: number;
  /** Time spent retrieving vector candidates. */
  vectorSearchMs: number;
  /** Time spent retrieving lexical candidates. */
  lexicalSearchMs: number;
  /** Time spent merging vector and lexical candidates. */
  mergeCandidatesMs: number;
  /** Time spent scoring and sorting merged candidates. */
  scoreCandidatesMs: number;
  /** Time spent applying the score threshold. */
  thresholdMs: number;
  /** Time spent applying the token budget. */
  budgetMs: number;
  /** Time spent hydrating the final ranked entries. */
  hydrateEntriesMs: number;
  /** Time spent shaping hydrated entries into the response payload. */
  shapeResultsMs: number;
  /** Time spent attempting normal recall telemetry writes. */
  recordRecallEventsMs: number;
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
