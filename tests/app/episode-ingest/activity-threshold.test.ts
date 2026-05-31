import { describe, expect, it } from "vitest";

import { resolveEpisodeActivityEligibility } from "../../../src/app/episode-ingest/activity-threshold.js";

describe("resolveEpisodeActivityEligibility", () => {
  it("accepts sessions with enough material turns", () => {
    expect(
      resolveEpisodeActivityEligibility(8, "2026-05-30T10:00:00.000Z", "2026-05-30T10:03:00.000Z", {
        minMaterialTurns: 8,
        minDurationMs: 20 * 60 * 1000,
      }),
    ).toMatchObject({
      eligible: true,
      materialTurns: 8,
    });
  });

  it("accepts sessions that lasted long enough", () => {
    expect(
      resolveEpisodeActivityEligibility(2, "2026-05-30T10:00:00.000Z", "2026-05-30T10:20:00.000Z", {
        minMaterialTurns: 8,
        minDurationMs: 20 * 60 * 1000,
      }),
    ).toMatchObject({
      eligible: true,
      durationMs: 20 * 60 * 1000,
    });
  });

  it("skips sessions below both thresholds", () => {
    expect(
      resolveEpisodeActivityEligibility(4, "2026-05-30T10:00:00.000Z", "2026-05-30T10:03:00.000Z", {
        minMaterialTurns: 8,
        minDurationMs: 20 * 60 * 1000,
      }),
    ).toEqual({
      eligible: false,
      reason: "below_activity_threshold",
      materialTurns: 4,
      durationMs: 3 * 60 * 1000,
    });
  });
});
