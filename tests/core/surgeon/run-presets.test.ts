import { describe, expect, it } from "vitest";

import { AUTONOMOUS_SURGEON_SEQUENCE, getAutonomousSurgeonPassSequence } from "../../../src/core/surgeon/domain/run-presets.js";

describe("surgeon autonomous sequence", () => {
  it("uses the full autonomous pass order", () => {
    expect(AUTONOMOUS_SURGEON_SEQUENCE).toEqual(["claim_key_quality", "proposal_resolution", "supersession", "retirement"]);
    expect(getAutonomousSurgeonPassSequence()).toEqual(["claim_key_quality", "proposal_resolution", "supersession", "retirement"]);
  });
});
