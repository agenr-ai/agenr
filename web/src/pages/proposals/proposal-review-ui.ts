import { isClaimKeyAliasConvergenceProposal, type DreamProposal } from "../../api/types";

export const PROPOSAL_ISSUE_FILTERS = [
  { value: "", label: "All issue kinds" },
  { value: "claim_key_alias_convergence", label: "Claim-Key Alias Convergence" },
  { value: "entity_family_convergence", label: "Entity Family Convergence" },
  { value: "mixed_claim_key_group", label: "Mixed Claim-Key Group" },
  { value: "missing_claim_key", label: "Missing Claim Key" },
  { value: "suspect_canonical_claim_key", label: "Suspect Canonical Claim Key" },
  { value: "noncanonical_claim_key", label: "Noncanonical Claim Key" },
  { value: "malformed_claim_key", label: "Malformed Claim Key" },
] as const;

/** Operator hint when apply is blocked for an ineligible proposal. */
export function formatIneligibleProposalHint(proposal: Pick<DreamProposal, "issueKind">): string {
  if (isClaimKeyAliasConvergenceProposal(proposal)) {
    return "Apply is blocked because this alias cluster is ambiguous, conflicting, or not LLM-confirmed.";
  }
  return "This proposal is not eligible to apply and can only be rejected.";
}
