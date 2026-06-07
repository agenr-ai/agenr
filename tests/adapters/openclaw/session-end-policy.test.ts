import { describe, expect, it } from "vitest";

import { resolveOpenClawSessionEndPolicy } from "../../../src/adapters/openclaw/session-end-policy.js";

describe("resolveOpenClawSessionEndPolicy", () => {
  it("skips memory intake and episode capture for compaction session ends", () => {
    expect(resolveOpenClawSessionEndPolicy("compaction")).toEqual({
      routeMemoryIntake: false,
      captureEpisode: false,
    });
  });

  it("routes memory intake and episode capture for non-compaction session ends", () => {
    expect(resolveOpenClawSessionEndPolicy("idle")).toEqual({
      routeMemoryIntake: true,
      captureEpisode: true,
    });
    expect(resolveOpenClawSessionEndPolicy("reset")).toEqual({
      routeMemoryIntake: true,
      captureEpisode: true,
    });
    expect(resolveOpenClawSessionEndPolicy(undefined)).toEqual({
      routeMemoryIntake: true,
      captureEpisode: true,
    });
  });
});
