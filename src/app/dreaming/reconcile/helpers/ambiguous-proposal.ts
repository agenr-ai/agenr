import type { ReconcileIssueKind } from "../types/mutation-types.js";

/**
 * Returns whether one reconcile proposal should increment ambiguous-proposal telemetry.
 *
 * Collision and mixed-group proposals stay out of the ambiguous bucket by default.
 *
 * @param issueKind - Closed reconcile issue kind for the proposal.
 * @returns True when the proposal should increment flaggedAmbiguousProposals.
 */
export function defaultFlagAmbiguousProposal(issueKind: ReconcileIssueKind): boolean {
  switch (issueKind) {
    case "mixed_claim_key_group":
    case "noncanonical_claim_key":
      return false;
    default:
      return true;
  }
}

/**
 * Resolves ambiguous telemetry for one proposal, honoring explicit overrides.
 *
 * @param issueKind - Closed reconcile issue kind for the proposal.
 * @param override - Optional explicit override from the caller.
 * @returns Whether flaggedAmbiguousProposals should increment for this proposal.
 */
export function resolveFlagAmbiguousProposal(issueKind: ReconcileIssueKind, override?: boolean): boolean {
  return override ?? defaultFlagAmbiguousProposal(issueKind);
}
