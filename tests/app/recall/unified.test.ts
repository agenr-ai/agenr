import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import * as recallSearch from "../../../src/core/recall/search.js";
import { routeRecall, runUnifiedRecall } from "../../../src/app/recall/unified.js";
import type { EpisodeDatabasePort, RecallPorts } from "../../../src/core/ports.js";
import type { RecallCandidateDurable } from "../../../src/core/recall/types.js";
import { computeProcedureRevisionHash, computeProcedureSourceHash } from "../../../src/core/procedures/hashing.js";
import { composeProcedureRecallText } from "../../../src/core/procedures/recall-text.js";
import type { Durable, Episode, Procedure } from "../../../src/core/types.js";
import { closeTestDatabases, removeTestPath } from "../../helpers/temp-paths.js";

const databases: SqlDatabase[] = [];
const databasePaths: string[] = [];

afterEach(async () => {
  vi.useRealTimers();

  await closeTestDatabases(databases);

  while (databasePaths.length > 0) {
    await removeTestPath(databasePaths.pop() ?? "");
  }
});

describe("runUnifiedRecall", () => {
  it("detects historical-state queries with conservative composite phrases", () => {
    expect(
      routeRecall({
        requested: "auto",
        text: "what was the previous deployment approach",
        parsedTimeWindow: false,
        hasDurableFilters: false,
      }),
    ).toEqual({
      requested: "auto",
      detectedIntent: "historical_state",
      queried: ["durables", "episodes"],
      reason: "The query asks about a previous state or transition, so both durables and episodes were queried.",
    });
  });

  it("passes budget through to durable recall", async () => {
    const recallSpy = vi.spyOn(recallSearch, "recall").mockResolvedValue([]);

    await runUnifiedRecall(
      {
        text: "skeln architecture",
        mode: "durables",
        budget: 500,
      },
      {
        database: createEpisodeDatabase(),
        procedures: createProcedureDatabase(),
        recall: createRecallPorts(),
        embeddingAvailable: true,
      },
    );

    expect(recallSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "skeln architecture",
        budget: 500,
      }),
      expect.anything(),
      expect.anything(),
    );

    recallSpy.mockRestore();
  });

  it("detects broader historical workflow and plan phrasings", () => {
    expect(
      routeRecall({
        requested: "auto",
        text: "what workflow did we use before the dev recall command existed for local recall evals",
        parsedTimeWindow: false,
        hasDurableFilters: false,
      }).detectedIntent,
    ).toBe("historical_state");
    expect(
      routeRecall({
        requested: "auto",
        text: "what short-lived plan did we consider earlier that day before the final freshness ranking fix",
        parsedTimeWindow: false,
        hasDurableFilters: false,
      }).detectedIntent,
    ).toBe("historical_state");
  });

  it("does not classify historical-sounding lookalikes as historical-state", () => {
    expect(
      routeRecall({
        requested: "auto",
        text: "how old is this repo",
        parsedTimeWindow: false,
        hasDurableFilters: false,
      }).detectedIntent,
    ).toBe("factual");
    expect(
      routeRecall({
        requested: "auto",
        text: "what happened before the deploy",
        parsedTimeWindow: false,
        hasDurableFilters: false,
      }).detectedIntent,
    ).not.toBe("historical_state");
    expect(
      routeRecall({
        requested: "auto",
        text: "what do we use to build releases",
        parsedTimeWindow: false,
        hasDurableFilters: false,
      }).detectedIntent,
    ).toBe("factual");
  });

  it("routes narrow entity-attribute questions to precision-first durable recall", () => {
    expect(
      routeRecall({
        requested: "auto",
        text: "Where does Jim Martin's dad live?",
        parsedTimeWindow: false,
        hasDurableFilters: false,
      }),
    ).toEqual({
      requested: "auto",
      detectedIntent: "entity_attribute",
      queried: ["durables"],
      reason: "The query asks for a specific entity attribute, so precision-first durable recall was used.",
    });
    expect(
      routeRecall({
        requested: "auto",
        text: "who is Duke?",
        parsedTimeWindow: false,
        hasDurableFilters: false,
      }).detectedIntent,
    ).toBe("entity_attribute");
  });

  it("keeps contextual role questions out of entity-attribute routing", () => {
    expect(
      routeRecall({
        requested: "auto",
        text: "who is on call this week",
        parsedTimeWindow: false,
        hasDurableFilters: false,
      }).detectedIntent,
    ).toBe("factual");
  });

  it("routes generic how-to queries to procedures without repo-specific workflow keywords", () => {
    expect(
      routeRecall({
        requested: "auto",
        text: "how do I rotate the production signing key safely",
        parsedTimeWindow: false,
        hasDurableFilters: false,
      }),
    ).toEqual({
      requested: "auto",
      detectedIntent: "procedural",
      queried: ["procedures"],
      reason: "The query asks how to do something or requests a step-by-step method, so procedure recall was used first.",
    });
  });

  it("keeps lookalike factual queries out of procedural routing", () => {
    expect(
      routeRecall({
        requested: "auto",
        text: "what do we use to authenticate API requests",
        parsedTimeWindow: false,
        hasDurableFilters: false,
      }).queried,
    ).toEqual(["durables"]);
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
        procedures: createProcedureDatabase(),
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
      claim_key: "deployment/approach",
      claim_key_status: "trusted",
      superseded_by: "new-approach",
      valid_to: "2026-03-20T00:00:00.000Z",
    });

    const result = await runUnifiedRecall(
      {
        text: "what was the previous deployment approach",
        limit: 2,
      },
      {
        database,
        procedures: createProcedureDatabase(),
        recall: createRecallPorts({
          vectorSearch: async () => [
            {
              entry: toRecallCandidateDurable(priorEntry),
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
      queried: ["durables", "episodes"],
    });
    expect(episodeVectorSearch).toHaveBeenCalledWith({
      embedding: [1, 0],
      limit: 2,
    });
    expect(result.entries.map((entry) => entry.entry.id)).toEqual(["old-approach"]);
    expect(result.projectedEntries).toMatchObject([
      {
        entryId: "old-approach",
        claimKey: "deployment/approach",
        memoryState: "superseded",
        claimStatus: "trusted",
      },
    ]);
    expect(result.entryFamilies).toMatchObject([
      {
        claimKey: "deployment/approach",
        primary: {
          entryId: "old-approach",
        },
      },
    ]);
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
        procedures: createProcedureDatabase(),
        recall: createRecallPorts(),
        embeddingAvailable: true,
      },
    );

    expect(listEpisodesByTimeWindow).toHaveBeenCalledTimes(1);
    expect(result.episodes.map((episode) => episode.episode.id)).toEqual(["temporal-episode"]);
    expect(result.notices).toContain("Semantic episode search unavailable - showing temporal results only.");
  });

  it("surfaces degraded entry notices instead of skipping durable recall when embeddings are unavailable", async () => {
    const entry = createEntry({
      id: "policy-new",
      subject: "pager policy",
      content: "Taylor is on call this week.",
    });

    const result = await runUnifiedRecall(
      {
        text: "who is on call this week",
        limit: 3,
      },
      {
        database: createEpisodeDatabase(),
        procedures: createProcedureDatabase(),
        recall: createRecallPorts({
          embed: async () => {
            throw new Error("Embeddings are unavailable.");
          },
          ftsSearch: async () => [
            {
              entry: toRecallCandidateDurable(entry),
              rank: 1,
              tier: "all_tokens",
            },
          ],
          hydrateEntries: async () => [entry],
        }),
        embeddingAvailable: false,
        embeddingError: "Embeddings are unavailable.",
      },
    );

    expect(result.entries.map((item) => item.entry.id)).toEqual(["policy-new"]);
    expect(result.notices).toContain("Embeddings failed during recall, so Agenr fell back to lexical-only entry ranking.");
  });

  it("logs entity-attribute detection and keeps the query on durable recall only", async () => {
    const entry = createEntry({
      id: "jim-dad-location",
      subject: "Jim Martin dad location",
      content: "Jim Martin's dad lives in Austin, Texas.",
    });
    const debugLog = vi.fn();

    const result = await runUnifiedRecall(
      {
        text: "Where does Jim Martin's dad live?",
        limit: 3,
      },
      {
        database: createEpisodeDatabase(),
        procedures: createProcedureDatabase(),
        recall: createRecallPorts({
          ftsSearch: async () => [
            {
              entry: toRecallCandidateDurable(entry),
              rank: 1,
              tier: "all_tokens",
            },
          ],
          hydrateEntries: async () => [entry],
        }),
        embeddingAvailable: true,
        debugLog,
      },
    );

    expect(result.routing).toMatchObject({
      detectedIntent: "entity_attribute",
      queried: ["durables"],
    });
    expect(result.entries.map((item) => item.entry.id)).toEqual(["jim-dad-location"]);
    expect(debugLog).toHaveBeenCalledWith(expect.stringContaining('unified recall matched entity-attribute kind="location" entity="Jim Martin\'s dad"'));
  });

  it("surfaces explicit as-of resolution and claim-transition context for historical-state queries", async () => {
    const episodeVectorSearch = vi.fn(async () => [
      {
        episode: createEpisode({
          id: "history-episode",
          sourceId: "history-episode",
          embedding: [1, 0],
          summary: "We migrated the deployment approach from webpack to vite.",
          tags: ["deployment", "migration"],
        }),
        vectorSim: 0.9,
      },
    ]);
    const database = createEpisodeDatabase({
      episodeVectorSearch,
    });
    const priorEntry = createEntry({
      id: "approach-old",
      subject: "deployment approach",
      content: "Webpack was the deployment approach before the migration.",
      claim_key: "deployment/approach",
      claim_key_status: "trusted",
      valid_from: "2026-02-01T00:00:00.000Z",
      valid_to: "2026-03-20T00:00:00.000Z",
      superseded_by: "approach-new",
    });
    const currentEntry = createEntry({
      id: "approach-new",
      subject: "deployment approach",
      content: "Vite is the deployment approach after the migration.",
      claim_key: "deployment/approach",
      claim_key_status: "trusted",
      valid_from: "2026-03-20T00:00:00.000Z",
    });

    const result = await runUnifiedRecall(
      {
        text: "what was the previous deployment approach",
        asOf: "2026-03-01T00:00:00.000Z",
        limit: 3,
      },
      {
        database,
        procedures: createProcedureDatabase(),
        recall: createRecallPorts({
          vectorSearch: async () => [
            {
              entry: toRecallCandidateDurable(priorEntry),
              vectorSim: 0.82,
            },
            {
              entry: toRecallCandidateDurable(currentEntry),
              vectorSim: 0.82,
            },
          ],
          hydrateEntries: async (ids) => [priorEntry, currentEntry].filter((entry) => ids.includes(entry.id)),
        }),
        embeddingAvailable: true,
        embedQuery: async () => [1, 0],
      },
    );

    expect(result.asOf).toBe("2026-03-01T00:00:00.000Z");
    expect(result.projectedEntries[0]).toMatchObject({
      entryId: "approach-old",
      slotPolicy: "exclusive",
      freshness: {
        asOf: {
          clock: "validity",
          relation: "active",
        },
      },
    });
    expect(result.claimTransitions).toMatchObject([
      {
        claimKey: "deployment/approach",
        currentEntryId: "approach-old",
        priorEntryId: "approach-new",
        episodeContext: {
          episodeId: "history-episode",
        },
      },
    ]);
  });

  it("uses source-time episode windows for relative and explicit temporal queries, not row creation time", async () => {
    vi.useFakeTimers();

    const now = new Date(2026, 3, 11, 12, 0, 0, 0);
    vi.setSystemTime(now);

    const database = await createTestEpisodeDatabase();
    const targetBounds = createLocalDayBounds(2026, 3, 9);
    const olderBounds = createLocalDayBounds(2026, 3, 8);
    const newerBounds = createLocalDayBounds(2026, 3, 10);

    await database.upsertEpisode({
      source: "openclaw",
      sourceId: "episode-apr-9",
      sourceRef: "/tmp/episode-apr-9.jsonl",
      transcriptHash: "episode-apr-9-hash",
      startedAt: targetBounds.start,
      endedAt: targetBounds.end,
      summary: "We worked on agenr episode temporal recall and query-time filtering.",
      tags: ["agenr", "recall"],
      activityLevel: "substantial",
      embedding: createEmbedding(0, 1),
    });
    await database.upsertEpisode({
      source: "openclaw",
      sourceId: "episode-apr-8",
      sourceRef: "/tmp/episode-apr-8.jsonl",
      transcriptHash: "episode-apr-8-hash",
      startedAt: olderBounds.start,
      endedAt: olderBounds.end,
      summary: "We worked on agenr episode temporal recall and query-time filtering.",
      tags: ["agenr", "recall"],
      activityLevel: "substantial",
      embedding: createEmbedding(0, 1),
    });
    await database.upsertEpisode({
      source: "openclaw",
      sourceId: "episode-apr-10",
      sourceRef: "/tmp/episode-apr-10.jsonl",
      transcriptHash: "episode-apr-10-hash",
      startedAt: newerBounds.start,
      endedAt: newerBounds.end,
      summary: "We worked on agenr episode temporal recall and query-time filtering.",
      tags: ["agenr", "recall"],
      activityLevel: "substantial",
      embedding: createEmbedding(0, 1),
    });

    const targetEpisode = await database.getEpisodeBySourceId("openclaw", "episode-apr-9");
    expect(targetEpisode?.createdAt).toBe(now.toISOString());
    expect(targetEpisode?.startedAt).toBe(targetBounds.start);
    expect(targetEpisode?.endedAt).toBe(targetBounds.end);

    const relative = await runUnifiedRecall(
      {
        text: "what were we working on two days ago",
        mode: "episodes",
        limit: 5,
      },
      {
        database,
        procedures: createProcedureDatabase(),
        recall: createRecallPorts(),
        embeddingAvailable: true,
        embedQuery: async () => createEmbedding(0, 1),
        now,
      },
    );
    const explicitDate = await runUnifiedRecall(
      {
        text: "what happened on 2026-04-09",
        limit: 5,
      },
      {
        database,
        procedures: createProcedureDatabase(),
        recall: createRecallPorts(),
        embeddingAvailable: true,
        embedQuery: async () => createEmbedding(0, 1),
        now,
      },
    );

    expect(relative.timeWindow?.resolvedFrom).toBe("two days ago");
    expect(relative.episodes.map((episode) => episode.episode.sourceId)).toEqual(["episode-apr-9"]);
    expect(relative.episodes.map((episode) => episode.episode.sourceId)).not.toContain("episode-apr-8");
    expect(relative.episodes.map((episode) => episode.episode.sourceId)).not.toContain("episode-apr-10");
    expect(explicitDate.routing).toMatchObject({
      requested: "auto",
      detectedIntent: "temporal_narrative",
      queried: ["episodes"],
    });
    expect(explicitDate.timeWindow?.resolvedFrom).toBe("2026-04-09");
    expect(explicitDate.episodes.map((episode) => episode.episode.sourceId)).toEqual(["episode-apr-9"]);
  });

  it("returns a canonical procedure alongside supporting episodes for mixed procedural temporal queries", async () => {
    const database = createEpisodeDatabase({
      listEpisodesByTimeWindow: vi.fn(async () => [
        createEpisode({
          id: "rotation-episode",
          sourceId: "rotation-episode",
          startedAt: "2026-03-29T09:00:00.000Z",
          endedAt: "2026-03-29T10:00:00.000Z",
          summary: "We rotated the production signing key and verified downstream consumers.",
          tags: ["security", "signing-key"],
        }),
      ]),
    });
    const procedure = createProcedure({
      procedure_key: "security/signing-key-rotation",
      title: "Rotate the production signing key",
      goal: "Rotate the production signing key safely.",
      when_to_use: ["Use this when the production signing key must be rotated."],
    });

    const result = await runUnifiedRecall(
      {
        text: "what steps should I follow to rotate the production signing key on 2026-03-29",
        limit: 3,
      },
      {
        database,
        procedures: createProcedureDatabase({
          procedureFtsSearch: vi.fn(async () => [{ procedure, rank: -0.8 }]),
        }),
        recall: createRecallPorts(),
        embeddingAvailable: true,
        embedQuery: async () => createEmbedding(0, 1),
      },
    );

    expect(result.routing).toMatchObject({
      requested: "auto",
      detectedIntent: "mixed",
      queried: ["procedures", "episodes"],
    });
    expect(result.procedure).toMatchObject({
      procedure_key: "security/signing-key-rotation",
      title: "Rotate the production signing key",
    });
    expect(result.procedureCandidates).toHaveLength(1);
    expect(result.episodes.map((episode) => episode.episode.id)).toEqual(["rotation-episode"]);
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

function createProcedureDatabase(
  overrides: Partial<{
    procedureFtsSearch: ReturnType<typeof vi.fn>;
    procedureVectorSearch: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    upsertProcedure: vi.fn(),
    getProcedure: vi.fn(),
    hydrateProcedures: vi.fn(),
    findActiveProcedureByKey: vi.fn(),
    procedureFtsSearch: overrides.procedureFtsSearch ?? vi.fn(async () => []),
    procedureVectorSearch: overrides.procedureVectorSearch ?? vi.fn(async () => []),
    listProceduresWithoutEmbeddings: vi.fn(),
    updateProcedureEmbedding: vi.fn(),
    closeProcedureValidity: vi.fn(),
    supersedeProcedure: vi.fn(),
    replaceProcedureRevision: vi.fn(),
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
    supersededBy: overrides.supersededBy,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function createEntry(overrides: Partial<Durable> & Pick<Durable, "id" | "subject" | "content">): Durable {
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
    user_id: overrides.user_id,
    project: overrides.project,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  };
}

function createProcedure(overrides: Partial<Procedure> = {}): Procedure {
  const now = overrides.created_at ?? "2026-03-30T00:00:00.000Z";
  const body = {
    procedure_key: overrides.procedure_key ?? "security/signing-key-rotation",
    title: overrides.title ?? "Rotate the production signing key",
    goal: overrides.goal ?? "Rotate the production signing key safely.",
    when_to_use: overrides.when_to_use ?? ["Use this when the signing key must be rotated."],
    when_not_to_use: overrides.when_not_to_use ?? ["Do not use this for a read-only audit."],
    prerequisites: overrides.prerequisites ?? ["Access to the production key vault."],
    steps: overrides.steps ?? [
      {
        id: "inspect-state",
        kind: "inspect_state" as const,
        instruction: "Inspect the current signing key state before rotating it.",
        target: "signing key state",
      },
    ],
    verification: overrides.verification ?? ["Downstream verification succeeds after rotation."],
    failure_modes: overrides.failure_modes ?? ["Rotation fails before verification completes."],
    sources: overrides.sources ?? [{ kind: "manual" as const, label: "fixture" }],
  };

  return {
    id: overrides.id ?? randomUUID(),
    ...body,
    recall_text: overrides.recall_text ?? composeProcedureRecallText(body),
    revision_hash: overrides.revision_hash ?? computeProcedureRevisionHash(body),
    source_hash: overrides.source_hash ?? computeProcedureSourceHash(JSON.stringify(body)),
    source_file: overrides.source_file,
    embedding: overrides.embedding,
    superseded_by: overrides.superseded_by,
    created_at: now,
    updated_at: overrides.updated_at ?? now,
  };
}

function toRecallCandidateDurable(entry: Durable): RecallCandidateDurable {
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
    claim_support_observed_at: entry.claim_support_observed_at,
    valid_from: entry.valid_from,
    valid_to: entry.valid_to,
  };
}

async function createTestEpisodeDatabase(): Promise<SqlDatabase> {
  const databasePath = path.join(os.tmpdir(), `agenr-unified-recall-${randomUUID()}.sqlite`);
  databasePaths.push(databasePath);

  const database = await createDatabase(databasePath);
  databases.push(database);
  return database;
}

function createLocalDayBounds(year: number, monthIndex: number, day: number): { start: string; end: string } {
  return {
    start: new Date(year, monthIndex, day, 0, 0, 0, 0).toISOString(),
    end: new Date(year, monthIndex, day, 23, 59, 59, 999).toISOString(),
  };
}

function createEmbedding(index: number, value: number): number[] {
  const vector = Array.from({ length: 1024 }, () => 0);
  vector[index] = value;
  return vector;
}
