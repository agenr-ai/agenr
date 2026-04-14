import type { ClaimCentricClaimStatus, ClaimCentricMemoryState, ClaimCentricRecallExplanation } from "../recall/claim-centric.js";
import type { RecallExecutionTraceSummary } from "../../core/recall/index.js";
import type { Entry } from "../../core/types.js";

/**
 * Policy hints that shape one session-start selection pass.
 */
export interface SessionStartPolicy {
  /** Maximum always-on core entries to load before hybrid selection. */
  maxCoreEntries?: number;
  /** Enables or disables artifact-grounded durable recall for this pass. */
  enableArtifactRecall?: boolean;
  /** Maximum artifact-grounded recall candidates to consider. */
  maxArtifactRecallEntries?: number;
  /** Maximum durable memory items to return after merging and dedupe. */
  maxDurableEntries?: number;
  /** Maximum artifact text characters to use while building the recall query. */
  maxArtifactChars?: number;
  /** Optional score threshold for artifact-grounded durable recall. */
  recallThreshold?: number;
}

/**
 * Normalized host-neutral input accepted by the session-start service.
 */
export interface SessionStartInput {
  /** Optional session key used for recall telemetry attribution. */
  sessionKey?: string;
  /** Optional predecessor continuity summary supplied by the host adapter. */
  continuitySummaryText?: string;
  /** Optional recent-session tail text supplied by the host adapter. */
  recentSessionText?: string;
  /** Optional policy hints that bound the returned patch. */
  policy?: SessionStartPolicy;
}

/**
 * One non-memory context section preserved separately from durable memory.
 */
export interface SessionStartContextSection {
  /** Stable section identity. */
  kind: "continuity_summary" | "recent_session";
  /** Human-readable section title for adapter rendering. */
  title: string;
  /** Normalized section body text. */
  content: string;
}

/**
 * One ranked durable-memory item returned by the session-start service.
 */
export interface SessionStartPatchItem {
  /** Stable final rank in the bounded durable-memory set. */
  rank: number;
  /** Hydrated durable entry selected for session start. */
  entry: Entry;
  /** Whether the item came from always-on core memory or artifact-grounded recall. */
  sourceKind: "core" | "artifact_recall";
  /** Optional final ranking score when the item came from recall. */
  score?: number;
  /** Concise explanation of why the item surfaced. */
  whySurfaced: ClaimCentricRecallExplanation;
  /** High-level memory-state label for inspection surfaces. */
  memoryState: ClaimCentricMemoryState;
  /** Claim-lifecycle label when available. */
  claimStatus: ClaimCentricClaimStatus;
  /** Compact freshness summary useful to adapters and traces. */
  freshnessLabel: string;
  /** Compact provenance summary when supporting metadata is available. */
  provenanceSummary?: string;
}

/**
 * Compact diagnostics emitted alongside one session-start patch.
 */
export interface SessionStartPatchDiagnostics {
  /** Count of core candidates considered before merging. */
  coreCandidateCount: number;
  /** Count of artifact-grounded recall candidates considered before dedupe. */
  artifactRecallCandidateCount: number;
  /** Whether artifact-grounded recall was attempted. */
  artifactRecallUsed: boolean;
  /** Effective artifact-grounded recall query when one was built. */
  artifactRecallQuery?: string;
  /** Typed recall trace emitted by the shared core recall pipeline. */
  artifactRecallTrace?: RecallExecutionTraceSummary;
  /** Stable degraded-mode or failure notices relevant to the selection pass. */
  notices: string[];
}

/**
 * Structured session-start output returned by the app-layer service.
 */
export interface SessionStartPatch {
  /** Context sections that should stay visibly separate from durable memory. */
  contextSections: SessionStartContextSection[];
  /** Ranked bounded durable-memory selection for the host adapter to render. */
  durableMemory: SessionStartPatchItem[];
  /** Compact diagnostics describing how the patch was built. */
  diagnostics: SessionStartPatchDiagnostics;
}
