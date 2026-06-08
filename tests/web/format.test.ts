import { describe, expect, it } from "vitest";

import { formatIssueKind } from "../../web/src/lib/format.js";

describe("web format helpers", () => {
  it("renders the alias convergence issue with the product label", () => {
    expect(formatIssueKind("claim_key_alias_convergence")).toBe("Claim-Key Alias Convergence");
  });

  it("falls back to title case for existing issue kinds", () => {
    expect(formatIssueKind("mixed_claim_key_group")).toBe("Mixed Claim Key Group");
  });
});
