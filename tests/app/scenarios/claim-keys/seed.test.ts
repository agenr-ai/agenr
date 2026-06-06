import { describe, expect, it } from "vitest";

import { buildClaimKeyScenarioSeedEntry } from "../../../../src/app/scenarios/claim-keys/seed.js";

describe("buildClaimKeyScenarioSeedEntry", () => {
  it("normalizes seed claim keys through the canonical validation path", () => {
    const entry = buildClaimKeyScenarioSeedEntry({
      type: "fact",
      subject: " Jim timezone ",
      content: " Jim uses America/Chicago. ",
      claim_key: "jim/timezone",
      claim_key_raw: " Jim / Timezone ",
    });

    expect(entry).toMatchObject({
      subject: "Jim timezone",
      content: "Jim uses America/Chicago.",
      claim_key: "jim/timezone",
      claim_key_status: "trusted",
      claim_key_source: "manual",
      claim_key_confidence: 1,
      claim_key_rationale: "manual claim key supplied by caller",
      expiry: "temporary",
    });
  });

  it("preserves fully specified precomputed lifecycle metadata for seeded rows", () => {
    const entry = buildClaimKeyScenarioSeedEntry({
      type: "fact",
      subject: "Jim timezone",
      content: "Jim uses America/Chicago.",
      claim_key: "jim/timezone",
      claim_key_raw: "Jim/timezone",
      claim_key_status: "trusted",
      claim_key_source: "model",
      claim_key_confidence: 0.93,
      claim_key_rationale: "claim key extracted from model output",
    });

    expect(entry).toMatchObject({
      claim_key: "jim/timezone",
      claim_key_raw: "Jim/timezone",
      claim_key_status: "trusted",
      claim_key_source: "model",
      claim_key_confidence: 0.93,
      claim_key_rationale: "claim key extracted from model output",
    });
  });

  it("preserves intentionally malformed stored claim keys for legacy cleanup scenarios", () => {
    const entry = buildClaimKeyScenarioSeedEntry({
      type: "fact",
      subject: "Home city",
      content: "Jim lives in Denver, Colorado.",
      claim_key: " Jim / Home City ",
    });

    expect(entry).toMatchObject({
      claim_key: "Jim / Home City",
      claim_key_status: "trusted",
      claim_key_source: "manual",
    });
  });
});
