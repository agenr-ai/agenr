import { describe, expect, it, vi } from "vitest";

import { runUnifiedRecall } from "../../../src/app/recall/unified.js";
import type { EpisodeDatabasePort, RecallPorts } from "../../../src/core/ports.js";
import type { Episode } from "../../../src/core/types.js";

describe("runUnifiedRecall", () => {
  it("uses pure semantic episode search for explicit episode mode without a time window", async () => {
    const episodeVectorSearch = vi.fn(async () => [
      {
        episode: createEpisode({
          id: "semantic-episode",
          sourceId: "semantic-episode",
          embedding: [1, 0],
        }),
        vectorSim: 0.88,
      },
    ]);
    const database = createEpisodeDatabase({
      episodeVectorSearch,
    });

    const result = await runUnifiedRecall(
      {
        text: "semantic episode recall",
        mode: "episodes",
        limit: 2,
      },
      {
        database,
        recall: createRecallPorts(),
        embeddingAvailable: true,
        embedQuery: async () => [1, 0],
      },
    );

    expect(episodeVectorSearch).toHaveBeenCalledWith({
      embedding: [1, 0],
      limit: 2,
    });
    expect(result.episodes.map((episode) => episode.episode.id)).toEqual(["semantic-episode"]);
    expect(result.notices).toContain("Episodes cover consolidated prior sessions only; the most recent completed session may not appear yet.");
  });

  it("falls back to pure temporal episode search when semantic query embedding is unavailable", async () => {
    const listEpisodesByTimeWindow = vi.fn(async () => [
      createEpisode({
        id: "temporal-episode",
        sourceId: "temporal-episode",
        startedAt: "2026-03-29T09:00:00.000Z",
        endedAt: "2026-03-29T10:00:00.000Z",
      }),
    ]);
    const database = createEpisodeDatabase({
      listEpisodesByTimeWindow,
    });

    const result = await runUnifiedRecall(
      {
        text: "what happened on agenr 2026-03-29",
        limit: 3,
      },
      {
        database,
        recall: createRecallPorts(),
        embeddingAvailable: true,
      },
    );

    expect(listEpisodesByTimeWindow).toHaveBeenCalledTimes(1);
    expect(result.episodes.map((episode) => episode.episode.id)).toEqual(["temporal-episode"]);
    expect(result.notices).toContain("Semantic episode search unavailable - showing temporal results only.");
  });
});

function createEpisodeDatabase(overrides: Partial<EpisodeDatabasePort> = {}): EpisodeDatabasePort {
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

function createRecallPorts(): RecallPorts {
  return {
    async embed() {
      return [1, 0];
    },
    async vectorSearch() {
      return [];
    },
    async ftsSearch() {
      return [];
    },
    async hydrateEntries() {
      return [];
    },
    async recordRecallEvents() {
      return;
    },
  };
}

function createEpisode(overrides: Partial<Episode> = {}): Episode {
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
