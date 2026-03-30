import { describe, expect, it } from "vitest";

import { searchEpisodes } from "../../../src/core/episode/search.js";
import type { EpisodeQuery } from "../../../src/core/episode/types.js";
import type { EpisodeDatabasePort } from "../../../src/core/ports.js";
import type { Episode } from "../../../src/core/types.js";

describe("searchEpisodes", () => {
  it("uses an oversampled candidate limit and ranks results in core", async () => {
    const seen: { limit?: number } = {};
    const database: EpisodeDatabasePort = {
      async getEpisodeBySourceId() {
        return null;
      },
      async getEpisodeByTranscriptHash() {
        return null;
      },
      async upsertEpisode() {
        throw new Error("not implemented");
      },
      async listEpisodesByTimeWindow(_window, limit) {
        seen.limit = limit;
        return [
          createEpisode({
            id: "broad",
            sourceId: "broad",
            startedAt: "2026-03-27T00:00:00.000Z",
            endedAt: "2026-03-31T00:00:00.000Z",
          }),
          createEpisode({
            id: "focused",
            sourceId: "focused",
            startedAt: "2026-03-29T08:00:00.000Z",
            endedAt: "2026-03-29T20:00:00.000Z",
            activityLevel: "substantial",
          }),
        ];
      },
    };

    const results = await searchEpisodes(
      {
        text: "what happened on 2026-03-29",
        limit: 3,
        timeWindow: {
          kind: "interval",
          start: new Date("2026-03-29T00:00:00.000Z"),
          end: new Date("2026-03-29T23:59:59.999Z"),
          source: "inferred",
        },
      },
      database,
      new Date("2026-03-30T00:00:00.000Z"),
    );

    expect(seen.limit).toBe(25);
    expect(results.map((result) => result.episode.id)).toEqual(["focused", "broad"]);
  });

  it("returns an empty list when the temporal window cannot be materialized", async () => {
    const database: EpisodeDatabasePort = {
      async getEpisodeBySourceId() {
        return null;
      },
      async getEpisodeByTranscriptHash() {
        return null;
      },
      async upsertEpisode() {
        throw new Error("not implemented");
      },
      async listEpisodesByTimeWindow() {
        throw new Error("should not be called");
      },
    };

    const results = await searchEpisodes(
      {
        text: "what happened",
        limit: 3,
        timeWindow: {
          kind: "open_start",
          source: "inferred",
        },
      } as EpisodeQuery,
      database,
    );

    expect(results).toEqual([]);
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
