import type { DreamRunProposal } from "../types.js";

/**
 * Stable logical-issue identity used to deduplicate open dreaming proposals.
 */
export interface DreamProposalIssueIdentity {
  groupId: string;
  issueKind: string;
}

/**
 * Normalizes one proposal logical-issue identity.
 *
 * @param input - Raw group and issue identifiers.
 * @returns Trimmed logical-issue identity.
 */
export function normalizeDreamProposalIssueIdentity(input: DreamProposalIssueIdentity): DreamProposalIssueIdentity {
  return {
    groupId: input.groupId.trim(),
    issueKind: input.issueKind.trim(),
  };
}

/**
 * Builds the persisted rationale used when a dreaming proposal is approved.
 *
 * @param proposal - Proposal being reviewed.
 * @param reviewReason - Operator or workflow review note.
 * @returns Durable rationale string used for persistence and audit logs.
 */
export function buildDreamProposalReviewReason(proposal: Pick<DreamRunProposal, "id" | "rationale">, reviewReason: string): string {
  return `Approved dreaming proposal ${proposal.id}: ${proposal.rationale} Review note: ${reviewReason}`.trim();
}

/**
 * Resolves the single safe direct-apply target for one dreaming proposal.
 *
 * @param proposal - Proposal selected for automatic or operator-driven apply.
 * @returns Stable claim key that should be written to the target entries.
 */
export function resolveDreamProposalApplyTarget(proposal: Pick<DreamRunProposal, "id" | "eligibleForApply" | "proposedClaimKeys">): string {
  if (!proposal.eligibleForApply) {
    throw new Error(`Proposal ${proposal.id} is reviewable but not eligible for direct apply.`);
  }
  if (proposal.proposedClaimKeys.length !== 1) {
    throw new Error(`Proposal ${proposal.id} cannot be applied automatically because it does not resolve to exactly one proposed claim key.`);
  }

  const targetClaimKey = proposal.proposedClaimKeys[0]?.trim();
  if (!targetClaimKey) {
    throw new Error(`Proposal ${proposal.id} is missing a valid proposed claim key.`);
  }

  return targetClaimKey;
}

/**
 * Returns whether a proposal requires manual operator settlement for a mixed-key group.
 *
 * @param proposal - Proposal under review.
 * @returns True when the proposal has conflicting keys and no safe direct target.
 */
export function isManualMixedClaimKeyProposal(proposal: Pick<DreamRunProposal, "issueKind" | "eligibleForApply" | "proposedClaimKeys">): boolean {
  return proposal.issueKind === "mixed_claim_key_group" && !proposal.eligibleForApply && proposal.proposedClaimKeys.length === 0;
}

/** Manual settlement choices accepted for mixed-key proposals. */
export type ManualMixedSettlementChoice = "separate" | "canonical" | "retire";

/**
 * Returns whether a proposal is a same-entity claim-key alias convergence cluster.
 *
 * @param proposal - Proposal under review.
 * @returns True when the proposal issue kind is alias convergence.
 */
export function isClaimKeyAliasConvergenceProposal(proposal: Pick<DreamRunProposal, "issueKind">): boolean {
  return proposal.issueKind === "claim_key_alias_convergence";
}

/**
 * Builds the persisted review reason for one manual mixed-key settlement.
 *
 * @param choice - Operator settlement choice.
 * @param note - Optional operator note appended after the canonical sentence.
 * @param targetClaimKey - Canonical key written when choice is `canonical`.
 * @param retireCount - Number of durables retired when choice is `retire`.
 * @returns Full settlement reason stored on the proposal review record.
 */
export function buildMixedClaimKeySettlementReason(choice: ManualMixedSettlementChoice, note: string, targetClaimKey: string, retireCount: number): string {
  const suffix = note.trim().length > 0 ? ` Note: ${note.trim()}` : "";
  if (choice === "canonical") {
    return `Resolved mixed claim-key group manually by writing canonical key "${targetClaimKey}".${suffix}`;
  }
  if (choice === "retire") {
    return `Resolved mixed claim-key group manually by retiring ${retireCount} duplicate or wrong durable${retireCount === 1 ? "" : "s"}.${suffix}`;
  }
  return `Resolved mixed claim-key group manually by keeping the affected durables under separate claim keys.${suffix}`;
}
