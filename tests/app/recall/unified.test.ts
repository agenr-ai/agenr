import { describe, expect, it, vi } from "vitest";

import { routeRecall, runUnifiedRecall } from "../../../src/app/recall/unified.js";
import type { EpisodeDatabasePort, RecallPorts } from "../../../src/core/ports.js";
import type { RecallCandidateEntry } from "../../../src/core/recall/types.js";
import type { Entry, Episode } from "../../../src/core/types.js";

describe("runUnifiedRecall", () => {
  it("detects historical-state queries with conservative composite phrases", () => {
    expect(
      routeRecall({
        requested: "auto",
        text: "what was the previous deployment approach",
        parsedTimeWindow: false,
        hasEntryFilters: false,
      }),
    ).toEqual({
      requested: "auto",
      detectedIntent: "historical_state",
      queried: ["entries", "episodes"],
      reason: "The query asks about a previous state or transition, so both entries and episodes were queried.",
    });
  });

  it("detects broader historical workflow and plan phrasings", () => {
    expect(
      routeRecall({
        requested: "auto",
        text: "what workflow did we use before the dev recall command existed for local recall evals",
        parsedTimeWindow: false,
        hasEntryFilters: false,
      }).detectedIntent,
    ).toBe("historical_state");
    expect(
      routeRecall({
        requested: "auto",
        text: "what short-lived plan did we consider earlier that day before the final freshness ranking fix",
        parsedTimeWindow: false,
        hasEntryFilters: false,
      }).detectedIntent,
    ).toBe("historical_state");
  });

  it("does not classify historical-sounding lookalikes as historical-state", () => {
    expect(
      routeRecall({
        requested: "auto",
        text: "how old is this repo",
        parsedTimeWindow: false,
        hasEntryFilters: false,
      }).detectedIntent,
    ).toBe("factual");
    expect(
      routeRecall({
        requested: "auto",
        text: "what happened before the deploy",
        parsedTimeWindow: false,
        hasEntryFilters: false,
      }).detectedIntent,
    ).not.toBe("historical_state");
    expect(
      routeRecall({
        requested: "auto",
        text: "what do we use to build releases",
        parsedTimeWindow: false,
        hasEntryFilters: false,
      }).detectedIntent,
    ).toBe("factual");
  });

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

  it("uses semantic episode search for auto historical-state queries without a time window", async () => {
    const episodeVectorSearch = vi.fn(async () => [
      {
        episode: createEpisode({
          id: "history-episode",
          sourceId: "history-episode",
          embedding: [1, 0],
          summary: "We replaced the old deployment path with the new one after a migration.",
        }),
        vectorSim: 0.9,
      },
    ]);
    const database = createEpisodeDatabase({
      episodeVectorSearch,
    });
    const priorEntry = createEntry({
      id: "old-approach",
      subject: "deployment approach",
      content: "Before the migration we used the legacy deploy path.",
    });

    const result = await runUnifiedRecall(
      {
        text: "what was the previous deployment approach",
        limit: 2,
      },
      {
        database,
        recall: createRecallPorts({
          vectorSearch: async () => [
            {
              entry: toRecallCandidateEntry(priorEntry),
              vectorSim: 0.82,
            },
          ],
          hydrateEntries: async (ids) => (ids.includes(priorEntry.id) ? [priorEntry] : []),
        }),
        embeddingAvailable: true,
        embedQuery: async () => [1, 0],
      },
    );

    expect(result.routing).toMatchObject({
      requested: "auto",
      detectedIntent: "historical_state",
      queried: ["entries", "episodes"],
    });
    expect(episodeVectorSearch).toHaveBeenCalledWith({
      embedding: [1, 0],
      limit: 2,
    });
    expect(result.entries.map((entry) => entry.entry.id)).toEqual(["old-approach"]);
    expect(result.episodes.map((episode) => episode.episode.id)).toEqual(["history-episode"]);
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

function createRecallPorts(overrides: Partial<RecallPorts> = {}): RecallPorts {
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
    ...overrides,
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

function createEntry(overrides: Partial<Entry> & Pick<Entry, "id" | "subject" | "content">): Entry {
  const now = "2026-03-30T00:00:00.000Z";
  return {
    id: overrides.id,
    type: overrides.type ?? "decision",
    subject: overrides.subject,
    content: overrides.content,
    importance: overrides.importance ?? 7,
    expiry: overrides.expiry ?? "permanent",
    tags: overrides.tags ?? [],
    source_file: overrides.source_file,
    source_context: overrides.source_context,
    embedding: overrides.embedding,
    content_hash: overrides.content_hash,
    norm_content_hash: overrides.norm_content_hash,
    quality_score: overrides.quality_score ?? 0.5,
    recall_count: overrides.recall_count ?? 0,
    last_recalled_at: overrides.last_recalled_at,
    superseded_by: overrides.superseded_by,
    valid_from: overrides.valid_from,
    valid_to: overrides.valid_to,
    claim_key: overrides.claim_key,
    claim_key_status: overrides.claim_key_status,
    supersession_kind: overrides.supersession_kind,
    supersession_reason: overrides.supersession_reason,
    cluster_id: overrides.cluster_id,
    user_id: overrides.user_id,
    project: overrides.project,
    retired: overrides.retired ?? false,
    retired_at: overrides.retired_at,
    retired_reason: overrides.retired_reason,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  };
}

function toRecallCandidateEntry(entry: Entry): RecallCandidateEntry {
  return {
    id: entry.id,
    subject: entry.subject,
    content: entry.content,
    importance: entry.importance,
    expiry: entry.expiry,
    created_at: entry.created_at,
    embedding: entry.embedding,
    superseded_by: entry.superseded_by,
    claim_key: entry.claim_key,
    claim_key_status: entry.claim_key_status,
    retired: entry.retired,
  };
}
