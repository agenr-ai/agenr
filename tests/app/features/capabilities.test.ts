import { describe, expect, it } from "vitest";

import { resolveRuntimeCapabilities } from "../../../src/app/features/capabilities.js";
import { DEFAULT_AGENR_FEATURE_FLAGS } from "../../../src/app/features/types.js";

describe("resolveRuntimeCapabilities", () => {
  it("derives baseline capabilities from default feature flags", () => {
    expect(resolveRuntimeCapabilities(DEFAULT_AGENR_FEATURE_FLAGS)).toEqual({
      workingMemory: "disabled",
      sessionMemory: "misconfigured",
      shutdownEpisodes: false,
      goalContinuation: "disabled",
    });
  });

  it("marks repository-backed capabilities misconfigured when repos are missing", () => {
    expect(
      resolveRuntimeCapabilities(
        {
          ...DEFAULT_AGENR_FEATURE_FLAGS,
          workingMemory: true,
          sessionTreeLineage: true,
        },
        {},
      ),
    ).toEqual({
      workingMemory: "misconfigured",
      sessionMemory: "misconfigured",
      shutdownEpisodes: false,
      goalContinuation: "disabled",
    });
  });

  it("marks goal continuation misconfigured when the host port is missing", () => {
    expect(
      resolveRuntimeCapabilities(
        {
          ...DEFAULT_AGENR_FEATURE_FLAGS,
          goalContinuation: true,
        },
        {},
      ),
    ).toEqual({
      workingMemory: "disabled",
      sessionMemory: "misconfigured",
      shutdownEpisodes: false,
      goalContinuation: "misconfigured",
    });
  });

  it("enables goal continuation when the feature flag and host port are wired", () => {
    expect(
      resolveRuntimeCapabilities(
        {
          ...DEFAULT_AGENR_FEATURE_FLAGS,
          goalContinuation: true,
        },
        { goalContinuationHostPort: { runCommand: async () => ({ ok: true }) } },
      ),
    ).toMatchObject({
      goalContinuation: "enabled",
    });
  });

  it("enables shutdown episodes when session memory is fully enabled", () => {
    expect(
      resolveRuntimeCapabilities(
        {
          ...DEFAULT_AGENR_FEATURE_FLAGS,
          sessionTreeLineage: true,
        },
        { sessionMemoryRepository: {} as never },
      ),
    ).toMatchObject({
      sessionMemory: "enabled",
      shutdownEpisodes: true,
    });
  });
});
