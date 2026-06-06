import type { RecallInput, RecallOutput } from "../../../core/recall/types.js";
import type {
  RecallClaimKeyTrace,
  RecallCrossEncoderTrace,
  RecallDegradedTrace,
  RecallMmrTrace,
  RecallNeighborhoodTrace,
  RecallNoResultReason,
  RecallRankingPolicy,
  RecallRrfTrace,
} from "../../../core/recall/trace.js";
import type {
  ClaimKeySource,
  ClaimKeyStatus,
  ClaimSupportMode,
  DirectivePolarity,
  DirectiveTrigger,
  DurableKind,
  Expiry,
  ProcedureSource,
  ProcedureStep,
} from "../../../core/types.js";
import type { AblationArm, EvalProfileSnapshotFixture } from "../ablation-arm.js";
import type { ClaimSlotPolicy, ClaimSlotPolicyConfig } from "../../../core/claim-slot-policy.js";
import type {
  ClaimCentricClaimStatus,
  ClaimCentricFreshness,
  ClaimCentricMemoryState,
  ClaimCentricProvenance,
  ClaimCentricRecallExplanation,
} from "../../recall/claim-centric.js";
import type { ClaimTransitionExplanation, UnifiedRecallMode, UnifiedRecallRouting, UnifiedRecallTimeWindow } from "../../recall/types.js";

/**
 * Recall execution path exposed by the eval seam.
 */
export type RecallEvalPath = "core" | "unified";

/**
 * Fixture-only corpus seed. The isolated sandbox starts from an empty
 * database and only the explicit `memoryPool` and `procedurePool`
 * fixtures seed state. Preserves the historical recall eval behavior.
 */
export interface EvalCorpusSeedFixture {
  /** Discriminator for the fixture-only seed mode. */
  mode: "fixture";
}

/**
 * Snapshot-backed corpus seed. The isolated sandbox is seeded by
 * copying `snapshotDbPath` into the sandbox before opening it. Fixture
 * overlays from `memoryPool` and `procedurePool` still apply on top of
 * the copied snapshot. The source snapshot is never mutated.
 */
export interface EvalCorpusSeedSnapshotCopy {
  /** Discriminator for the snapshot-copy seed mode. */
  mode: "snapshot_copy";
  /** Absolute or relative path to the source snapshot SQLite file to copy. */
  snapshotDbPath: string;
  /** Optional stable snapshot identifier for response metadata. */
  snapshotId?: string;
  /** Optional human-readable snapshot label for response metadata. */
  snapshotLabel?: string;
  /**
   * Optional toggle that permits normal recall telemetry writes on the
   * copied snapshot. Defaults to `false` so snapshot replays stay
   * read-only-like at the telemetry layer. When `true`, the real
   * `recordRecallEvents` port runs against the copied database.
   */
  allowTelemetryWrites?: boolean;
}

/**
 * Discriminated union describing how an eval case should seed its
 * isolated sandbox corpus before fixture overlays run.
 */
export type EvalCorpusSeed = EvalCorpusSeedFixture | EvalCorpusSeedSnapshotCopy;

/**
 * Optional sandbox controls for a single recall eval case.
 */
export interface RecallEvalSandboxRequest {
  /** Optional sandbox root path to reuse or preserve for inspection. */
  root?: string;
  /** When true, keep the sandbox on disk after the case completes. */
  preserve?: boolean;
  /** Optional dreaming scoreboard ablation arm for this case. */
  ablationArm?: AblationArm;
  /** Optional fixed wall-clock instant for temporal dreaming fixtures. */
  now?: string;
  /** Optional pre-seeded profile snapshot fixture for dreaming-on cases. */
  profileSnapshot?: EvalProfileSnapshotFixture;
  /**
   * Optional corpus-seed control. When omitted, the sandbox keeps the
   * historical fixture-only behavior. When supplied, selects between
   * fixture and snapshot-copy seeding.
   */
  corpusSeed?: EvalCorpusSeed;
}

/**
 * Snapshot provenance metadata attached to a recall eval response when
 * the case ran against a copied corpus snapshot.
 */
export interface RecallEvalSnapshotMetadata {
  /** Optional stable snapshot identifier echoed from the request. */
  id?: string;
  /** Optional human-readable snapshot label echoed from the request. */
  label?: string;
  /** Base filename of the source snapshot DB, never a full path. */
  dbPathBasename: string;
  /** Whether recall telemetry writes ran against the copied snapshot. */
  allowedTelemetryWrites: boolean;
}

/**
 * Explicit fixture entry schema for seeding a recall eval memory pool.
 */
export interface RecallEvalFixtureEntry {
  /** Optional stable entry identifier supplied by the eval harness. */
  id?: string;
  /** Durable knowledge category aligned with the core entry model. */
  type: DurableKind;
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
  /** Optional directive polarity for directive fixture rows. */
  directive_polarity?: DirectivePolarity;
  /** Optional directive trigger for directive fixture rows. */
  directive_trigger?: DirectiveTrigger;
}

/**
 * Explicit fixture procedure schema for seeding a recall eval procedure pool.
 */
export interface RecallEvalFixtureProcedure {
  /** Optional stable procedure identifier supplied by the eval harness. */
  id?: string;
  /** Stable procedure key used for active revision lookup. */
  procedure_key: string;
  /** Human-readable procedure title. */
  title: string;
  /** Short goal statement for the authored procedure. */
  goal: string;
  /** Applicability guidance for when this procedure should be used. */
  when_to_use?: string[];
  /** Applicability guidance for when this procedure should not be used. */
  when_not_to_use?: string[];
  /** Ordered prerequisite checklist. */
  prerequisites?: string[];
  /** Ordered authored procedure steps. */
  steps: ProcedureStep[];
  /** Verification checks for the procedure. */
  verification?: string[];
  /** Expected failure modes for the procedure. */
  failure_modes?: string[];
  /** Explicit authored provenance for the procedure. */
  sources?: ProcedureSource[];
  /** Optional source file path attached to the stored procedure. */
  source_file?: string;
  /** Optional successor procedure ID when the fixture is superseded. */
  superseded_by?: string;
  /** Optional validity lower bound for deterministic ordering. */
  valid_from?: string;
  /** Optional validity upper bound for deterministic ordering. */
  valid_to?: string;
  /** Optional explicit supersession relationship kind. */
  supersession_kind?: string;
  /** Optional explicit supersession rationale. */
  supersession_reason?: string;
  /** Optional creation timestamp for deterministic ordering. */
  created_at?: string;
  /** Optional update timestamp for deterministic ordering. */
  updated_at?: string;
}

/**
 * Recall query payload aligned with the real core recall input shape.
 */
export type RecallEvalQueryRequest = Pick<
  RecallInput,
  "text" | "limit" | "threshold" | "budget" | "types" | "tags" | "since" | "until" | "around" | "aroundRadius" | "asOf" | "rankingProfile"
> & {
  /**
   * Optional ranking-policy overrides applied for this case run. Mirrors
   * `RecallExecutionOptions.rankingPolicy` so the eval harness can toggle
   * RRF, neighborhood expansion, MMR, and cross-encoder rerank
   * independently and A/B their effect on the same memory pool.
   */
  rankingPolicy?: RecallRankingPolicy;
};

/**
 * Narrow unified-recall memory-policy block aligned with the OpenClaw adapter.
 */
export interface RecallEvalUnifiedMemoryPolicyRequest {
  /** Optional runtime slot-policy overrides keyed by attribute head. */
  slotPolicies?: ClaimSlotPolicyConfig;
}

/**
 * Unified-recall caller context that mirrors the real OpenClaw adapter surface.
 */
export interface RecallEvalUnifiedRequest {
  /** Optional unified routing mode. */
  mode?: UnifiedRecallMode;
  /** Optional session key forwarded into underlying durable recall telemetry. */
  sessionKey?: string;
  /** Optional memory-policy overrides used by unified recall shaping. */
  memoryPolicy?: RecallEvalUnifiedMemoryPolicyRequest;
}

/**
 * Internal-only fault injection controls for deterministic degraded-mode evals.
 */
export interface RecallEvalFaultInjectionRequest {
  /** Force the recall query embedding step to fail after fixture provisioning completes. */
  queryEmbeddingFailure?: boolean;
  /** Force the vector-search step to fail after query embedding succeeds. */
  vectorSearchFailure?: boolean;
}

import {
  RECALL_DEBUG_ARTIFACT_DEFAULT_TOP_K,
  RECALL_DEBUG_ARTIFACT_MAX_TOP_K,
  type RecallDebugArtifactRecallPath,
  type RecallDebugArtifactRequestSummary,
  type RecallDebugArtifactSchemaVersion,
  type RecallDebugArtifactSnapshot,
  type RecallDebugArtifactTopCandidate,
  type RecallDebugArtifactV1,
} from "../../debug-artifacts/index.js";

export {
  RECALL_DEBUG_ARTIFACT_DEFAULT_TOP_K,
  RECALL_DEBUG_ARTIFACT_MAX_TOP_K,
  type RecallDebugArtifactRecallPath,
  type RecallDebugArtifactRequestSummary,
  type RecallDebugArtifactSchemaVersion,
  type RecallDebugArtifactSnapshot,
  type RecallDebugArtifactTopCandidate,
  type RecallDebugArtifactV1,
};

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
  /**
   * Include a bounded, versioned debug artifact in the response. The
   * artifact is opt-in and disabled by default. When true the response
   * includes `debugArtifact` with stable routing, candidate-count,
   * ranking, degraded, and top-K candidate facts sufficient to diagnose
   * a failing replay case without re-running it.
   */
  includeDebugArtifact?: boolean;
  /**
   * Optional top-K override for the debug-artifact candidate breakdown.
   * Clamped into the inclusive range `[1, RECALL_DEBUG_ARTIFACT_MAX_TOP_K]`.
   * Defaults to `RECALL_DEBUG_ARTIFACT_DEFAULT_TOP_K` so payloads stay
   * predictable across cases.
   */
  topKCandidates?: number;
  /** Internal deterministic degradation controls used by eval corpora and tests. */
  faultInjection?: RecallEvalFaultInjectionRequest;
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
  /** Optional procedure fixtures to provision for unified procedural cases. */
  procedurePool?: RecallEvalFixtureProcedure[];
  /** Recall query configuration for the case under test. */
  recallRequest: RecallEvalQueryRequest;
  /** Unified-only caller context used when the seam exercises unified recall. */
  unified?: RecallEvalUnifiedRequest;
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
  type: DurableKind;
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
    /** Runtime slot-policy class used for read-time shaping. */
    slotPolicy: ClaimSlotPolicy;
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
 * Claim-centric row metadata exposed separately from the primary result rows.
 */
export interface RecallEvalProjectedEntryMetadata {
  /** Stable entry identifier mirrored for machine-readable assertions. */
  entryId: string;
  /** Grouping key used for claim-family views. */
  familyKey: string;
  /** Shared claim key when the row belongs to a claim family. */
  claimKey?: string;
  /** Runtime slot-policy class used for read-time shaping. */
  slotPolicy: ClaimSlotPolicy;
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
}

/**
 * Compact family-member summary used in claim-family metadata.
 */
export interface RecallEvalClaimFamilyEntryMetadata {
  /** Stable entry identifier for the family member. */
  id: string;
  /** High-level current vs historical state label. */
  memoryState: ClaimCentricMemoryState;
  /** Lifecycle label for trust surfaces. */
  claimStatus: ClaimCentricClaimStatus;
}

/**
 * Compact claim-family metadata emitted for unified recall assertions.
 */
export interface RecallEvalClaimFamilyMetadata {
  /** Grouping key shared by related recall rows. */
  familyKey: string;
  /** Shared claim key when the family is keyed. */
  claimKey?: string;
  /** Runtime slot-policy class used while interpreting the family. */
  slotPolicy: ClaimSlotPolicy;
  /** Family subject shown to callers. */
  subject: string;
  /** Highest-ranked row in the family. */
  primaryEntryId: string;
  /** Compact family-member summaries in ranked order. */
  entries: RecallEvalClaimFamilyEntryMetadata[];
}

/**
 * Product-facing claim-centric metadata emitted by the seam.
 */
export interface RecallEvalClaimMetadata {
  /** Flat projected rows in ranked order. */
  projectedEntries: RecallEvalProjectedEntryMetadata[];
  /** Grouped claim families when unified recall produced them. */
  entryFamilies?: RecallEvalClaimFamilyMetadata[];
  /** Compact transition summaries when unified recall produced them. */
  transitions?: ClaimTransitionExplanation[];
}

/**
 * Product-facing unified recall metadata emitted by the seam.
 */
export interface RecallEvalUnifiedMetadata {
  /** Router metadata explaining the queried sources and intent. */
  routing: UnifiedRecallRouting;
  /** Optional resolved time-window metadata from unified recall. */
  timeWindow?: UnifiedRecallTimeWindow;
  /** Optional explicit as-of reference point echoed by unified recall. */
  asOf?: string;
  /** Canonical procedure answer when unified recall returned one. */
  procedure?: {
    id: string;
    procedureKey: string;
    title: string;
    goal: string;
  };
  /** Ranked procedure candidates preserved for unified eval assertions. */
  procedureCandidates: Array<{
    id: string;
    procedureKey: string;
    title: string;
    score: number;
    lexicalScore: number;
    vectorScore: number;
  }>;
  /** Procedure-specific degraded-mode or routing notices. */
  procedureNotices: string[];
  /** User-facing notices returned by unified recall. */
  notices: string[];
  /** Number of episode results returned alongside entries. */
  episodeCount: number;
}

/**
 * Product-facing response metadata emitted separately from execution diagnostics.
 */
export interface RecallEvalCaseMetadata {
  /** Which top-level recall path produced the response. */
  path: RecallEvalPath;
  /** Claim-centric metadata shared across core and unified paths. */
  claim: RecallEvalClaimMetadata;
  /** Unified-only product metadata when the seam used the unified path. */
  unified?: RecallEvalUnifiedMetadata;
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
  /** Number of stale fixtures seeded into isolated storage. */
  staleCount: number;
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
  types: DurableKind[];
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
 * Degraded recall facts emitted when the core falls back away from the normal
 * vector-backed path.
 */
export type RecallEvalDegradedDiagnostics = RecallDegradedTrace;

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
  /**
   * Reciprocal rank fusion facts emitted by the core recall path. Present
   * whenever the recall trace summary was observed, even if RRF was
   * disabled via the ranking policy (in which case `applied` is `false`).
   */
  rrf?: RecallRrfTrace;
  /**
   * Neighborhood expansion and seeded rerank facts emitted by the core
   * recall path. Present whenever the recall trace summary was observed,
   * even when expansion is unavailable or disabled via the policy.
   */
  neighborhood?: RecallNeighborhoodTrace;
  /**
   * MMR diversification facts emitted by the core recall path. Present
   * whenever the recall trace summary was observed, even if MMR did not
   * run (in which case `applied` is `false`).
   */
  mmr?: RecallMmrTrace;
  /**
   * Cross-encoder rerank facts emitted by the core recall path. Present
   * whenever the recall trace summary was observed, even if the rerank
   * was skipped or fell back due to a missing port, an explicit disable,
   * or a provider error.
   */
  crossEncoder?: RecallCrossEncoderTrace;
  /** Degraded-mode facts emitted by the core recall path. */
  degraded?: RecallEvalDegradedDiagnostics;
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
  /** Snapshot provenance metadata when the sandbox used snapshot-copy seeding. */
  snapshot?: RecallEvalSnapshotMetadata;
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
  /** Product-facing metadata emitted separately from execution diagnostics. */
  metadata?: RecallEvalCaseMetadata;
  /** Optional typed diagnostics returned for eval analysis. */
  diagnostics?: RecallEvalCaseDiagnostics;
  /** Optional timing metadata for the execution. */
  timings?: RecallEvalCaseTimings;
  /** Optional sandbox references for later inspection. */
  sandbox?: RecallEvalSandboxResult;
  /**
   * Optional bounded, versioned debug artifact. Present only when
   * `options.includeDebugArtifact` is `true` on the request.
   */
  debugArtifact?: RecallDebugArtifactV1;
  /** Structured error payload when execution fails. */
  error?: RecallEvalCaseError;
}
