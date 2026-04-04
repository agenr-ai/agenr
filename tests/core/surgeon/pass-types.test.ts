import { describe, expect, it } from "vitest";

import { SURGEON_PASS_TYPES, isImplementedSurgeonPass, isSurgeonPassType } from "../../../src/core/surgeon/domain/pass-types.js";

describe("surgeon pass types", () => {
  it("recognizes valid pass types", () => {
    expect(SURGEON_PASS_TYPES).toEqual(["claim_key_quality", "retirement", "dedup", "supersession", "auto"]);
    expect(isSurgeonPassType("claim_key_quality")).toBe(true);
    expect(isSurgeonPassType("retirement")).toBe(true);
    expect(isSurgeonPassType("dedup")).toBe(true);
    expect(isSurgeonPassType("supersession")).toBe(true);
    expect(isSurgeonPassType("invalid")).toBe(false);
  });

  it("marks claim_key_quality, retirement, and supersession as implemented in the MVP", () => {
    expect(isImplementedSurgeonPass("claim_key_quality")).toBe(true);
    expect(isImplementedSurgeonPass("retirement")).toBe(true);
    expect(isImplementedSurgeonPass("supersession")).toBe(true);
    expect(isImplementedSurgeonPass("dedup")).toBe(false);
    expect(isImplementedSurgeonPass("auto")).toBe(false);
  });
});
