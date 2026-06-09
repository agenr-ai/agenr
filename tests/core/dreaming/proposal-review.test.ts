import { describe, expect, it } from "vitest";

import {
  buildManualProposalSettlementReason,
  isClaimKeyAliasConvergenceProposal,
  isManualProposalSettlementEligible,
} from "../../../src/core/dreaming/domain/proposal-review.js";

describe("proposal review domain helpers", () => {
  it("detects proposals eligible for manual settlement", () => {
    expect(
      isManualProposalSettlementEligible({
        issueKind: "mixed_claim_key_group",
        eligibleForApply: false,
      }),
    ).toBe(true);
    expect(
      isManualProposalSettlementEligible({
        issueKind: "entity_family_convergence",
        eligibleForApply: false,
      }),
    ).toBe(true);
    expect(
      isManualProposalSettlementEligible({
        issueKind: "claim_key_alias_convergence",
        eligibleForApply: false,
      }),
    ).toBe(true);
    expect(
      isManualProposalSettlementEligible({
        issueKind: "claim_key_alias_convergence",
        eligibleForApply: true,
      }),
    ).toBe(false);
  });

  it("detects alias convergence proposals", () => {
    expect(isClaimKeyAliasConvergenceProposal({ issueKind: "claim_key_alias_convergence" })).toBe(true);
    expect(isClaimKeyAliasConvergenceProposal({ issueKind: "missing_claim_key" })).toBe(false);
  });

  it("builds settlement reasons from operator notes only", () => {
    expect(buildManualProposalSettlementReason("mixed_claim_key_group", "separate", "distinct slots", "", 0)).toBe(
      "Resolved mixed claim-key group manually by keeping the affected durables under separate claim keys. Note: distinct slots",
    );
    expect(buildManualProposalSettlementReason("claim_key_alias_convergence", "canonical", "same slot", "agenr/status", 0)).toBe(
      'Resolved claim-key alias convergence manually by writing canonical key "agenr/status". Note: same slot',
    );
    expect(buildManualProposalSettlementReason("entity_family_convergence", "retire", "", "", 2)).toBe(
      "Resolved entity-family convergence manually by retiring 2 duplicate or wrong durables.",
    );
  });
});
