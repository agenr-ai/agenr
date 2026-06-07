import { describe, expect, it } from "vitest";

import { resolveHostShutdownEpisodeEligibility } from "../../../src/adapters/shared/shutdown-episode-threshold.js";
import type { ParsedTranscript } from "../../../src/core/types.js";

describe("resolveHostShutdownEpisodeEligibility", () => {
  it("accepts sessions with at least eight material turns", () => {
    expect(resolveHostShutdownEpisodeEligibility(buildTranscript({ messageCount: 8 }))).toMatchObject({
      eligible: true,
      materialTurns: 8,
    });
  });

  it("accepts sessions that lasted at least twenty minutes", () => {
    expect(
      resolveHostShutdownEpisodeEligibility(
        buildTranscript({
          messageCount: 2,
          startedAt: "2026-05-30T10:00:00.000Z",
          endedAt: "2026-05-30T10:20:00.000Z",
        }),
      ),
    ).toMatchObject({
      eligible: true,
      durationMs: 20 * 60 * 1000,
    });
  });

  it("skips short sessions below the phase 4 thresholds", () => {
    expect(resolveHostShutdownEpisodeEligibility(buildTranscript({ messageCount: 4 }))).toEqual({
      eligible: false,
      reason: "below_activity_threshold",
      materialTurns: 4,
      durationMs: 3 * 60 * 1000,
    });
  });
});

function buildTranscript(options: { messageCount: number; startedAt?: string; endedAt?: string }): ParsedTranscript {
  const startedAt = options.startedAt ?? "2026-05-30T10:00:00.000Z";
  const endedAt = options.endedAt ?? "2026-05-30T10:03:00.000Z";
  const messages = Array.from({ length: options.messageCount }, (_, index) => ({
    index,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: `message ${index}`,
    timestamp: index === options.messageCount - 1 ? endedAt : startedAt,
  }));

  return {
    messages,
    metadata: {
      startedAt,
      endedAt,
      messageCount: messages.length,
      transcriptHash: "hash",
    },
    warnings: [],
  };
}
