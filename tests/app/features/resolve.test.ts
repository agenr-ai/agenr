import { describe, expect, it } from "vitest";

import { resolveAgenrFeatureFlags } from "../../../src/app/features/resolve.js";
import { AGENR_FEATURE_FLAG_KEYS, DEFAULT_AGENR_FEATURE_FLAGS, createAllEnabledFeatureFlagConfig } from "../../../src/app/features/types.js";

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

  it("creates a persisted config block with every flag enabled", () => {
    expect(createAllEnabledFeatureFlagConfig()).toEqual({
      workingMemory: true,
      sessionTreeLineage: true,
      sessionTreeCompaction: true,
      goalContinuation: true,
    });
    expect(Object.keys(createAllEnabledFeatureFlagConfig()).sort()).toEqual([...AGENR_FEATURE_FLAG_KEYS].sort());
  });
});
