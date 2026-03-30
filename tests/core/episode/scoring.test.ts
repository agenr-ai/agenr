import { describe, expect, it } from "vitest";

import { compareEpisodeMatches, scoreEpisodeMatch } from "../../../src/core/episode/scoring.js";
import type { Episode } from "../../../src/core/types.js";

const QUERY_BOUNDS = {
  start: new Date("2026-03-29T00:00:00.000Z"),
  end: new Date("2026-03-29T23:59:59.999Z"),
};

describe("scoreEpisodeMatch", () => {
  it("prefers focused overlap over giant loose overlap", () => {
    const focused = scoreEpisodeMatch(
      createEpisode({
        id: "focused",
        startedAt: "2026-03-29T09:00:00.000Z",
        endedAt: "2026-03-29T11:00:00.000Z",
      }),
      QUERY_BOUNDS,
    );
    const broad = scoreEpisodeMatch(
      createEpisode({
        id: "broad",
        startedAt: "2026-03-27T00:00:00.000Z",
        endedAt: "2026-03-31T00:00:00.000Z",
      }),
      QUERY_BOUNDS,
    );

    expect(focused.explanation.overlapQuality).toBeGreaterThan(broad.explanation.overlapQuality);
    expect(compareEpisodeMatches(focused, broad)).toBeLessThan(0);
  });

  it("uses midpoint proximity as the secondary ordering signal", () => {
    const nearCenter = scoreEpisodeMatch(
      createEpisode({
        id: "near",
        startedAt: "2026-03-29T11:00:00.000Z",
        endedAt: "2026-03-29T13:00:00.000Z",
      }),
      QUERY_BOUNDS,
    );
    const edge = scoreEpisodeMatch(
      createEpisode({
        id: "edge",
        startedAt: "2026-03-29T00:30:00.000Z",
        endedAt: "2026-03-29T02:30:00.000Z",
      }),
      QUERY_BOUNDS,
    );

    expect(nearCenter.explanation.overlapQuality).toBeCloseTo(edge.explanation.overlapQuality, 6);
    expect(nearCenter.explanation.midpointProximity).toBeGreaterThan(edge.explanation.midpointProximity);
    expect(compareEpisodeMatches(nearCenter, edge)).toBeLessThan(0);
  });

  it("uses activity level as a tie-breaker", () => {
    const substantial = scoreEpisodeMatch(
      createEpisode({
        id: "substantial",
        activityLevel: "substantial",
        startedAt: "2026-03-29T09:00:00.000Z",
        endedAt: "2026-03-29T11:00:00.000Z",
      }),
      QUERY_BOUNDS,
    );
    const minimal = scoreEpisodeMatch(
      createEpisode({
        id: "minimal",
        activityLevel: "minimal",
        startedAt: "2026-03-29T09:00:00.000Z",
        endedAt: "2026-03-29T11:00:00.000Z",
      }),
      QUERY_BOUNDS,
    );

    expect(substantial.explanation.activity).toBeGreaterThan(minimal.explanation.activity);
    expect(compareEpisodeMatches(substantial, minimal)).toBeLessThan(0);
  });
});

function createEpisode(overrides: Partial<Episode>): Episode {
  const now = "2026-03-30T00:00:00.000Z";
  return {
    id: overrides.id ?? "episode",
    source: overrides.source ?? "openclaw",
    sourceId: overrides.sourceId,
    sourceRef: overrides.sourceRef,
    transcriptHash: overrides.transcriptHash,
    summaryHash: overrides.summaryHash,
    agentId: overrides.agentId,
    surface: overrides.surface,
    startedAt: overrides.startedAt ?? "2026-03-29T09:00:00.000Z",
    endedAt: overrides.endedAt ?? "2026-03-29T10:00:00.000Z",
    summary: overrides.summary ?? "Episode summary",
    tags: overrides.tags ?? [],
    activityLevel: overrides.activityLevel,
    userId: overrides.userId,
    project: overrides.project,
    genModel: overrides.genModel,
    genVersion: overrides.genVersion,
    messageCount: overrides.messageCount,
    embedding: overrides.embedding,
    retired: overrides.retired ?? false,
    retiredAt: overrides.retiredAt,
    retiredReason: overrides.retiredReason,
    supersededBy: overrides.supersededBy,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}
