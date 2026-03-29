import { describe, expect, it } from "vitest";

import { SURGEON_PASS_TYPES, isImplementedSurgeonPass, isSurgeonPassType } from "../../../src/core/surgeon/domain/pass-types.js";

describe("surgeon pass types", () => {
  it("recognizes valid pass types", () => {
    expect(SURGEON_PASS_TYPES).toEqual(["retirement", "dedup", "contradictions", "auto"]);
    expect(isSurgeonPassType("retirement")).toBe(true);
    expect(isSurgeonPassType("dedup")).toBe(true);
    expect(isSurgeonPassType("invalid")).toBe(false);
  });

  it("marks only retirement as implemented in the MVP", () => {
    expect(isImplementedSurgeonPass("retirement")).toBe(true);
    expect(isImplementedSurgeonPass("dedup")).toBe(false);
    expect(isImplementedSurgeonPass("contradictions")).toBe(false);
    expect(isImplementedSurgeonPass("auto")).toBe(false);
  });
});
