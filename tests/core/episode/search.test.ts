import { describe, expect, it, vi } from "vitest";

import { searchEpisodes } from "../../../src/core/episode/search.js";
import type { EpisodeQuery } from "../../../src/core/episode/types.js";
import type { CrossEncoderPort, EpisodeDatabasePort } from "../../../src/core/ports.js";
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

  it("diversifies near-duplicate hybrid episodes when MMR is enabled", async () => {
    const database = createDatabase({
      async listEpisodesByTimeWindow() {
        return [
          createEpisode({
            id: "session-a-1",
            startedAt: "2026-03-29T08:00:00.000Z",
            endedAt: "2026-03-29T09:00:00.000Z",
            summary: "Session A reviewed the weekly rollups.",
            embedding: [1, 0],
          }),
          createEpisode({
            id: "session-a-2",
            startedAt: "2026-03-29T09:00:00.000Z",
            endedAt: "2026-03-29T10:00:00.000Z",
            summary: "Session A continued the weekly rollup review.",
            embedding: [1, 0],
          }),
          createEpisode({
            id: "session-b",
            startedAt: "2026-03-29T11:00:00.000Z",
            endedAt: "2026-03-29T12:00:00.000Z",
            summary: "Session B investigated an unrelated outage.",
            embedding: [0, 1],
          }),
        ];
      },
    });

    const baseline = await searchEpisodes(
      {
        text: "weekly rollups and outage investigations",
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

    const diversified = await searchEpisodes(
      {
        text: "weekly rollups and outage investigations",
        limit: 3,
        timeWindow: {
          kind: "interval",
          start: new Date("2026-03-29T00:00:00.000Z"),
          end: new Date("2026-03-29T23:59:59.999Z"),
          source: "inferred",
        },
        embedding: [1, 0],
        // Disable the phase-4 small-pool gate so this three-episode
        // synthetic fixture still exercises MMR; gate coverage lives in
        // the shared MMR unit tests.
        mmr: { enabled: true, lambda: 0.2, minPoolSize: 0 },
      },
      database,
      new Date("2026-03-30T00:00:00.000Z"),
    );

    const baselineIds = baseline.map((result) => result.episode.id);
    const diversifiedIds = diversified.map((result) => result.episode.id);

    // Without MMR the two near-identical session-A episodes dominate the
    // top of the list and push session-B further down.
    expect(baselineIds.slice(0, 2)).toEqual(["session-a-1", "session-a-2"]);
    expect(baselineIds.indexOf("session-b")).toBeGreaterThan(1);
    // With MMR the diverse session-B candidate gets promoted ahead of the
    // duplicate session-A follow-up even though the duplicate carries a
    // slightly higher composite score.
    expect(diversifiedIds.indexOf("session-b")).toBeLessThan(diversifiedIds.indexOf("session-a-2"));
    expect(diversifiedIds).toEqual(expect.arrayContaining(["session-a-1", "session-a-2", "session-b"]));
  });

  it("applies the cross-encoder rerank to the hybrid shortlist when enabled", async () => {
    const rank = vi.fn<CrossEncoderPort["rank"]>(async (_query, passages) =>
      passages.map((passage) => ({
        id: passage.id,
        score: passage.id === "runner-up" ? 0.98 : 0.1,
      })),
    );
    const database = createDatabase({
      async listEpisodesByTimeWindow() {
        return [
          createEpisode({
            id: "leader",
            startedAt: "2026-03-29T08:00:00.000Z",
            endedAt: "2026-03-29T09:00:00.000Z",
            summary: "Leader session led the standup review.",
            embedding: [1, 0],
          }),
          createEpisode({
            id: "runner-up",
            startedAt: "2026-03-29T10:00:00.000Z",
            endedAt: "2026-03-29T11:00:00.000Z",
            summary: "Runner-up session resolved the outage.",
            embedding: [0.9, 0.2],
          }),
        ];
      },
    });

    const results = await searchEpisodes(
      {
        text: "what happened during the outage",
        limit: 2,
        timeWindow: {
          kind: "interval",
          start: new Date("2026-03-29T00:00:00.000Z"),
          end: new Date("2026-03-29T23:59:59.999Z"),
          source: "inferred",
        },
        embedding: [1, 0],
        crossEncoder: {
          enabled: true,
          port: { rank },
          alpha: 1,
        },
      },
      database,
      new Date("2026-03-30T00:00:00.000Z"),
    );

    expect(rank).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.episode.id)).toEqual(["runner-up", "leader"]);
    expect(results[0]?.scores.crossEncoder).toBeCloseTo(0.98, 6);
  });

  it("skips the cross-encoder rerank when the options bundle is disabled", async () => {
    const rank = vi.fn<CrossEncoderPort["rank"]>(async () => []);
    const database = createDatabase({
      async listEpisodesByTimeWindow() {
        return [
          createEpisode({
            id: "leader",
            startedAt: "2026-03-29T08:00:00.000Z",
            endedAt: "2026-03-29T09:00:00.000Z",
            summary: "Leader session led the standup review.",
            embedding: [1, 0],
          }),
        ];
      },
    });

    await searchEpisodes(
      {
        text: "what happened",
        limit: 2,
        timeWindow: {
          kind: "interval",
          start: new Date("2026-03-29T00:00:00.000Z"),
          end: new Date("2026-03-29T23:59:59.999Z"),
          source: "inferred",
        },
        embedding: [1, 0],
        crossEncoder: {
          enabled: false,
          port: { rank },
        },
      },
      database,
      new Date("2026-03-30T00:00:00.000Z"),
    );

    expect(rank).not.toHaveBeenCalled();
  });

  it("keeps the pre-rerank order when the cross-encoder port throws", async () => {
    const rank = vi.fn<CrossEncoderPort["rank"]>(async () => {
      throw new Error("provider error");
    });
    const database = createDatabase({
      async listEpisodesByTimeWindow() {
        return [
          createEpisode({
            id: "leader",
            startedAt: "2026-03-29T08:00:00.000Z",
            endedAt: "2026-03-29T09:00:00.000Z",
            summary: "Leader session led the standup review.",
            embedding: [1, 0],
          }),
          createEpisode({
            id: "runner-up",
            startedAt: "2026-03-29T10:00:00.000Z",
            endedAt: "2026-03-29T11:00:00.000Z",
            summary: "Runner-up session resolved the outage.",
            embedding: [0.9, 0.2],
          }),
        ];
      },
    });

    const withoutRerank = await searchEpisodes(
      {
        text: "what happened",
        limit: 2,
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
    const withFailingRerank = await searchEpisodes(
      {
        text: "what happened",
        limit: 2,
        timeWindow: {
          kind: "interval",
          start: new Date("2026-03-29T00:00:00.000Z"),
          end: new Date("2026-03-29T23:59:59.999Z"),
          source: "inferred",
        },
        embedding: [1, 0],
        crossEncoder: {
          enabled: true,
          port: { rank },
        },
      },
      database,
      new Date("2026-03-30T00:00:00.000Z"),
    );

    expect(rank).toHaveBeenCalledTimes(1);
    expect(withFailingRerank.map((result) => result.episode.id)).toEqual(withoutRerank.map((result) => result.episode.id));
    expect(withFailingRerank.every((result) => result.scores.crossEncoder === undefined)).toBe(true);
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
    supersededBy: overrides.supersededBy,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}
