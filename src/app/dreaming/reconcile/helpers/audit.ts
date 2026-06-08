import { buildClaimKeyLifecycleAuditDetails, buildReconcileProposalClaimKeyAuditDetails } from "../../../../core/claim-key-lifecycle.js";
import type { ClaimKeyCompactnessEvaluation } from "../../../../core/claim-key-support.js";
import type { DreamRunProposal } from "../../../../core/dreaming/types.js";
import type { ProposalClaimKeyLifecycleMetadata } from "../../../../core/claim-key-lifecycle.js";
import type {
  AppliedClaimKeyActionInput,
  ClaimKeyAliasConvergenceAudit,
  EntityFamilyConvergenceAudit,
  MissingBackfillShadowAudit,
  MissingBackfillSupportEvaluation,
  ProposalAuditInput,
} from "../types.js";

/** Builds audit fields that explain missing-key support evidence. */
export function buildMissingBackfillSupportAuditDetails(support?: MissingBackfillSupportEvaluation): Record<string, unknown> {
  if (!support?.supportedProposal) {
    return support?.autoApplyClass
      ? {
          support_class: support.autoApplyClass,
        }
      : {};
  }

  return {
    support_evidence: [...support.supportEvidence],
    supporting_durable_ids: [...support.supportingDurableIds],
    support_family_reuse_count: support.familyReuseCount,
    support_grounded_family_reuse_count: support.groundedFamilyReuseCount,
    support_sibling_slot_resonance_applicable: support.siblingSlotResonance.applicable,
    support_sibling_slot_resonance_fired: support.siblingSlotResonance.fired,
    support_sibling_slot_resonance_resonant_sibling_count: support.siblingSlotResonance.resonantSiblingCount,
    support_sibling_slot_resonance_dominant_shape: support.siblingSlotResonance.dominantShape,
    support_sibling_slot_resonance_dominant_shape_count: support.siblingSlotResonance.dominantShapeCount,
    support_sibling_slot_resonance_grounded_share: support.siblingSlotResonance.dominantShapeGroundedShare,
    support_sibling_slot_resonance_local_shape_coverage: support.siblingSlotResonance.localShapeTokenCoverage,
    support_sibling_slot_resonance_family_generic_tokens: [...support.siblingSlotResonance.familyGenericTokens],
    support_sibling_slot_resonance_discriminative_candidate_tokens: [...support.siblingSlotResonance.discriminativeCandidateTokens],
    support_sibling_slot_resonance_sibling_durable_ids: [...support.siblingSlotResonance.dominantSiblingDurableIds],
    support_sibling_slot_resonance_sibling_claim_keys: [...support.siblingSlotResonance.dominantSiblingClaimKeys],
    ...(support.strongEntityAttributeLexicalAlignment
      ? {
          support_strong_entity_attribute_lexical_alignment: true,
        }
      : {}),
    ...(support.autoApplyClass
      ? {
          support_class: support.autoApplyClass,
        }
      : {}),
    ...(support.relaxedStableSlotFamilyGate
      ? {
          support_relaxed_stable_slot_family_gate: true,
        }
      : {}),
  };
}

/** Builds audit details for an applied claim-key reconcile action. */
export function buildAppliedClaimKeyActionDetails(input: AppliedClaimKeyActionInput): Record<string, unknown> {
  return {
    issue_kind: input.issueKind,
    old_claim_key: input.oldClaimKey,
    new_claim_key: input.newClaimKey,
    ...buildClaimKeyLifecycleAuditDetails(input.lifecycle),
    proposal_source: input.proposalSource,
    confidence: input.confidence,
    auto_apply_threshold: input.promotion?.autoApplyThreshold,
    auto_applied: true,
    promotion_lane: input.promotion?.lane,
    supported_auto_apply: input.support?.autoApplyClass !== null,
    ...buildMissingBackfillSupportAuditDetails(input.support),
    ...buildMissingBackfillShadowAuditDetails(input.shadow),
    ...buildClaimKeyCompactionAuditDetails(input.compactness),
    ...buildEntityFamilyAuditDetails(input.entityFamilyAudit),
    ...buildClaimKeyAliasAuditDetails(input.aliasConvergenceAudit),
  };
}

/** Builds audit details for a staged claim-key reconcile proposal. */
export function buildProposalClaimKeyActionDetails(proposal: DreamRunProposal, audit?: ProposalAuditInput): Record<string, unknown> {
  return {
    proposal_id: proposal.id,
    group_id: proposal.groupId,
    issue_kind: proposal.issueKind,
    current_claim_keys: proposal.currentClaimKeys,
    proposed_claim_keys: proposal.proposedClaimKeys,
    confidence: proposal.confidence,
    proposal_source: proposal.source,
    auto_apply_threshold: audit?.promotion?.autoApplyThreshold,
    auto_applied: false,
    promotion_lane: audit?.promotion?.lane,
    eligible_for_apply: proposal.eligibleForApply,
    supported_candidate: audit?.supportedCandidate === true,
    ...buildReconcileProposalClaimKeyAuditDetails(audit?.proposalLifecycle),
    ...buildMissingBackfillSupportAuditDetails(audit?.support),
    ...buildMissingBackfillShadowAuditDetails(audit?.shadow),
    ...buildClaimKeyCompactionAuditDetails(audit?.compactness),
    ...(audit?.autoApplyBlocker
      ? {
          auto_apply_blocker: audit.autoApplyBlocker,
        }
      : {}),
    ...buildEntityFamilyAuditDetails(audit?.entityFamilyAudit),
    ...buildClaimKeyAliasAuditDetails(audit?.aliasConvergenceAudit),
  };
}

/** Builds audit fields for shadow-only missing-key qualification. */
export function buildMissingBackfillShadowAuditDetails(shadow?: MissingBackfillShadowAudit): Record<string, unknown> {
  if (!shadow) {
    return {};
  }

  return {
    shadow_threshold_only_bucket: shadow.thresholdOnlyBucket,
    shadow_would_qualify: shadow.shadowWouldQualify,
  };
}

/** Builds audit fields for claim-key compact canonicalization. */
export function buildClaimKeyCompactionAuditDetails(compactness?: ClaimKeyCompactnessEvaluation): Record<string, unknown> {
  return compactness?.compactedFrom
    ? {
        claim_key_compacted_from: compactness.compactedFrom,
        claim_key_compaction_reason: compactness.compactionReason,
      }
    : {};
}

/** Builds audit fields for entity-family convergence decisions. */
export function buildEntityFamilyAuditDetails(entityFamilyAudit?: EntityFamilyConvergenceAudit): Record<string, unknown> {
  return entityFamilyAudit
    ? {
        competing_entity_prefixes: [...entityFamilyAudit.competingEntityPrefixes],
        canonical_entity_prefix: entityFamilyAudit.canonicalEntityPrefix,
        canonical_selection_reasons: [...entityFamilyAudit.canonicalSelectionReasons],
        entity_family_unresolved_reason: entityFamilyAudit.unresolvedReason,
        entity_family_evidence: entityFamilyAudit.evidence.map((evidence) => ({ ...evidence })),
        entity_family_pair_support: entityFamilyAudit.pairSupport.map((support) => ({
          ...support,
          entityPrefixes: [...support.entityPrefixes],
          supportingDurableIds: [...support.supportingDurableIds],
          sharedAttributes: [...support.sharedAttributes],
          evidence: support.evidence.map((evidence) => ({ ...evidence })),
        })),
      }
    : {};
}

/** Builds audit fields for same-entity claim-key alias convergence decisions. */
export function buildClaimKeyAliasAuditDetails(aliasAudit?: ClaimKeyAliasConvergenceAudit): Record<string, unknown> {
  return aliasAudit
    ? {
        alias_entity_prefix: aliasAudit.entityPrefix,
        alias_current_claim_keys: [...aliasAudit.currentClaimKeys],
        alias_proposed_claim_key: aliasAudit.proposedClaimKey,
        alias_deterministic_confidence: aliasAudit.deterministicConfidence,
        alias_deterministic_auto_apply_eligible: aliasAudit.deterministicAutoApplyEligible,
        alias_unresolved_reason: aliasAudit.unresolvedReason,
        alias_llm_same_slot: aliasAudit.llmAdjudication?.sameSlot,
        alias_llm_canonical_claim_key: aliasAudit.llmAdjudication?.canonicalClaimKey,
        alias_llm_confidence: aliasAudit.llmAdjudication?.confidence,
        alias_llm_rationale: aliasAudit.llmAdjudication?.rationale,
        alias_evidence: aliasAudit.evidence.map((evidence) => ({ ...evidence })),
        alias_key_profiles: aliasAudit.keyProfiles.map((profile) => ({
          ...profile,
          durableIds: [...profile.durableIds],
          typeSet: [...profile.typeSet],
          projectSet: [...profile.projectSet],
        })),
      }
    : {};
}

export type { ProposalClaimKeyLifecycleMetadata };
