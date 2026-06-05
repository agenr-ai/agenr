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
