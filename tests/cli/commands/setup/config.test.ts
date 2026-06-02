import { describe, expect, it } from "vitest";

import { AGENR_FEATURE_FLAG_KEYS, createAllEnabledFeatureFlagConfig } from "../../../../src/app/features/types.js";
import { buildNextConfig } from "../../../../src/cli/commands/setup/config.js";

describe("buildNextConfig", () => {
  it("enables every known feature flag when populateAllFeatures is true", () => {
    const config = buildNextConfig(undefined, {
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-5.4-mini",
      primaryCredential: "sk-test",
      stageOverrides: {},
      dbPath: "/tmp/knowledge.db",
      populateAllFeatures: true,
    });

    expect(config.features).toEqual(createAllEnabledFeatureFlagConfig());
    for (const key of AGENR_FEATURE_FLAG_KEYS) {
      expect(config.features?.[key]).toBe(true);
    }
  });

  it("does not add a features block during standalone setup", () => {
    const config = buildNextConfig(undefined, {
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-5.4-mini",
      primaryCredential: "sk-test",
      stageOverrides: {},
      dbPath: "/tmp/knowledge.db",
    });

    expect(config.features).toBeUndefined();
  });
});
