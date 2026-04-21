import type { UnifiedRecallRouting } from "../recall/index.js";
import type { RecallDegradedTrace, RecallNoResultReason } from "../../core/recall/trace.js";

/**
 * Default top-K candidate cap applied when a recall debug artifact
 * is requested without supplying an explicit override.
 */
export const RECALL_DEBUG_ARTIFACT_DEFAULT_TOP_K = 10;

/**
 * Hard upper bound for the recall debug-artifact top-K candidate list.
 * The boundary rejects values above this cap and builders clamp any
 * larger in-process request defensively so artifacts stay bounded and
 * predictable for agent-driven consumers.
 */
export const RECALL_DEBUG_ARTIFACT_MAX_TOP_K = 25;

/**
 * Stable schema version tag for the recall replay debug artifact.
 */
export type RecallDebugArtifactSchemaVersion = "recall-debug-artifact.v1";

/**
 * Executing recall path identifier echoed in the artifact request summary.
 */
export type RecallDebugArtifactRecallPath = "core" | "unified";

/**
 * Snapshot provenance block included in a recall debug artifact when
 * the sandbox was seeded from a copied corpus snapshot. The full
 * snapshot filesystem path is intentionally excluded so artifacts stay
 * portable and safe to publish in replay reports.
 */
export interface RecallDebugArtifactSnapshot {
  /** Optional stable snapshot identifier echoed from the request. */
  id?: string;
  /** Optional human-readable snapshot label echoed from the request. */
  label?: string;
  /** Base filename of the source snapshot DB, never a full path. */
  dbPathBasename: string;
}

/**
 * Compact request summary preserved inside the recall debug artifact.
 * Only fields that are useful for post-hoc diagnosis are included.
 */
export interface RecallDebugArtifactRequestSummary {
  /** Effective recall execution path the case ran against. */
  recallPath: RecallDebugArtifactRecallPath;
  /** Query text that was issued to the recall pipeline. */
  query: string;
}

/**
 * Bounded candidate counts observed across retrieval, ranking, and
 * telemetry stages and surfaced inside the recall debug artifact.
 */
export interface RecallDebugArtifactCandidateCounts {
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
 * Bounded ranking diagnostics surfaced inside the recall debug artifact.
 */
export interface RecallDebugArtifactRankingDiagnostics {
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
 * Compact top-K candidate breakdown carried inside the recall debug artifact.
 */
export interface RecallDebugArtifactTopCandidate {
  /** Stable entry identifier surfaced by recall. */
  id: string;
  /** Final composite recall score for this candidate. */
  score: number;
  /** Evidence-only raw lexical overlap score when available. */
  lexicalScore?: number;
  /** Evidence-only raw vector similarity score when available. */
  vectorScore?: number;
  /** Scoring component for the recency signal when available. */
  recencyScore?: number;
  /** Scoring component for the importance signal when available. */
  importanceScore?: number;
  /** Concise reason fragments explaining why the candidate surfaced. */
  reasons?: string[];
}

/**
 * Bounded, versioned debug artifact surfaced by recall paths. The
 * artifact is designed so a failing replay case can be diagnosed from
 * the artifact alone without re-running the case interactively, and
 * the same shape is reused by the OpenClaw adapter's live debug sink.
 */
export interface RecallDebugArtifactV1 {
  /** Stable schema version for this artifact payload. */
  schemaVersion: RecallDebugArtifactSchemaVersion;
  /** Stable case identifier echoed from the request for correlation. */
  caseId: string;
  /** Optional snapshot provenance when the sandbox was snapshot-seeded. */
  snapshot?: RecallDebugArtifactSnapshot;
  /** Compact request summary preserved for offline diagnosis. */
  request: RecallDebugArtifactRequestSummary;
  /** Unified routing metadata when the case ran through unified recall. */
  routing?: UnifiedRecallRouting;
  /** Stage-by-stage candidate counts mirrored from diagnostics. */
  candidateCounts?: RecallDebugArtifactCandidateCounts;
  /** Ranking facts mirrored from diagnostics. */
  ranking?: RecallDebugArtifactRankingDiagnostics;
  /** Degraded-mode facts mirrored from diagnostics. */
  degraded?: RecallDegradedTrace;
  /** Ranked entry IDs returned by recall, in output order. */
  selectedEntryIds: string[];
  /** Optional bounded top-K candidate breakdown for post-hoc review. */
  topCandidates?: RecallDebugArtifactTopCandidate[];
}
