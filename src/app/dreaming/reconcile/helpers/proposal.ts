import { randomUUID } from "node:crypto";

import { describeClaimKeyNormalizationFailure } from "../../../../core/claim-key.js";
import type { ClaimKeyInspection } from "../../../../core/claim-key.js";
import type { ClaimKeyAliasCandidate } from "../../../../core/claim-key-alias.js";
import type { ClaimKeyEntityFamilyCandidate } from "../../../../core/claim-key-entity-family.js";
import type { DreamRunProposal } from "../../../../core/dreaming/types.js";
import type { Durable } from "../../../../core/types.js";
import type { PersistReconcileProposalInput, ProposalAuditInput } from "../types/mutation-types.js";
import type { DurableSuggestionRecord, EntityFamilyConvergenceAudit, TrustedGroupReuseCandidate } from "../types.js";
import type { ClaimKeyAliasConvergenceAudit } from "../types.js";
import type { MissingBackfillResolvedPreview } from "./missing-backfill.js";
import { normalizeStringArray } from "./utils.js";

/** Creates a reconcile proposal with normalized key arrays and open review state. */
export function createProposal(input: Omit<DreamRunProposal, "id" | "reviewStatus" | "reviewedAt" | "reviewReason" | "appliedActionCount">): DreamRunProposal {
  return {
    id: randomUUID(),
    ...input,
    durableIds: normalizeStringArray(input.durableIds),
    currentClaimKeys: normalizeStringArray(input.currentClaimKeys),
    proposedClaimKeys: normalizeStringArray(input.proposedClaimKeys),
    reviewStatus: "open",
    reviewedAt: null,
    reviewReason: null,
    appliedActionCount: 0,
  };
}

/**
 * Builds shared reconcile proposal input for one malformed claim key.
 *
 * @param durable - Durable under review.
 * @param inspection - Malformed inspection outcome.
 * @param suggestionRecord - Optional claim-extraction preview used for proposal candidates.
 * @returns Proposal payload for `persistReconcileProposal`.
 */
export function buildMalformedClaimKeyPersistInput(
  durable: Durable,
  inspection: { kind: "malformed"; inspection: ClaimKeyInspection },
  suggestionRecord: DurableSuggestionRecord,
): PersistReconcileProposalInput {
  const proposedClaimKeys = suggestionRecord.suggestion?.claimKey ? [suggestionRecord.suggestion.claimKey] : [];
  const source = suggestionRecord.suggestion?.path ?? "normalize";

  return {
    groupId: `claim-key-malformed:${durable.id}`,
    issueKind: "malformed_claim_key",
    scope: "single_durable",
    durableIds: [durable.id],
    currentClaimKeys: durable.claim_key ? [durable.claim_key] : [],
    proposedClaimKeys,
    rationale:
      `Stored claim key "${durable.claim_key}" is malformed because ${describeClaimKeyNormalizationFailure(inspection.inspection.normalizationFailure ?? "missing_separator")}.` +
      (suggestionRecord.suggestion?.claimKey
        ? ` Claim extraction preview suggested "${suggestionRecord.suggestion.claimKey}" at confidence ${suggestionRecord.suggestion.confidence.toFixed(2)}.`
        : ""),
    confidence: suggestionRecord.suggestion?.confidence ?? 0.5,
    source,
    eligibleForApply: proposedClaimKeys.length > 0,
    lifecycle: {
      proposedClaimKeys,
      source,
      rawClaimKey: durable.claim_key ?? null,
    },
  };
}

/**
 * Builds shared reconcile proposal input for one trusted-group reuse collision.
 *
 * @param durable - Durable under review.
 * @param trustedGroupReuse - Trusted canonical key reused from a matched subject/type group.
 * @returns Proposal payload for `persistReconcileProposal`.
 */
export function buildTrustedGroupReusePersistInput(durable: Durable, trustedGroupReuse: TrustedGroupReuseCandidate): PersistReconcileProposalInput {
  return {
    groupId: `claim-key-backfill:${durable.id}`,
    issueKind: "missing_claim_key",
    scope: "single_durable",
    durableIds: [durable.id],
    currentClaimKeys: [],
    proposedClaimKeys: [trustedGroupReuse.claimKey],
    rationale:
      `A matched subject/type group already uses trusted canonical key "${trustedGroupReuse.claimKey}" ` +
      `across ${trustedGroupReuse.supportingDurableIds.length} supporting durable${trustedGroupReuse.supportingDurableIds.length === 1 ? "" : "s"}, ` +
      "but that same key is already occupied by a different active durable type in the matched working set.",
    confidence: 0.99,
    source: "trusted_group_reuse",
    eligibleForApply: true,
    lifecycle: {
      proposedClaimKeys: [trustedGroupReuse.claimKey],
      source: "trusted_group_reuse",
    },
  };
}

/**
 * Builds shared reconcile proposal input for one missing-key backfill proposal.
 *
 * @param durable - Durable under review.
 * @param resolved - Resolved preview metadata for the backfill candidate.
 * @param input - Rationale, durable scope, and audit metadata.
 * @returns Proposal payload for `persistReconcileProposal`.
 */
export function buildMissingBackfillPersistInput(
  durable: Durable,
  resolved: MissingBackfillResolvedPreview,
  input: {
    rationale: string;
    durableIds: string[];
    audit: ProposalAuditInput;
  },
): PersistReconcileProposalInput {
  return {
    groupId: `claim-key-backfill:${durable.id}`,
    issueKind: "missing_claim_key",
    scope: "single_durable",
    durableIds: input.durableIds,
    currentClaimKeys: [],
    proposedClaimKeys: [resolved.targetClaimKey],
    rationale: input.rationale,
    confidence: resolved.suggestion.confidence,
    source: resolved.targetSource,
    eligibleForApply: true,
    lifecycle: {
      proposedClaimKeys: [resolved.targetClaimKey],
      source: resolved.targetSource,
      rawClaimKey: resolved.originalClaimKey,
      compactness: resolved.compactness,
      support: resolved.support,
    },
    audit: {
      compactness: resolved.compactness,
      promotion: resolved.promotionPolicy,
      support: resolved.support,
      supportedCandidate: resolved.support.supportedProposal,
      ...input.audit,
    },
  };
}

/**
 * Builds shared reconcile proposal input for one entity-family convergence cluster.
 *
 * @param candidate - Detected entity-family convergence candidate.
 * @param input - Proposal fields and audit metadata.
 * @returns Proposal payload for `persistReconcileProposal`.
 */
export function buildEntityFamilyPersistInput(
  candidate: ClaimKeyEntityFamilyCandidate,
  input: {
    audit: EntityFamilyConvergenceAudit;
    proposedClaimKeys: string[];
    durableIds: string[];
    rationale: string;
    source: string;
    eligibleForApply: boolean;
    auditExtras?: ProposalAuditInput;
  },
): PersistReconcileProposalInput {
  return {
    groupId: `claim-key-entity-family:${candidate.entityPrefixes.join(",")}`,
    issueKind: "entity_family_convergence",
    scope: "cluster",
    durableIds: input.durableIds,
    currentClaimKeys: candidate.claimKeys,
    proposedClaimKeys: input.proposedClaimKeys,
    rationale: input.rationale,
    confidence: candidate.confidence,
    source: input.source,
    eligibleForApply: input.eligibleForApply,
    lifecycle: {
      proposedClaimKeys: input.proposedClaimKeys,
      source: input.source,
    },
    audit: {
      entityFamilyAudit: input.audit,
      ...input.auditExtras,
    },
  };
}

/**
 * Builds shared reconcile proposal input for one same-entity claim-key alias cluster.
 *
 * @param candidate - Detected same-entity alias candidate.
 * @param input - Proposal fields and audit metadata.
 * @returns Proposal payload for `persistReconcileProposal`.
 */
export function buildClaimKeyAliasPersistInput(
  candidate: ClaimKeyAliasCandidate,
  input: {
    audit: ClaimKeyAliasConvergenceAudit;
    proposedClaimKeys: string[];
    durableIds: string[];
    rationale: string;
    source: string;
    eligibleForApply: boolean;
    autoApplyBlocker?: string | null;
  },
): PersistReconcileProposalInput {
  return {
    groupId: `claim-key-alias:${candidate.claimKeys.join(",")}`,
    issueKind: "claim_key_alias_convergence",
    scope: "cluster",
    durableIds: input.durableIds,
    currentClaimKeys: candidate.claimKeys,
    proposedClaimKeys: input.proposedClaimKeys,
    rationale: input.rationale,
    confidence: candidate.confidence,
    source: input.source,
    eligibleForApply: input.eligibleForApply,
    lifecycle: {
      proposedClaimKeys: input.proposedClaimKeys,
      source: input.source,
    },
    audit: {
      aliasConvergenceAudit: input.audit,
      ...(input.autoApplyBlocker ? { autoApplyBlocker: input.autoApplyBlocker } : {}),
    },
  };
}
