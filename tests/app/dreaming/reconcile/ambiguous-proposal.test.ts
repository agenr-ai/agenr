import { describe, expect, it } from "vitest";
import { defaultFlagAmbiguousProposal, resolveFlagAmbiguousProposal } from "../../../../src/app/dreaming/reconcile/helpers/ambiguous-proposal.js";

describe("defaultFlagAmbiguousProposal", () => {
  it("defaults ambiguous telemetry on for review-oriented proposal kinds", () => {
    expect(defaultFlagAmbiguousProposal("missing_claim_key")).toBe(true);
    expect(defaultFlagAmbiguousProposal("malformed_claim_key")).toBe(true);
    expect(defaultFlagAmbiguousProposal("suspect_canonical_claim_key")).toBe(true);
    expect(defaultFlagAmbiguousProposal("entity_family_convergence")).toBe(true);
  });

  it("defaults ambiguous telemetry off for collision and mixed-group proposals", () => {
    expect(defaultFlagAmbiguousProposal("noncanonical_claim_key")).toBe(false);
    expect(defaultFlagAmbiguousProposal("mixed_claim_key_group")).toBe(false);
  });

  it("honors explicit overrides", () => {
    expect(resolveFlagAmbiguousProposal("missing_claim_key", false)).toBe(false);
    expect(resolveFlagAmbiguousProposal("mixed_claim_key_group", true)).toBe(true);
  });
});
