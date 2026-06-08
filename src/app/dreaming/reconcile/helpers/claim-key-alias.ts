import type { ClaimKeyAliasCandidate } from "../../../../core/claim-key-alias.js";
import type { ClaimKeyAliasAdjudication } from "../../../../core/dreaming/claim-key-alias-adjudication.js";
import type { ClaimKeyAliasConvergenceAudit } from "../types.js";

/** Builds persisted audit data for a same-entity claim-key alias candidate. */
export function buildClaimKeyAliasConvergenceAudit(
  candidate: ClaimKeyAliasCandidate,
  adjudication: ClaimKeyAliasAdjudication | null,
): ClaimKeyAliasConvergenceAudit {
  return {
    entityPrefix: candidate.entityPrefix,
    currentClaimKeys: [...candidate.claimKeys],
    proposedClaimKey: candidate.proposedClaimKey,
    deterministicConfidence: candidate.confidence,
    deterministicAutoApplyEligible: candidate.deterministicAutoApplyEligible,
    unresolvedReason: candidate.unresolvedReason,
    llmAdjudication: adjudication,
    evidence: candidate.evidence.map((evidence) => ({ ...evidence })),
    keyProfiles: candidate.keyProfiles.map((profile) => ({
      ...profile,
      durableIds: [...profile.durableIds],
      typeSet: [...profile.typeSet],
      projectSet: [...profile.projectSet],
    })),
  };
}
