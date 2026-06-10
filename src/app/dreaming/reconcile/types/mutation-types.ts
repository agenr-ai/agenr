import type { ClaimKeyCompactnessEvaluation } from "../../../../core/claim-key-support.js";
import type { ProposalClaimKeyLifecycleMetadata, ResolvedClaimKeyLifecycle } from "../../../../core/claim-key-lifecycle.js";
import type { DreamRunProposal } from "../../../../core/dreaming/types.js";
import type { Durable } from "../../../../core/types.js";
import type {
  ClaimKeyAliasConvergenceAudit,
  EntityFamilyConvergenceAudit,
  MissingBackfillPromotionPolicy,
  MissingBackfillShadowAudit,
  MissingBackfillSupportEvaluation,
} from "./stats-types.js";

/** Closed set of reconcile issue kinds used for claim-key mutations and proposals. */
export type ReconcileIssueKind =
  | "missing_claim_key"
  | "malformed_claim_key"
  | "noncanonical_claim_key"
  | "suspect_canonical_claim_key"
  | "entity_family_convergence"
  | "claim_key_alias_convergence"
  | "duplicate_slot_collapse"
  | "mixed_claim_key_group";

/** Snapshot of durable claim-key lifecycle fields before a projected mutation. */
export interface ClaimKeyLifecycleSnapshot {
  claimKey: Durable["claim_key"];
  claimKeyRaw: Durable["claim_key_raw"];
  claimKeyStatus: Durable["claim_key_status"];
  claimKeySource: Durable["claim_key_source"];
  claimKeyConfidence: Durable["claim_key_confidence"];
  claimKeyRationale: Durable["claim_key_rationale"];
}

/** Input required to apply one claim-key reconcile update. */
export interface ClaimKeyUpdateInput {
  issueKind: ReconcileIssueKind;
  oldClaimKey: string | null;
  source: string;
  confidence: number;
  support?: MissingBackfillSupportEvaluation;
  compactness?: ClaimKeyCompactnessEvaluation;
  promotion?: MissingBackfillPromotionPolicy;
  shadow?: MissingBackfillShadowAudit;
  rationale: string;
  rawClaimKey?: string | null;
  entityFamilyAudit?: EntityFamilyConvergenceAudit;
  aliasConvergenceAudit?: ClaimKeyAliasConvergenceAudit;
}

/** Optional audit metadata attached to one reconcile proposal. */
export interface ProposalAuditInput {
  autoApplyBlocker?: string | null;
  compactness?: ClaimKeyCompactnessEvaluation;
  promotion?: MissingBackfillPromotionPolicy;
  support?: MissingBackfillSupportEvaluation;
  supportedCandidate?: boolean;
  shadow?: MissingBackfillShadowAudit;
  entityFamilyAudit?: EntityFamilyConvergenceAudit;
  aliasConvergenceAudit?: ClaimKeyAliasConvergenceAudit;
  proposalLifecycle?: ProposalClaimKeyLifecycleMetadata;
}

/** Audit metadata for one claim-key reconcile update that was applied. */
export interface AppliedClaimKeyActionInput {
  issueKind: ReconcileIssueKind;
  oldClaimKey: string | null;
  newClaimKey: string;
  proposalSource: string;
  confidence: number;
  lifecycle: ResolvedClaimKeyLifecycle;
  promotion?: MissingBackfillPromotionPolicy;
  support?: MissingBackfillSupportEvaluation;
  shadow?: MissingBackfillShadowAudit;
  compactness?: ClaimKeyCompactnessEvaluation;
  entityFamilyAudit?: EntityFamilyConvergenceAudit;
  aliasConvergenceAudit?: ClaimKeyAliasConvergenceAudit;
}

/**
 * Lifecycle metadata used when persisting one reconcile proposal.
 */
export interface ReconcileProposalLifecycleInput {
  proposedClaimKeys: string[];
  source: string;
  rawClaimKey?: string | null;
  compactness?: ClaimKeyCompactnessEvaluation;
  support?: MissingBackfillSupportEvaluation;
}

/**
 * Shared input for persisting one reconcile proposal and its review action.
 */
export interface PersistReconcileProposalInput {
  groupId: string;
  issueKind: ReconcileIssueKind;
  scope: DreamRunProposal["scope"];
  durableIds: string[];
  currentClaimKeys: string[];
  proposedClaimKeys: string[];
  rationale: string;
  confidence: number;
  source: string;
  eligibleForApply: boolean;
  lifecycle: ReconcileProposalLifecycleInput;
  audit?: ProposalAuditInput;
  /** Overrides whether this proposal increments flaggedAmbiguousProposals. Defaults from issueKind. */
  flagAmbiguousProposal?: boolean;
}
