import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { createRecallAdapter } from "../../../src/adapters/db/recall-adapter.js";
import type { Entry } from "../../../src/core/types.js";

describe("createDatabase", () => {
  const databases: SqlDatabase[] = [];
  const databasePaths: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();

    while (databases.length > 0) {
      await databases.pop()?.close();
    }

    while (databasePaths.length > 0) {
      await rm(databasePaths.pop() ?? "", { force: true });
    }
  });

  it("inserts an entry and reads it back", async () => {
    const database = await createTestDatabase();
    const entry = createEntry({
      subject: "hexagonal boundary",
      content: "Core must not import adapters.",
      tags: ["arch", "decision"],
    });

    await database.insertEntry(entry, createEmbedding(0, 1), "hash-a");

    const stored = await database.getEntry(entry.id);

    expect(stored).not.toBeNull();
    expect(stored?.id).toBe(entry.id);
    expect(stored?.subject).toBe(entry.subject);
    expect(stored?.content_hash).toBe("hash-a");
    expect(stored?.embedding?.[0]).toBeCloseTo(1);
  });

  it("finds existing hashes in batches and ignores missing hashes", async () => {
    const database = await createTestDatabase();
    const entry = createEntry();

    await database.insertEntry(entry, createEmbedding(0, 1), "hash-existing");

    const hashes = Array.from({ length: 205 }, (_, index) => `hash-${index}`);
    hashes[17] = "hash-existing";
    const matches = await database.findExistingHashes(["hash-existing", "missing", ...hashes]);

    expect(matches).toEqual(new Set(["hash-existing"]));
  });

  it("finds existing normalized hashes in batches and ignores missing hashes", async () => {
    const database = await createTestDatabase();
    const entry = createEntry({
      norm_content_hash: "norm-existing",
    });

    await database.insertEntry(entry, createEmbedding(0, 1), "hash-existing");

    const hashes = Array.from({ length: 205 }, (_, index) => `norm-${index}`);
    hashes[23] = "norm-existing";
    const matches = await database.findExistingNormHashes(["norm-existing", "missing", ...hashes]);

    expect(matches).toEqual(new Set(["norm-existing"]));
  });

  it("returns vector matches when vector search is supported", async () => {
    const database = await createTestDatabase();
    const adapter = createRecallAdapter(database, createEmbeddingPort());
    const left = createEntry({ subject: "vector left" });
    const right = createEntry({ subject: "vector right" });

    await database.insertEntry(left, createEmbedding(0, 1), "vector-left");
    await database.insertEntry(right, createEmbedding(1, 1), "vector-right");

    try {
      const results = await adapter.vectorSearch({
        embedding: createEmbedding(0, 1),
        limit: 2,
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results.map((result) => result.entry.id)).toContain(left.id);
      expect(results.some((result) => result.vectorSim > 0)).toBe(true);
    } catch (error) {
      expect(String(error)).toMatch(/vector search is unavailable/i);
    }
  });

  it("returns FTS matches for active entries", async () => {
    const database = await createTestDatabase();
    const adapter = createRecallAdapter(database, createEmbeddingPort());
    const entry = createEntry({
      subject: "batch write design",
      content: "Batch write operations avoid the v0 pressure bottleneck.",
    });

    await database.insertEntry(entry, createEmbedding(0, 1), "fts-hash");

    const results = await adapter.ftsSearch({ text: "pressure bottleneck", limit: 5 });

    expect(results.map((result) => result.entry.id)).toContain(entry.id);
  });

  it("inserts entries while FTS triggers are dropped and makes them searchable after finalize", async () => {
    const database = await createTestDatabase();
    const adapter = createRecallAdapter(database, createEmbeddingPort());
    const entry = createEntry({
      subject: "bulk insert",
      content: "Bulk mode should rebuild FTS after insert.",
    });

    await database.prepareForBulkWrites();
    await database.insertEntry(entry, createEmbedding(0, 1), "bulk-insert-hash");

    expect(await database.getEntry(entry.id)).not.toBeNull();
    expect(await adapter.ftsSearch({ text: "rebuild FTS", limit: 5 })).toEqual([]);

    await database.finalizeBulkWrites();

    const results = await adapter.ftsSearch({ text: "rebuild FTS", limit: 5 });
    expect(results.map((result) => result.entry.id)).toContain(entry.id);
  });

  it("inserts entries while the vector index is dropped", async () => {
    const database = await createTestDatabase();
    const entry = createEntry({
      subject: "vector drop",
      content: "Insert should still succeed without the vector index.",
    });

    await database.prepareForBulkWrites();
    await expect(database.insertEntry(entry, createEmbedding(0, 1), "vector-drop-hash")).resolves.toBe(entry.id);

    const stored = await database.getEntry(entry.id);
    expect(stored?.embedding?.[0]).toBeCloseTo(1);

    await database.finalizeBulkWrites();
  });

  it("excludes retired entries from active queries", async () => {
    const database = await createTestDatabase();
    const adapter = createRecallAdapter(database, createEmbeddingPort());
    const entry = createEntry({
      subject: "retired memory",
      content: "This entry should disappear from active queries.",
      norm_content_hash: "retired-norm",
    });

    await database.insertEntry(entry, createEmbedding(0, 1), "retired-hash");
    await database.retireEntry(entry.id, "superseded");

    expect(await database.getEntry(entry.id)).toBeNull();
    expect(await database.findExistingHashes(["retired-hash"])).toEqual(new Set());
    expect(await database.findExistingNormHashes(["retired-norm"])).toEqual(new Set());
    expect(await adapter.ftsSearch({ text: "disappear", limit: 5 })).toEqual([]);
  });

  it("updates entry importance and expiry", async () => {
    const database = await createTestDatabase();
    const entry = createEntry({ importance: 4, expiry: "temporary" });

    await database.insertEntry(entry, createEmbedding(0, 1), "update-hash");
    const updated = await database.updateEntry(entry.id, {
      importance: 9,
      expiry: "permanent",
    });
    const stored = await database.getEntry(entry.id);

    expect(updated).toBe(true);
    expect(stored?.importance).toBe(9);
    expect(stored?.expiry).toBe("permanent");
  });

  it("records recall events by updating recall counters", async () => {
    const database = await createTestDatabase();
    const adapter = createRecallAdapter(database, createEmbeddingPort());
    const entry = createEntry();

    await database.insertEntry(entry, createEmbedding(0, 1), "recall-hash");
    await adapter.recordRecallEvents({
      entryIds: [entry.id],
      query: "hexagonal",
      sessionKey: "session-1",
    });

    const stored = await database.getEntry(entry.id);

    expect(stored?.recall_count).toBe(1);
    expect(stored?.last_recalled_at).toBeTruthy();
  });

  it("stores and retrieves ingest log entries", async () => {
    const database = await createTestDatabase();

    await database.insertIngestLogEntry("/tmp/session.jsonl", "file-hash", 3);

    expect(await database.getIngestLogEntry("/tmp/session.jsonl")).toEqual({
      fileHash: "file-hash",
      ingestedAt: expect.any(String),
    });
  });

  it("rolls back a transaction when the callback fails", async () => {
    const database = await createTestDatabase();
    const entry = createEntry({ subject: "rollback target" });

    await expect(
      database.withTransaction(async (tx) => {
        await tx.insertEntry(entry, createEmbedding(0, 1), "rollback-hash");
        throw new Error("rollback please");
      }),
    ).rejects.toThrow("rollback please");

    expect(await database.getEntry(entry.id)).toBeNull();
  });

  it("round-trips tags as a JSON array", async () => {
    const database = await createTestDatabase();
    const entry = createEntry({
      tags: ["arch", "decision", "batch-write"],
    });

    await database.insertEntry(entry, createEmbedding(0, 1), "tags-hash");

    const stored = await database.getEntry(entry.id);

    expect(stored?.tags).toEqual(["arch", "decision", "batch-write"]);
  });

  it("upserts and hydrates episodes by source id", async () => {
    const database = await createTestDatabase();

    const result = await database.upsertEpisode(
      createEpisodeInput({
        sourceId: "session-1",
        transcriptHash: "transcript-1",
        summary: "We implemented episodic memory writes for predecessor sessions.",
        tags: ["OpenClaw", "agenr", "memory"],
        activityLevel: "substantial",
        project: "agenr",
        surface: "tui",
      }),
    );
    const bySourceId = await database.getEpisodeBySourceId("openclaw", "session-1");
    const byTranscriptHash = await database.getEpisodeByTranscriptHash("openclaw", "transcript-1");

    expect(result.action).toBe("inserted");
    expect(result.episode.sourceId).toBe("session-1");
    expect(result.episode.sourceRef).toBe("/tmp/session-1.jsonl");
    expect(result.episode.summaryHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.episode.surface).toBe("tui");
    expect(result.episode.tags).toEqual(["agenr", "memory", "openclaw"]);
    expect(bySourceId).toEqual(result.episode);
    expect(byTranscriptHash?.id).toBe(result.episode.id);
  });

  it("returns unchanged for normalized episode payload matches without bumping updated_at", async () => {
    vi.useFakeTimers();

    const database = await createTestDatabase();
    vi.setSystemTime(new Date("2026-03-30T10:00:00.000Z"));
    const inserted = await database.upsertEpisode(
      createEpisodeInput({
        sourceId: "session-2",
        transcriptHash: "transcript-2",
        summary: "We settled the database contract for episodic writes.",
        tags: ["db", "episodes", "OpenClaw"],
      }),
    );

    vi.setSystemTime(new Date("2026-03-30T11:00:00.000Z"));
    const unchanged = await database.upsertEpisode(
      createEpisodeInput({
        sourceId: "session-2",
        transcriptHash: "transcript-2",
        summary: "  We settled the database contract for episodic writes.  ",
        tags: ["openclaw", "db", "episodes"],
      }),
    );

    expect(inserted.action).toBe("inserted");
    expect(unchanged.action).toBe("unchanged");
    expect(unchanged.episode.id).toBe(inserted.episode.id);
    expect(unchanged.episode.updatedAt).toBe(inserted.episode.updatedAt);
  });

  it("updates changed episode payloads and refreshes updated_at", async () => {
    vi.useFakeTimers();

    const database = await createTestDatabase();
    vi.setSystemTime(new Date("2026-03-30T12:00:00.000Z"));
    const inserted = await database.upsertEpisode(
      createEpisodeInput({
        sourceId: "session-3",
        transcriptHash: "transcript-3",
        summary: "We added a first pass at episode storage.",
        tags: ["episodes", "storage"],
        activityLevel: "minimal",
      }),
    );

    vi.setSystemTime(new Date("2026-03-30T13:00:00.000Z"));
    const updated = await database.upsertEpisode(
      createEpisodeInput({
        sourceId: "session-3",
        transcriptHash: "transcript-3",
        summary: "We added episode storage and wired the OpenClaw background writer.",
        tags: ["openclaw", "episodes", "storage"],
        activityLevel: "substantial",
        project: "agenr",
        surface: "webchat",
      }),
    );

    expect(updated.action).toBe("updated");
    expect(updated.episode.id).toBe(inserted.episode.id);
    expect(updated.episode.updatedAt).not.toBe(inserted.episode.updatedAt);
    expect(updated.episode.summary).toContain("background writer");
    expect(updated.episode.activityLevel).toBe("substantial");
    expect(updated.episode.project).toBe("agenr");
    expect(updated.episode.surface).toBe("webchat");
  });

  it("falls back to transcript-hash dedup when sourceId is absent", async () => {
    const database = await createTestDatabase();

    const inserted = await database.upsertEpisode(
      createEpisodeInput({
        sourceId: undefined,
        transcriptHash: "transcript-fallback",
        sourceRef: "/tmp/fallback.jsonl",
        summary: "We captured a fallback episode identity from transcript hash only.",
      }),
    );
    const unchanged = await database.upsertEpisode(
      createEpisodeInput({
        sourceId: undefined,
        transcriptHash: "transcript-fallback",
        sourceRef: "/tmp/fallback.jsonl",
        summary: "We captured a fallback episode identity from transcript hash only.",
      }),
    );

    expect(inserted.action).toBe("inserted");
    expect(unchanged.action).toBe("unchanged");
    expect(unchanged.episode.id).toBe(inserted.episode.id);
  });

  it("lists active overlapping episodes by time window and respects limits", async () => {
    const database = await createTestDatabase();

    const overlappingA = await database.upsertEpisode(
      createEpisodeInput({
        sourceId: "episode-a",
        transcriptHash: "episode-a-hash",
        startedAt: "2026-03-28T09:00:00.000Z",
        endedAt: "2026-03-28T10:00:00.000Z",
        summary: "Episode A overlapped the requested window.",
      }),
    );
    await database.upsertEpisode(
      createEpisodeInput({
        sourceId: "episode-b",
        transcriptHash: "episode-b-hash",
        startedAt: "2026-03-28T12:00:00.000Z",
        endedAt: "2026-03-28T13:00:00.000Z",
        summary: "Episode B also overlapped the requested window.",
      }),
    );
    const retired = await database.upsertEpisode(
      createEpisodeInput({
        sourceId: "episode-c",
        transcriptHash: "episode-c-hash",
        startedAt: "2026-03-28T11:15:00.000Z",
        endedAt: "2026-03-28T11:45:00.000Z",
        summary: "Episode C should be filtered once retired.",
      }),
    );
    await database.upsertEpisode(
      createEpisodeInput({
        sourceId: "episode-d",
        transcriptHash: "episode-d-hash",
        startedAt: "2026-03-29T09:00:00.000Z",
        endedAt: "2026-03-29T10:00:00.000Z",
        summary: "Episode D is outside the window.",
      }),
    );
    await database.execute({
      sql: `
        UPDATE episodes
        SET retired = 1,
            retired_at = ?,
            updated_at = ?
        WHERE id = ?
      `,
      args: ["2026-03-30T00:00:00.000Z", "2026-03-30T00:00:00.000Z", retired.episode.id],
    });

    const episodes = await database.listEpisodesByTimeWindow(
      {
        kind: "interval",
        start: new Date("2026-03-28T09:30:00.000Z"),
        end: new Date("2026-03-28T12:30:00.000Z"),
        source: "explicit",
      },
      1,
    );

    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.id).not.toBe(retired.episode.id);
    expect(episodes[0]?.id).not.toBe(overlappingA.episode.id);
    expect(episodes[0]?.sourceId).toBe("episode-b");
  });

  async function createTestDatabase(): Promise<SqlDatabase> {
    // libSQL opens separate logical connections for transactions, so temp files
    // are more stable than raw :memory: databases for adapter-level tests.
    const databasePath = path.join(os.tmpdir(), `agenr-db-${randomUUID()}.sqlite`);
    databasePaths.push(databasePath);

    const database = await createDatabase(databasePath);
    databases.push(database);
    return database;
  }
});

function createEntry(overrides: Partial<Entry> = {}): Entry {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? randomUUID(),
    type: overrides.type ?? "decision",
    subject: overrides.subject ?? "batch lookup",
    content: overrides.content ?? "Chunk hash lookups to avoid parameter pressure.",
    importance: overrides.importance ?? 7,
    expiry: overrides.expiry ?? "permanent",
    tags: overrides.tags ?? ["db"],
    source_file: overrides.source_file,
    source_context: overrides.source_context,
    embedding: overrides.embedding,
    content_hash: overrides.content_hash,
    norm_content_hash: overrides.norm_content_hash,
    quality_score: overrides.quality_score ?? 0.5,
    recall_count: overrides.recall_count ?? 0,
    last_recalled_at: overrides.last_recalled_at,
    superseded_by: overrides.superseded_by,
    cluster_id: overrides.cluster_id,
    retired: overrides.retired ?? false,
    retired_at: overrides.retired_at,
    retired_reason: overrides.retired_reason,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  };
}

function createEmbedding(index: number, value: number): number[] {
  const vector = Array.from({ length: 1024 }, () => 0);
  vector[index] = value;
  return vector;
}

function createEmbeddingPort() {
  return {
    embed: async (texts: string[]): Promise<number[][]> => texts.map((_, index) => createEmbedding(index, 1)),
  };
}

function createEpisodeInput(
  overrides: Partial<{
    sourceId: string | undefined;
    sourceRef: string;
    transcriptHash: string;
    startedAt: string;
    endedAt: string;
    summary: string;
    tags: string[];
    activityLevel: "substantial" | "minimal" | "none";
    project: string | undefined;
    surface: string | undefined;
  }> = {},
) {
  const sourceId = "sourceId" in overrides ? overrides.sourceId : "session-default";

  return {
    source: "openclaw" as const,
    ...(sourceId !== undefined ? { sourceId } : {}),
    sourceRef: overrides.sourceRef ?? `/tmp/${sourceId ?? "session-default"}.jsonl`,
    transcriptHash: overrides.transcriptHash ?? `${sourceId ?? "session-default"}-hash`,
    startedAt: overrides.startedAt ?? "2026-03-28T10:00:00.000Z",
    endedAt: overrides.endedAt ?? "2026-03-28T11:00:00.000Z",
    summary: overrides.summary ?? "We wrote a durable episodic-memory summary.",
    tags: overrides.tags ?? ["episodes", "memory"],
    activityLevel: overrides.activityLevel ?? "substantial",
    ...(overrides.project !== undefined ? { project: overrides.project } : {}),
    ...(overrides.surface !== undefined ? { surface: overrides.surface } : {}),
  };
}
