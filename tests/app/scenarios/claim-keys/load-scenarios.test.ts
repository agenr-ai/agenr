import { describe, expect, it } from "vitest";

import { validateClaimKeyScenario } from "../../../../src/app/scenarios/claim-keys/load-scenarios.js";

describe("validateClaimKeyScenario", () => {
  it("rejects invalid lifecycle enum values in seed entries", () => {
    expect(() =>
      validateClaimKeyScenario(
        {
          id: "claim-keys.store.invalid-seed-lifecycle",
          kind: "store",
          setup: {
            seedEntries: [
              {
                type: "fact",
                subject: "Jim timezone",
                content: "Jim uses America/Chicago.",
                claim_key: "jim/timezone",
                claim_key_status: "legacy",
              },
            ],
          },
          input: {
            entries: [
              {
                type: "fact",
                subject: "Jim timezone",
                content: "Jim uses America/Chicago.",
              },
            ],
          },
          expect: {},
        },
        "/tmp/invalid-seed.json",
        "/tmp",
      ),
    ).toThrow(/claim_key_status/i);
  });

  it("rejects invalid lifecycle enum values in row assertions", () => {
    expect(() =>
      validateClaimKeyScenario(
        {
          id: "claim-keys.store.invalid-assert-lifecycle",
          kind: "store",
          input: {
            entries: [
              {
                type: "fact",
                subject: "Jim timezone",
                content: "Jim uses America/Chicago.",
              },
            ],
          },
          expect: {
            rows: [
              {
                match: {
                  subject: "Jim timezone",
                },
                assert: {
                  claim_support_mode: "copied",
                },
              },
            ],
          },
        },
        "/tmp/invalid-assert.json",
        "/tmp",
      ),
    ).toThrow(/claim_support_mode/i);
  });
});
