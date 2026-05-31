import { describe, expect, it } from "vitest";

import { resolveAgenrFeatureFlags } from "../../../src/app/features/resolve.js";
import { DEFAULT_AGENR_FEATURE_FLAGS } from "../../../src/app/features/types.js";

describe("resolveAgenrFeatureFlags", () => {
  it("returns all-off defaults when features are omitted", () => {
    expect(resolveAgenrFeatureFlags()).toEqual(DEFAULT_AGENR_FEATURE_FLAGS);
  });

  it("merges sparse overrides without requiring every flag", () => {
    expect(
      resolveAgenrFeatureFlags({
        workingMemory: true,
      }),
    ).toEqual({
      ...DEFAULT_AGENR_FEATURE_FLAGS,
      workingMemory: true,
    });
  });

  it("applies every known flag key from defaults when input is empty", () => {
    expect(Object.keys(resolveAgenrFeatureFlags()).sort()).toEqual(Object.keys(DEFAULT_AGENR_FEATURE_FLAGS).sort());
  });

  it("preserves explicit false overrides during resolution", () => {
    expect(
      resolveAgenrFeatureFlags({
        workingMemory: true,
        sessionTreeLineage: false,
      }),
    ).toEqual({
      workingMemory: true,
      sessionTreeLineage: false,
      sessionTreeCompaction: false,
      goalContinuation: false,
    });
  });
});
