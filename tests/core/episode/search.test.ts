import { describe, expect, it } from "vitest";

import { searchEpisodes } from "../../../src/core/episode/search.js";
import type { EpisodeQuery } from "../../../src/core/episode/types.js";
import type { EpisodeDatabasePort } from "../../../src/core/ports.js";
import type { Episode } from "../../../src/core/types.js";

describe("searchEpisodes", () => {
  it("uses an oversampled candidate limit and ranks results in core", async () => {
    const seen: { limit?: number } = {};
    const database = createDatabase({
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
    });

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
    const database = createDatabase({
      async listEpisodesByTimeWindow() {
        throw new Error("should not be called");
      },
    });

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

  it("uses semantic episode search when no time window is provided", async () => {
    const seen: { embedding?: number[]; limit?: number } = {};
    const database = createDatabase({
      async episodeVectorSearch(params) {
        seen.embedding = params.embedding;
        seen.limit = params.limit;
        return [
          {
            episode: createEpisode({
              id: "semantic-1",
              summary: "We discussed hybrid semantic episode recall.",
              embedding: [1, 0],
            }),
            vectorSim: 0.92,
          },
          {
            episode: createEpisode({
              id: "semantic-2",
              summary: "We talked about unrelated maintenance.",
              embedding: [0.6, 0.4],
            }),
            vectorSim: 0.61,
          },
        ];
      },
    });

    const results = await searchEpisodes(
      {
        text: "hybrid semantic episode recall",
        limit: 2,
        embedding: [1, 0],
      },
      database,
      new Date("2026-03-30T00:00:00.000Z"),
    );

    expect(seen).toEqual({
      embedding: [1, 0],
      limit: 2,
    });
    expect(results.map((result) => [result.episode.id, result.scores.semantic])).toEqual([
      ["semantic-1", 0.92],
      ["semantic-2", 0.61],
    ]);
  });

  it("re-ranks temporal candidates semantically and keeps missing embeddings below embedded matches", async () => {
    const database = createDatabase({
      async listEpisodesByTimeWindow() {
        return [
          createEpisode({
            id: "missing-embedding",
            startedAt: "2026-03-29T08:00:00.000Z",
            endedAt: "2026-03-29T20:00:00.000Z",
            activityLevel: "substantial",
          }),
          createEpisode({
            id: "best-semantic",
            startedAt: "2026-03-29T00:00:00.000Z",
            endedAt: "2026-03-30T00:00:00.000Z",
            embedding: [1, 0],
          }),
          createEpisode({
            id: "weak-semantic",
            startedAt: "2026-03-29T09:00:00.000Z",
            endedAt: "2026-03-29T11:00:00.000Z",
            embedding: [0.3, 0.7],
          }),
        ];
      },
    });

    const results = await searchEpisodes(
      {
        text: "what happened on agenr 2026-03-29",
        limit: 3,
        timeWindow: {
          kind: "interval",
          start: new Date("2026-03-29T00:00:00.000Z"),
          end: new Date("2026-03-29T23:59:59.999Z"),
          source: "inferred",
        },
        embedding: [1, 0],
      },
      database,
      new Date("2026-03-30T00:00:00.000Z"),
    );

    expect(results.map((result) => result.episode.id)).toEqual(["best-semantic", "weak-semantic", "missing-embedding"]);
    expect(results[0]?.scores.semantic).toBe(1);
    expect(results[2]?.scores.semantic).toBe(0);
  });
});

function createDatabase(overrides: Partial<EpisodeDatabasePort> = {}): EpisodeDatabasePort {
  return {
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
      return [];
    },
    async episodeVectorSearch() {
      return [];
    },
    async listEpisodesWithoutEmbeddings() {
      return [];
    },
    async updateEpisodeEmbedding() {
      return;
    },
    ...overrides,
  };
}

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
