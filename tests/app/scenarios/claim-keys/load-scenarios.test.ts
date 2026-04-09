import { describe, expect, it } from "vitest";

import { validateClaimKeyScenario } from "../../../../src/app/scenarios/claim-keys/load-scenarios.js";

describe("validateClaimKeyScenario", () => {
  it("uses the provided scenario root for setup.seedFixtureFile validation", () => {
    const customRoot = "/tmp/custom-scenario-root";

    expect(() =>
      validateClaimKeyScenario(
        {
          id: "claim-keys.store.seed-fixture-root",
          kind: "store",
          setup: {
            seedFixtureFile: "fixtures/seed.json",
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
        "/tmp/custom-scenario-root/store/seed-fixture-root.json",
        customRoot,
      ),
    ).not.toThrow();
  });

  it("rejects unexpected fields in nested scenario objects", () => {
    expect(() =>
      validateClaimKeyScenario(
        {
          id: "claim-keys.store.unexpected-field",
          kind: "store",
          input: {
            entries: [
              {
                type: "fact",
                subject: "Jim timezone",
                content: "Jim uses America/Chicago.",
                extraField: true,
              },
            ],
          },
          expect: {},
        },
        "/tmp/unexpected-field.json",
        "/tmp",
      ),
    ).toThrow(/unsupported field "extraField"/i);
  });

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

  it("rejects unsupported top-level scenario fields", () => {
    expect(() =>
      validateClaimKeyScenario(
        {
          id: "claim-keys.store.extra-root-field",
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
          expect: {},
          extraRoot: true,
        },
        "/tmp/extra-root-field.json",
        "/tmp",
      ),
    ).toThrow(/unsupported field "extraRoot"/i);
  });
});
