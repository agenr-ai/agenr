import { describe, expect, it } from "vitest";

import {
  buildMixedClaimKeySettlementReason,
  isClaimKeyAliasConvergenceProposal,
  isManualMixedClaimKeyProposal,
} from "../../../src/core/dreaming/domain/proposal-review.js";

describe("proposal review domain helpers", () => {
  it("detects manual mixed-key proposals", () => {
    expect(
      isManualMixedClaimKeyProposal({
        issueKind: "mixed_claim_key_group",
        eligibleForApply: false,
        proposedClaimKeys: [],
      }),
    ).toBe(true);
    expect(
      isManualMixedClaimKeyProposal({
        issueKind: "mixed_claim_key_group",
        eligibleForApply: true,
        proposedClaimKeys: ["agenr/status"],
      }),
    ).toBe(false);
  });

  it("detects alias convergence proposals", () => {
    expect(isClaimKeyAliasConvergenceProposal({ issueKind: "claim_key_alias_convergence" })).toBe(true);
    expect(isClaimKeyAliasConvergenceProposal({ issueKind: "missing_claim_key" })).toBe(false);
  });

  it("builds mixed-key settlement reasons from operator notes only", () => {
    expect(buildMixedClaimKeySettlementReason("separate", "distinct slots", "", 0)).toBe(
      "Resolved mixed claim-key group manually by keeping the affected durables under separate claim keys. Note: distinct slots",
    );
    expect(buildMixedClaimKeySettlementReason("canonical", "same slot", "agenr/status", 0)).toBe(
      'Resolved mixed claim-key group manually by writing canonical key "agenr/status". Note: same slot',
    );
    expect(buildMixedClaimKeySettlementReason("retire", "", "", 2)).toBe("Resolved mixed claim-key group manually by retiring 2 duplicate or wrong durables.");
  });
});
