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

/** Manual settlement choices accepted for proposals without a safe direct apply target. */
export type ManualProposalSettlementChoice = "separate" | "canonical" | "retire";

const SINGLE_DURABLE_CLAIM_KEY_REPAIR_ISSUE_KINDS = new Set([
  "missing_claim_key",
  "suspect_canonical_claim_key",
  "noncanonical_claim_key",
  "malformed_claim_key",
]);

const MANUAL_SETTLEMENT_ISSUE_KINDS = new Set([
  "mixed_claim_key_group",
  "entity_family_convergence",
  "claim_key_alias_convergence",
  ...SINGLE_DURABLE_CLAIM_KEY_REPAIR_ISSUE_KINDS,
]);

/**
 * Returns whether an open proposal can be settled by an explicit operator decision.
 *
 * @param proposal - Proposal under review.
 * @returns True when the issue kind has no safe apply target but can be closed manually.
 */
export function isManualProposalSettlementEligible(proposal: Pick<DreamRunProposal, "issueKind" | "eligibleForApply">): boolean {
  return !proposal.eligibleForApply && MANUAL_SETTLEMENT_ISSUE_KINDS.has(proposal.issueKind);
}

/**
 * Returns whether a proposal describes one durable with claim-key metadata that needs operator repair.
 *
 * @param proposal - Proposal under review.
 * @returns True when the issue can be fixed by writing a manual key to the affected durable.
 */
export function isSingleDurableClaimKeyRepairProposal(proposal: Pick<DreamRunProposal, "issueKind">): boolean {
  return SINGLE_DURABLE_CLAIM_KEY_REPAIR_ISSUE_KINDS.has(proposal.issueKind);
}

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
 * Builds the persisted review reason for one manual proposal settlement.
 *
 * @param issueKind - Proposal issue kind being settled.
 * @param choice - Operator settlement choice.
 * @param note - Optional operator note appended after the canonical sentence.
 * @param targetClaimKey - Canonical key written when choice is `canonical`.
 * @param retireCount - Number of durables retired when choice is `retire`.
 * @returns Full settlement reason stored on the proposal review record.
 */
export function buildManualProposalSettlementReason(
  issueKind: string,
  choice: ManualProposalSettlementChoice,
  note: string,
  targetClaimKey: string,
  retireCount: number,
): string {
  const suffix = note.trim().length > 0 ? ` Note: ${note.trim()}` : "";
  const label = formatManualSettlementIssueKind(issueKind);
  if (choice === "canonical") {
    return `Resolved ${label} manually by writing canonical key "${targetClaimKey}".${suffix}`;
  }
  if (choice === "retire") {
    return `Resolved ${label} manually by retiring ${retireCount} duplicate or wrong durable${retireCount === 1 ? "" : "s"}.${suffix}`;
  }
  if (SINGLE_DURABLE_CLAIM_KEY_REPAIR_ISSUE_KINDS.has(issueKind)) {
    return `Resolved ${label} manually by keeping claim-key metadata unchanged.${suffix}`;
  }
  return `Resolved ${label} manually by keeping the affected durables under separate claim keys.${suffix}`;
}

/**
 * Formats a proposal issue kind for persisted manual settlement reasons.
 *
 * @param issueKind - Proposal issue kind stored on the proposal.
 * @returns Human-readable issue label.
 */
function formatManualSettlementIssueKind(issueKind: string): string {
  switch (issueKind) {
    case "claim_key_alias_convergence":
      return "claim-key alias convergence";
    case "entity_family_convergence":
      return "entity-family convergence";
    case "mixed_claim_key_group":
      return "mixed claim-key group";
    case "malformed_claim_key":
      return "malformed claim key";
    case "missing_claim_key":
      return "missing claim key";
    case "noncanonical_claim_key":
      return "noncanonical claim key";
    case "suspect_canonical_claim_key":
      return "suspect canonical claim key";
    default:
      return issueKind.replaceAll("_", " ");
  }
}
