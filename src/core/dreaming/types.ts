/**
 * Core dreaming domain types.
 */

import type { DirectivePolarity, DirectiveTrigger, DurableKind, Expiry } from "../types.js";

/** Ordered list of supported dreaming run tiers. */
const DREAM_TIERS = ["light", "standard", "deep"] as const;

export { DREAM_TIERS };

/** Union of supported dreaming run tiers. */
export type DreamTier = (typeof DREAM_TIERS)[number];

/** Ordered list of supported dreaming pipeline stages. */
const DREAM_STAGES = ["scan", "extract", "reconcile", "temporalize", "project", "prune", "apply"] as const;

export { DREAM_STAGES };

/** Union of supported dreaming pipeline stages. */
export type DreamStage = (typeof DREAM_STAGES)[number];

/**
 * Structured claim-key health snapshot captured before or after one pass.
 */
export interface ClaimKeyHealthSnapshot {
  totalDurables: number;
  activeDurables: number;
  coverageCount: number;
  coveragePct: number;
  missingCount: number;
  eligibleMissingCount: number;
  malformedOrNoncanonicalCount: number;
  suspectCanonicalCount: number;
  entityFamilyGroupCount: number;
  suspiciousSingletonAliasCount: number;
  mixedGroupCount: number;
  exactKeyMultiActiveClusterCount: number;
}

/**
 * Aggregate repair counts captured during one reconcile run.
 */
export interface ReconcileRepairCounts {
  identifiedNormalizations: number;
  appliedNormalizations: number;
  identifiedBackfills: number;
  appliedBackfills: number;
  identifiedMetadataRewrites: number;
  appliedMetadataRewrites: number;
  identifiedEntityFamilyConvergences: number;
  appliedEntityFamilyConvergences: number;
  proposalsEmitted: number;
  skippedNoClaim: number;
  skippedLowConfidence: number;
  skippedCollision: number;
  flaggedAmbiguousProposals: number;
}

/** Threshold-only cohort bucket used by shadow sibling-slot-resonance reporting. */
export type ReconcileShadowBucket =
  | "high_density_grounded_family"
  | "large_grounding_diluted_grounded_family"
  | "thin_grounded_family_tail"
  | "relaxed_one_sibling_stable_slot"
  | "other_grounded_family_alignment";

/** Stable machine-readable circuit-breaker categories for reconcile runs. */
export type ReconcileCircuitBreakerKind = "claim_key_concentration" | "entity_prefix_concentration" | "collision_spike";

/** Summary counts for one threshold-only shadow-evaluation bucket. */
export interface ReconcileShadowBucketSummary {
  bucket: ReconcileShadowBucket;
  candidateCount: number;
  resonanceApplicableCount: number;
  resonanceFiredCount: number;
  shadowQualifiedCount: number;
}

/** Shadow-only sibling-slot-resonance summary captured for threshold-only supported cases. */
export interface ReconcileSiblingSlotResonanceShadowSummary {
  rule: {
    supportClass: "trusted_family_grounded_alignment";
    minFamilyReuseCount: number;
    minGroundedRatio: number;
    minConfidence: number;
    requiresSiblingSlotResonance: true;
  };
  thresholdOnlyCandidateCount: number;
  resonanceApplicableCount: number;
  resonanceFiredCount: number;
  shadowQualifiedCount: number;
  resonanceFiredClaimKeys: string[];
  shadowQualifiedClaimKeys: string[];
  buckets: ReconcileShadowBucketSummary[];
}

/** Structured reconcile pass summary persisted on the dreaming run. */
export interface ReconcilePassSummary {
  executionStyle: "autonomous" | "targeted";
  workingSet: {
    includeInactive: boolean;
    project: string | null;
    type: string | null;
    claimKeyPrefix: string | null;
    durableIds: string[];
  };
  before: ClaimKeyHealthSnapshot;
  after: ClaimKeyHealthSnapshot;
  projectedAfter?: ClaimKeyHealthSnapshot;
  counts: ReconcileRepairCounts;
  shadowSiblingSlotResonance?: ReconcileSiblingSlotResonanceShadowSummary | null;
  circuitBreaker?: {
    kind: ReconcileCircuitBreakerKind;
    message: string;
  } | null;
}

/** Machine-readable reason one dreaming pipeline stage was skipped. */
export type DreamStageSkipReason = "light_tier";

/** Structured record for a pipeline stage skipped by tier policy. */
export interface DreamStageSkipSummary {
  /** Pipeline stage skipped during the run. */
  stage: DreamStage;
  /** Stable reason the stage did not run. */
  reason: DreamStageSkipReason;
}

/** Structured unresolved claim-key proposal persisted for later adjudication. */
export type DreamProposalReviewStatus = "open" | "applied" | "rejected";

/** Structured unresolved claim-key proposal persisted for later adjudication. */
export interface DreamRunProposal {
  id: string;
  runId: string;
  groupId: string;
  issueKind: string;
  scope: "single_durable" | "cluster";
  durableIds: string[];
  currentClaimKeys: string[];
  proposedClaimKeys: string[];
  rationale: string;
  confidence: number;
  source: string;
  eligibleForApply: boolean;
  createdAt: string;
  reviewStatus: DreamProposalReviewStatus;
  reviewedAt: string | null;
  reviewReason: string | null;
  appliedActionCount: number;
}

/** Lifecycle states for one dreaming run. */
export type DreamRunStatus = "running" | "completed" | "failed" | "aborted" | "budget_exhausted" | "cost_capped" | "no_work" | "stalled";

/** Evidence locator referenced by dreaming mutations. */
export interface DreamEvidenceRef {
  kind: "episode" | "ingest_log" | "durable" | "transcript";
  locator: string;
  observedAt?: string;
}

/**
 * Disposition assigned to one durable candidate by the extract context-lookup step.
 *
 * - `new` - no existing durable covers this claim, so it can become a fresh row.
 * - `refines` - an active durable already covers this claim with different content,
 *   so the candidate feeds temporalize as a supersession revision.
 * - `known` - an active durable already covers this claim with equivalent content,
 *   so the candidate is skipped to avoid redundant writes and embeddings.
 */
export type DreamCandidateDisposition = "new" | "refines" | "known";

/** Trust signal carried by an extracted durable candidate. */
export type DreamCandidateTrust = "tentative" | "trusted";

/**
 * Durable candidate mined from evidence by the extract stage.
 *
 * Candidates never write rows directly. Downstream stages decide whether to
 * insert a new durable, supersede an existing one, or skip the candidate.
 */
export interface DreamCandidate {
  id: string;
  type: DurableKind;
  subject: string;
  content: string;
  importance: number;
  expiry: Expiry;
  tags: string[];
  directivePolarity?: DirectivePolarity;
  directiveTrigger?: DirectiveTrigger;
  claimKey: string | null;
  trust: DreamCandidateTrust;
  disposition: DreamCandidateDisposition;
  /** Active durable this candidate refines, when disposition is `refines` or `known`. */
  refinesDurableId: string | null;
  evidenceRefs: DreamEvidenceRef[];
}

/** Structured summary of one extract stage execution. */
export interface DreamExtractSummary {
  episodesScanned: number;
  candidatesEmitted: number;
  newCandidates: number;
  refineCandidates: number;
  knownCandidates: number;
  durablesInserted: number;
}

/** Structured summary of one temporalize stage execution. */
export interface DreamTemporalizeSummary {
  revisionsIdentified: number;
  revisionsApplied: number;
  revisionsSkipped: number;
}

/** Structured summary of one profile projection stage execution. */
export interface DreamProjectSummary {
  profileDurableCount: number;
  directiveCount: number;
  snapshotId: string | null;
  applied: boolean;
}

/** Structured summary of one deterministic prune stage execution. */
export interface DreamPruneSummary {
  durablesScanned: number;
  candidatesIdentified: number;
  candidatesProtected: number;
  candidatesRetirable: number;
  durablesRetired: number;
  dryRun: boolean;
}

/** Compute-efficiency counters emitted for eval scoreboard reporting. */
export interface DreamEfficiencySummary {
  evidenceItemsRead: number;
  synthesizedDurableMutations: number;
  costPerSynthesizedDurableUsd: number | null;
  profileInjectionTokenEstimate: number;
  recomputeRatio: number;
}

/** Scan delta describing unsynthesized evidence since the last successful run. */
export interface DreamScanSummary {
  episodesSinceLastRun: number;
  ingestFilesSinceLastRun: number;
  durablesCreatedSinceLastRun: number;
  evidenceRefs: DreamEvidenceRef[];
  unsynthesizedImportanceSum: number;
}

/** Minimal persisted completion summary for a dreaming run. */
export interface DreamCompletionSummary {
  actions_taken: number;
  /** True when an apply run intentionally skipped the pre-apply database backup. */
  backupSkipped?: boolean;
  /** Pipeline stages intentionally skipped by tier policy. */
  stages_skipped?: DreamStageSkipSummary[];
  durables_skipped: Array<{
    durable_id?: string;
    reason: string;
  }>;
  observations: string[];
  recommendations: string[];
  scan?: DreamScanSummary;
  extract?: DreamExtractSummary;
  reconcile?: ReconcilePassSummary;
  temporalize?: DreamTemporalizeSummary;
  project?: DreamProjectSummary;
  prune?: DreamPruneSummary;
  efficiency?: DreamEfficiencySummary;
}
