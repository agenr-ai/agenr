/**
 * Structured claim-key health snapshot captured before or after one pass.
 */
export interface ClaimKeyHealthSnapshot {
  totalEntries: number;
  activeEntries: number;
  coverageCount: number;
  coveragePct: number;
  missingCount: number;
  eligibleMissingCount: number;
  malformedOrNoncanonicalCount: number;
  suspectCanonicalCount: number;
  entityFamilyGroupCount: number;
  mixedGroupCount: number;
  exactKeyMultiActiveClusterCount: number;
}

/**
 * Aggregate repair counts captured during one claim-key-quality run.
 */
export interface ClaimKeyQualityRepairCounts {
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
  skippedAmbiguous: number;
}

/**
 * Structured claim-key-quality pass summary persisted on the surgeon run.
 */
export interface ClaimKeyQualityPassSummary {
  executionStyle: "autonomous" | "targeted";
  workingSet: {
    includeInactive: boolean;
    project: string | null;
    type: string | null;
    claimKeyPrefix: string | null;
    entryIds: string[];
  };
  before: ClaimKeyHealthSnapshot;
  after: ClaimKeyHealthSnapshot;
  projectedAfter?: ClaimKeyHealthSnapshot;
  counts: ClaimKeyQualityRepairCounts;
  circuitBreaker?: {
    kind: string;
    message: string;
  } | null;
}

/**
 * Structured unresolved claim-key proposal persisted for later adjudication.
 */
export interface SurgeonRunProposal {
  id: string;
  runId: string;
  groupId: string;
  issueKind: string;
  scope: "single_entry" | "cluster";
  entryIds: string[];
  currentClaimKeys: string[];
  proposedClaimKeys: string[];
  rationale: string;
  confidence: number;
  source: string;
  eligibleForApply: boolean;
  createdAt: string;
}

/**
 * Lifecycle states for one surgeon run.
 */
export type SurgeonRunStatus = "running" | "completed" | "failed" | "aborted" | "budget_exhausted" | "cost_capped";

/**
 * Minimal persisted completion summary for a surgeon run.
 */
export interface SurgeonCompletionSummary {
  actions_taken: number;
  entries_skipped: Array<{
    entry_id?: string;
    reason: string;
  }>;
  observations: string[];
  recommendations: string[];
  claim_key_quality?: ClaimKeyQualityPassSummary;
}
