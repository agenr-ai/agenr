import { buildClaimKeyLifecycleAuditDetails, buildReconcileProposalClaimKeyAuditDetails } from "../../../../core/claim-key-lifecycle.js";
import type { ClaimKeyCompactnessEvaluation } from "../../../../core/claim-key-support.js";
import type { DreamRunProposal } from "../../../../core/dreaming/types.js";
import type { ProposalClaimKeyLifecycleMetadata } from "../../../../core/claim-key-lifecycle.js";
import type {
  AppliedClaimKeyActionInput,
  EntityFamilyConvergenceAudit,
  MissingBackfillShadowAudit,
  MissingBackfillSupportEvaluation,
  ProposalAuditInput,
} from "../types.js";

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
    support_sibling_slot_resonance_sibling_durable_ids: [...support.siblingSlotResonance.dominantSiblingEntryIds],
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
  };
}

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
  };
}

export function buildMissingBackfillShadowAuditDetails(shadow?: MissingBackfillShadowAudit): Record<string, unknown> {
  if (!shadow) {
    return {};
  }

  return {
    shadow_threshold_only_bucket: shadow.thresholdOnlyBucket,
    shadow_would_qualify: shadow.shadowWouldQualify,
  };
}

export function buildClaimKeyCompactionAuditDetails(compactness?: ClaimKeyCompactnessEvaluation): Record<string, unknown> {
  return compactness?.compactedFrom
    ? {
        claim_key_compacted_from: compactness.compactedFrom,
        claim_key_compaction_reason: compactness.compactionReason,
      }
    : {};
}

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

export type { ProposalClaimKeyLifecycleMetadata };
