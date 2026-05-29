import { describe, expect, it } from "vitest";

import { mergeSkelnMemoryPolicy, parseSkelnMemoryPolicyJson, readSkelnMemoryPolicySetting } from "../../../src/adapters/skeln/config.js";

describe("Skeln memoryPolicy config", () => {
  it("accepts an omitted memoryPolicy setting", () => {
    expect(
      readSkelnMemoryPolicySetting({
        getSetting: () => undefined,
      }),
    ).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("parses a valid memoryPolicy JSON string", () => {
    expect(
      parseSkelnMemoryPolicyJson(
        JSON.stringify({
          beforeTurn: {
            enabled: true,
            procedureSuggestion: false,
          },
          sessionStart: {
            relevantDurableMemory: false,
          },
          slotPolicies: {
            attributeHeads: {
              integration: "exclusive",
            },
          },
        }),
      ),
    ).toEqual({
      ok: true,
      value: {
        beforeTurn: {
          enabled: true,
          procedureSuggestion: false,
        },
        sessionStart: {
          relevantDurableMemory: false,
        },
        slotPolicies: {
          attributeHeads: {
            integration: "exclusive",
          },
        },
      },
    });
  });

  it("rejects invalid memoryPolicy JSON with stable errors", () => {
    expect(parseSkelnMemoryPolicyJson("{not-json")).toEqual({
      ok: false,
      error: expect.stringContaining("memoryPolicy must be valid JSON"),
    });

    expect(
      parseSkelnMemoryPolicyJson(
        JSON.stringify({
          beforeTurn: {
            enabled: "yes",
          },
        }),
      ),
    ).toEqual({
      ok: false,
      error: "memoryPolicy.beforeTurn.enabled must be a boolean when provided",
    });
  });

  it("merges settings with programmatic overrides so options win", () => {
    expect(
      mergeSkelnMemoryPolicy(
        {
          beforeTurn: {
            enabled: true,
            procedureSuggestion: true,
            recallThreshold: 0.5,
          },
          sessionStart: {
            relevantDurableMemory: true,
          },
          slotPolicies: {
            attributeHeads: {
              preference: "multivalued",
            },
          },
        },
        {
          beforeTurn: {
            procedureSuggestion: false,
          },
          slotPolicies: {
            attributeHeads: {
              integration: "exclusive",
            },
          },
        },
      ),
    ).toEqual({
      beforeTurn: {
        enabled: true,
        procedureSuggestion: false,
        recallThreshold: 0.5,
      },
      sessionStart: {
        relevantDurableMemory: true,
      },
      slotPolicies: {
        attributeHeads: {
          preference: "multivalued",
          integration: "exclusive",
        },
      },
    });
  });
});
