import { describe, expect, it } from "vitest";

import { SURGEON_RUN_PRESETS, isSurgeonRunPreset, resolveSurgeonPassSequence } from "../../../src/core/surgeon/domain/run-presets.js";

describe("surgeon run presets", () => {
  it("recognizes supported preset identifiers", () => {
    expect(SURGEON_RUN_PRESETS).toEqual(["claim-key-only", "structural", "full"]);
    expect(isSurgeonRunPreset("claim-key-only")).toBe(true);
    expect(isSurgeonRunPreset("structural")).toBe(true);
    expect(isSurgeonRunPreset("full")).toBe(true);
    expect(isSurgeonRunPreset("single")).toBe(false);
  });

  it("orders structural and full presets with claim_key_quality before supersession", () => {
    expect(resolveSurgeonPassSequence("claim-key-only")).toEqual(["claim_key_quality"]);
    expect(resolveSurgeonPassSequence("structural")).toEqual(["claim_key_quality", "supersession"]);
    expect(resolveSurgeonPassSequence("full")).toEqual(["claim_key_quality", "supersession", "retirement"]);
  });
});
