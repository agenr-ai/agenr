import { describe, expect, it } from "vitest";

import { SURGEON_PASS_TYPES, isImplementedSurgeonPass, isSurgeonPassType } from "../../../src/core/surgeon/domain/pass-types.js";

describe("surgeon pass types", () => {
  it("recognizes valid pass types", () => {
    expect(SURGEON_PASS_TYPES).toEqual(["claim_key_quality", "retirement", "supersession"]);
    expect(isSurgeonPassType("claim_key_quality")).toBe(true);
    expect(isSurgeonPassType("retirement")).toBe(true);
    expect(isSurgeonPassType("supersession")).toBe(true);
    expect(isSurgeonPassType("dedup")).toBe(false);
    expect(isSurgeonPassType("auto")).toBe(false);
    expect(isSurgeonPassType("invalid")).toBe(false);
  });

  it("marks every supported surgeon pass as implemented", () => {
    expect(isImplementedSurgeonPass("claim_key_quality")).toBe(true);
    expect(isImplementedSurgeonPass("retirement")).toBe(true);
    expect(isImplementedSurgeonPass("supersession")).toBe(true);
  });
});
