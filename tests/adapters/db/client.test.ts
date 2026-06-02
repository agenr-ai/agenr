import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, rm } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { createRecallAdapter } from "../../../src/adapters/db/recall-adapter.js";
import { computeProcedureRevisionHash, computeProcedureSourceHash } from "../../../src/core/procedures/hashing.js";
import { composeProcedureRecallText } from "../../../src/core/procedures/recall-text.js";
import type { Entry, Procedure } from "../../../src/core/types.js";
import { removeTestPath, waitForDatabaseRelease } from "../../helpers/temp-paths.js";

describe("createDatabase", () => {
  const databases: SqlDatabase[] = [];
  const databasePaths: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();

    while (databases.length > 0) {
      await databases.pop()?.close();
    }

    await waitForDatabaseRelease();

    while (databasePaths.length > 0) {
      await removeTestPath(databasePaths.pop() ?? "");
    }
  });

  it("opens file URLs and creates missing parent directories", async () => {
    const databaseRoot = path.join(os.tmpdir(), `agenr db url ${randomUUID()}`);
    const databasePath = path.join(databaseRoot, "nested dir", "knowledge.db");
    databasePaths.push(databaseRoot);

    const database = await createDatabase(pathToFileURL(databasePath).href);
    databases.push(database);
    const entry = createEntry({
      subject: "file URL database",
      content: "File URL database paths create their parent directories.",
    });

    await database.insertEntry(entry, createEmbedding(0, 1), "file-url-hash");

    expect(await database.getEntry(entry.id)).toMatchObject({
      id: entry.id,
      subject: "file URL database",
    });
  });

  it("opens relative file URLs and creates missing parent directories", async () => {
    const databaseRoot = path.join(os.tmpdir(), `agenr db relative url ${randomUUID()}`);
    databasePaths.push(databaseRoot);
    const previousCwd = process.cwd();

    try {
      await mkdir(databaseRoot, { recursive: true });
      process.chdir(databaseRoot);
      const database = await createDatabase("file:relative%20dir/knowledge.db");
      databases.push(database);
      const entry = createEntry({
        subject: "relative file URL database",
        content: "Relative file URL database paths create their parent directories.",
      });

      await database.insertEntry(entry, createEmbedding(0, 1), "relative-file-url-hash");

      expect(await database.getEntry(entry.id)).toMatchObject({
        id: entry.id,
        subject: "relative file URL database",
      });
    } finally {
      process.chdir(previousCwd);
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

  it("accepts optional claim-key lifecycle metadata on insert payloads", async () => {
    const database = await createTestDatabase();
    const entry = createEntry({
      claim_key: "jim/home_city",
      claim_key_raw: "Jim / Home City",
      claim_key_status: "trusted",
      claim_key_source: "manual",
      claim_key_confidence: 1,
      claim_key_rationale: "manual claim key supplied by caller",
      claim_support_source_kind: "tool_call",
      claim_support_locator: "transcript.jsonl#message:3",
      claim_support_observed_at: "2026-04-07T12:00:00.000Z",
      claim_support_mode: "explicit",
    });

    await expect(database.insertEntry(entry, createEmbedding(0, 1), "claim-lifecycle-hash")).resolves.toBe(entry.id);

    const stored = await database.getEntry(entry.id);

    expect(stored).toMatchObject({
      id: entry.id,
      claim_key: "jim/home_city",
      claim_key_raw: "Jim / Home City",
      claim_key_status: "trusted",
      claim_key_source: "manual",
      claim_key_confidence: 1,
      claim_key_rationale: "manual claim key supplied by caller",
      claim_support_source_kind: "tool_call",
      claim_support_locator: "transcript.jsonl#message:3",
      claim_support_observed_at: "2026-04-07T12:00:00.000Z",
      claim_support_mode: "explicit",
    });
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

  it("updates entry claim keys and validity metadata", async () => {
    const database = await createTestDatabase();
    const entry = createEntry({
      importance: 4,
      expiry: "temporary",
    });
    const sibling = createEntry({
      subject: "model choice",
      content: "agenr defaults to gpt-5.4-mini for extraction.",
      claim_key: "agenr/default_model",
    });

    await database.insertEntry(entry, createEmbedding(0, 1), "update-claim-hash");
    await database.insertEntry(sibling, createEmbedding(1, 1), "sibling-claim-hash");
    const updated = await database.updateEntry(entry.id, {
      claim_key: "jim/home_city",
      claim_key_raw: " Jim / Home City ",
      claim_key_status: "trusted",
      claim_key_source: "manual",
      claim_key_confidence: 1,
      claim_key_rationale: "manual claim key supplied by caller",
      claim_support_source_kind: "tool_call",
      claim_support_locator: "openclaw-session:agent:main:webchat:test#agenr_update",
      claim_support_observed_at: "2026-03-15T12:00:00.000Z",
      claim_support_mode: "explicit",
      valid_from: "2026-03-01T00:00:00.000Z",
      valid_to: "2026-03-15T00:00:00.000Z",
    });
    const stored = await database.getEntry(entry.id);
    const claimMatches = await database.findActiveEntriesByClaimKey("jim/home_city");
    const claimPrefixes = await database.getDistinctClaimKeyPrefixes();
    const claimKeyExamples = await database.getClaimKeyExamples?.();

    expect(updated).toBe(true);
    expect(stored?.claim_key).toBe("jim/home_city");
    expect(stored?.claim_key_raw).toBe("Jim / Home City");
    expect(stored?.claim_key_status).toBe("trusted");
    expect(stored?.claim_key_source).toBe("manual");
    expect(stored?.claim_key_confidence).toBe(1);
    expect(stored?.claim_key_rationale).toBe("manual claim key supplied by caller");
    expect(stored?.claim_support_source_kind).toBe("tool_call");
    expect(stored?.claim_support_locator).toBe("openclaw-session:agent:main:webchat:test#agenr_update");
    expect(stored?.claim_support_observed_at).toBe("2026-03-15T12:00:00.000Z");
    expect(stored?.claim_support_mode).toBe("explicit");
    expect(stored?.valid_from).toBe("2026-03-01T00:00:00.000Z");
    expect(stored?.valid_to).toBe("2026-03-15T00:00:00.000Z");
    expect(claimMatches.map((candidate) => candidate.id)).toEqual([entry.id]);
    expect(claimPrefixes).toEqual(["agenr", "jim"]);
    expect(claimKeyExamples).toEqual(["agenr/default_model", "jim/home_city"]);
  });

  it("replaces the full lifecycle bundle on direct claim-key updates", async () => {
    const database = await createTestDatabase();
    const entry = createEntry({
      claim_key: "jim/timezone",
      claim_key_raw: "Jim / Timezone",
      claim_key_status: "trusted",
      claim_key_source: "manual",
      claim_key_confidence: 1,
      claim_key_rationale: "manual claim key supplied by caller",
      claim_support_source_kind: "tool_call",
      claim_support_locator: "openclaw-session:agent:main:webchat:test#agenr_update",
      claim_support_observed_at: "2026-03-01T00:00:00.000Z",
      claim_support_mode: "explicit",
    });

    await database.insertEntry(entry, createEmbedding(0, 1), "replace-lifecycle-hash");
    const updated = await database.updateEntry(entry.id, {
      claim_key: "jim/home_city",
      claim_key_raw: "Jim / Home City",
      claim_key_status: "trusted",
      claim_key_source: "surgeon_compaction",
      claim_key_confidence: 0.99,
      claim_key_rationale: 'Canonical normalization preserves the slot while rewriting "Jim / Home City".',
    });
    const stored = await database.getEntry(entry.id);

    expect(updated).toBe(true);
    expect(stored).toMatchObject({
      claim_key: "jim/home_city",
      claim_key_raw: "Jim / Home City",
      claim_key_status: "trusted",
      claim_key_source: "surgeon_compaction",
      claim_key_confidence: 0.99,
      claim_key_rationale: 'Canonical normalization preserves the slot while rewriting "Jim / Home City".',
      claim_support_source_kind: undefined,
      claim_support_locator: undefined,
      claim_support_observed_at: undefined,
      claim_support_mode: undefined,
    });
  });

  it("rejects invalid claim-key lifecycle statuses on direct updates", async () => {
    const database = await createTestDatabase();
    const entry = createEntry();

    await database.insertEntry(entry, createEmbedding(0, 1), "invalid-status-hash");

    await expect(
      database.updateEntry(entry.id, {
        claim_key: "jim/home_city",
        claim_key_status: "legacy" as Entry["claim_key_status"],
        claim_key_source: "manual",
        claim_key_confidence: 1,
        claim_key_rationale: "manual claim key supplied by caller",
      }),
    ).rejects.toThrow(/claim_key_status/i);
  });

  it("rejects invalid claim-key lifecycle sources on direct updates", async () => {
    const database = await createTestDatabase();
    const entry = createEntry();

    await database.insertEntry(entry, createEmbedding(0, 1), "invalid-source-hash");

    await expect(
      database.updateEntry(entry.id, {
        claim_key: "jim/home_city",
        claim_key_status: "trusted",
        claim_key_source: "handwritten" as Entry["claim_key_source"],
        claim_key_confidence: 1,
        claim_key_rationale: "manual claim key supplied by caller",
      }),
    ).rejects.toThrow(/claim_key_source/i);
  });

  it("rejects invalid claim-support modes on direct updates", async () => {
    const database = await createTestDatabase();
    const entry = createEntry();

    await database.insertEntry(entry, createEmbedding(0, 1), "invalid-support-mode-hash");

    await expect(
      database.updateEntry(entry.id, {
        claim_key: "jim/home_city",
        claim_key_status: "trusted",
        claim_key_source: "manual",
        claim_key_confidence: 1,
        claim_key_rationale: "manual claim key supplied by caller",
        claim_support_mode: "copied" as Entry["claim_support_mode"],
      }),
    ).rejects.toThrow(/claim_support_mode/i);
  });

  it("rejects invalid lifecycle confidence values on direct updates", async () => {
    const database = await createTestDatabase();
    const entry = createEntry();

    await database.insertEntry(entry, createEmbedding(0, 1), "invalid-confidence-hash");

    await expect(
      database.updateEntry(entry.id, {
        claim_key: "jim/home_city",
        claim_key_status: "trusted",
        claim_key_source: "manual",
        claim_key_confidence: 1.2,
        claim_key_rationale: "manual claim key supplied by caller",
      }),
    ).rejects.toThrow(/claim_key_confidence/i);
  });

  it("rejects partial lifecycle payloads on direct updates", async () => {
    const database = await createTestDatabase();
    const entry = createEntry();

    await database.insertEntry(entry, createEmbedding(0, 1), "partial-lifecycle-hash");

    await expect(
      database.updateEntry(entry.id, {
        claim_key: "jim/home_city",
      }),
    ).rejects.toThrow(/complete lifecycle payload/i);
  });

  it("supports importance-only direct updates without lifecycle fields", async () => {
    const database = await createTestDatabase();
    const entry = createEntry({ importance: 4 });

    await database.insertEntry(entry, createEmbedding(0, 1), "importance-only-hash");

    await expect(database.updateEntry(entry.id, { importance: 8 })).resolves.toBe(true);
    expect((await database.getEntry(entry.id))?.importance).toBe(8);
  });

  it("supports expiry-only direct updates without lifecycle fields", async () => {
    const database = await createTestDatabase();
    const entry = createEntry({ expiry: "temporary" });

    await database.insertEntry(entry, createEmbedding(0, 1), "expiry-only-hash");

    await expect(database.updateEntry(entry.id, { expiry: "core" })).resolves.toBe(true);
    expect((await database.getEntry(entry.id))?.expiry).toBe("core");
  });

  it("supports validity-only direct updates without lifecycle fields", async () => {
    const database = await createTestDatabase();
    const entry = createEntry();

    await database.insertEntry(entry, createEmbedding(0, 1), "validity-only-hash");

    await expect(
      database.updateEntry(entry.id, {
        valid_from: "2026-03-01T00:00:00.000Z",
        valid_to: "2026-03-31T00:00:00.000Z",
      }),
    ).resolves.toBe(true);
    expect(await database.getEntry(entry.id)).toMatchObject({
      valid_from: "2026-03-01T00:00:00.000Z",
      valid_to: "2026-03-31T00:00:00.000Z",
    });
  });

  it("rejects invalid temporal validity ranges on direct updates", async () => {
    const database = await createTestDatabase();
    const entry = createEntry();

    await database.insertEntry(entry, createEmbedding(0, 1), "invalid-validity-range-hash");

    await expect(
      database.updateEntry(entry.id, {
        valid_from: "2026-04-01T00:00:00.000Z",
        valid_to: "2026-03-01T00:00:00.000Z",
      }),
    ).rejects.toThrow("valid_from must be earlier than valid_to.");
  });

  it("rejects one-sided validity updates that would invert an existing persisted range", async () => {
    const database = await createTestDatabase();
    const entry = createEntry({
      valid_from: "2026-03-01T00:00:00.000Z",
      valid_to: "2026-03-31T00:00:00.000Z",
    });

    await database.insertEntry(entry, createEmbedding(0, 1), "existing-validity-range-hash");

    await expect(
      database.updateEntry(entry.id, {
        valid_from: "2026-04-15T00:00:00.000Z",
      }),
    ).rejects.toThrow("valid_from must be earlier than valid_to.");
  });

  it("supersedes an active entry and removes it from active recall surfaces", async () => {
    const database = await createTestDatabase();
    const adapter = createRecallAdapter(database, createEmbeddingPort());
    const original = createEntry({
      subject: "Jim home city",
      content: "Jim lives in Austin, Texas.",
      claim_key: "jim/home_city",
    });
    const replacement = createEntry({
      subject: "Jim home city",
      content: "Jim lives in Denver, Colorado.",
      claim_key: "jim/home_city",
    });

    await database.insertEntry(original, createEmbedding(0, 1), "supersede-old-hash");
    await database.insertEntry(replacement, createEmbedding(1, 1), "supersede-new-hash");

    const superseded = await database.supersedeEntry(original.id, replacement.id, "update");
    const row = await database.execute({
      sql: `
        SELECT superseded_by, supersession_kind
        FROM entries
        WHERE id = ?
      `,
      args: [original.id],
    });
    const activeClaimMatches = await database.findActiveEntriesByClaimKey("jim/home_city");

    expect(superseded).toBe(true);
    expect(row.rows[0]).toMatchObject({
      superseded_by: replacement.id,
      supersession_kind: "update",
    });
    expect(await database.getEntry(original.id)).toBeNull();
    expect(await database.getEntry(replacement.id)).not.toBeNull();
    expect(activeClaimMatches.map((entry) => entry.id)).toEqual([replacement.id]);
    expect((await adapter.ftsSearch({ text: "Austin", limit: 5 })).map((result) => result.entry.id)).not.toContain(original.id);

    try {
      const vectorResults = await adapter.vectorSearch({
        embedding: createEmbedding(0, 1),
        limit: 5,
      });
      expect(vectorResults.map((result) => result.entry.id)).not.toContain(original.id);
    } catch (error) {
      expect(String(error)).toMatch(/vector search is unavailable/i);
    }
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

  it("stores source session time separately from row creation time for episodes", async () => {
    vi.useFakeTimers();

    const database = await createTestDatabase();
    const insertedAt = new Date("2026-04-11T12:00:00.000Z");
    vi.setSystemTime(insertedAt);

    const result = await database.upsertEpisode(
      createEpisodeInput({
        sourceId: "session-old-source-time",
        transcriptHash: "session-old-source-time-hash",
        startedAt: "2026-04-09T09:00:00.000Z",
        endedAt: "2026-04-09T10:00:00.000Z",
        summary: "We investigated episode temporal recall for older sessions.",
      }),
    );

    expect(result.episode.startedAt).toBe("2026-04-09T09:00:00.000Z");
    expect(result.episode.endedAt).toBe("2026-04-09T10:00:00.000Z");
    expect(result.episode.createdAt).toBe(insertedAt.toISOString());
    expect(result.episode.updatedAt).toBe(insertedAt.toISOString());
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

  it("lists episodes missing embeddings and updates embeddings in place", async () => {
    vi.useFakeTimers();

    const database = await createTestDatabase();
    vi.setSystemTime(new Date("2026-03-30T12:00:00.000Z"));
    const missing = await database.upsertEpisode(
      createEpisodeInput({
        sourceId: "missing-embedding",
        transcriptHash: "missing-embedding-hash",
        summary: "This episode still needs an embedding.",
      }),
    );
    const embedded = await database.upsertEpisode(
      createEpisodeInput({
        sourceId: "has-embedding",
        transcriptHash: "has-embedding-hash",
        summary: "This episode already has an embedding.",
        embedding: createEmbedding(0, 1),
      }),
    );

    const missingEpisodes = await database.listEpisodesWithoutEmbeddings();
    expect(missingEpisodes.map((episode) => episode.id)).toEqual([missing.episode.id]);

    vi.setSystemTime(new Date("2026-03-30T13:00:00.000Z"));
    await database.updateEpisodeEmbedding(missing.episode.id, createEmbedding(1, 1));

    const updated = await database.getEpisodeBySourceId("openclaw", "missing-embedding");
    expect(updated?.embedding?.[1]).toBeCloseTo(1);
    expect(updated?.updatedAt).toBe("2026-03-30T13:00:00.000Z");

    const remainingMissing = await database.listEpisodesWithoutEmbeddings();
    expect(remainingMissing).toEqual([]);
    expect(embedded.episode.embedding?.[0]).toBeCloseTo(1);
  });

  it("returns vector-ranked episode matches when vector search is supported", async () => {
    const database = await createTestDatabase();
    await database.upsertEpisode(
      createEpisodeInput({
        sourceId: "semantic-left",
        transcriptHash: "semantic-left-hash",
        summary: "Left semantic episode.",
        embedding: createEmbedding(0, 1),
      }),
    );
    await database.upsertEpisode(
      createEpisodeInput({
        sourceId: "semantic-right",
        transcriptHash: "semantic-right-hash",
        summary: "Right semantic episode.",
        embedding: createEmbedding(1, 1),
      }),
    );

    try {
      const results = await database.episodeVectorSearch({
        embedding: createEmbedding(0, 1),
        limit: 2,
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.episode.sourceId).toBe("semantic-left");
      expect(results[0]?.vectorSim).toBeGreaterThan(0);
    } catch (error) {
      expect(String(error)).toMatch(/episode vector search is unavailable/i);
    }
  });

  it("upserts a procedure and reads it back through active lookups", async () => {
    const database = await createTestDatabase();
    const procedure = createProcedure({
      procedure_key: "agenr/release",
      title: "Release agenr and publish packages",
    });

    const stored = await database.upsertProcedure(procedure);
    const byId = await database.getProcedure(stored.id);
    const byKey = await database.findActiveProcedureByKey("agenr/release");
    const hydrated = await database.hydrateProcedures([stored.id]);

    expect(stored.id).toBe(procedure.id);
    expect(byId?.procedure_key).toBe("agenr/release");
    expect(byKey?.id).toBe(procedure.id);
    expect(hydrated.map((item) => item.id)).toEqual([procedure.id]);
  });

  it("returns procedure FTS matches for active procedures", async () => {
    const database = await createTestDatabase();
    const procedure = createProcedure({
      procedure_key: "agenr/sandbox-validation",
      title: "Validate the sandbox plugin locally",
      goal: "Run the local sandbox plugin validation workflow safely.",
    });

    await database.upsertProcedure(procedure);

    const results = await database.procedureFtsSearch({ text: "sandbox plugin validation", limit: 5 });

    expect(results.map((result) => result.procedure.id)).toContain(procedure.id);
  });

  it("matches procedure FTS results for natural-language queries through lexical tier fallback", async () => {
    const database = await createTestDatabase();
    const procedure = createProcedure({
      procedure_key: "agenr/release",
      title: "Release agenr and publish packages",
      goal: "Cut a release and publish packages safely.",
    });

    await database.upsertProcedure(procedure);

    const results = await database.procedureFtsSearch({ text: "how do I do an agenr release", limit: 5 });

    expect(results.map((result) => result.procedure.id)).toContain(procedure.id);
  });

  it("returns procedure vector matches when vector search is supported", async () => {
    const database = await createTestDatabase();
    const left = createProcedure({
      procedure_key: "agenr/release",
      title: "Release agenr",
      embedding: createEmbedding(0, 1),
    });
    const right = createProcedure({
      procedure_key: "agenr/surgeon-review",
      title: "Review surgeon proposals",
      embedding: createEmbedding(1, 1),
    });

    await database.upsertProcedure(left);
    await database.upsertProcedure(right);

    try {
      const results = await database.procedureVectorSearch({
        embedding: createEmbedding(0, 1),
        limit: 2,
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results.map((result) => result.procedure.id)).toContain(left.id);
      expect(results.some((result) => result.vectorSim > 0)).toBe(true);
    } catch (error) {
      expect(String(error)).toMatch(/procedure vector search is unavailable/i);
    }
  });

  it("lists procedures without embeddings and updates procedure embeddings", async () => {
    vi.useFakeTimers();

    const database = await createTestDatabase();
    vi.setSystemTime(new Date("2026-03-30T12:00:00.000Z"));
    const procedure = createProcedure({
      procedure_key: "agenr/openclaw-local-plugin-check",
      embedding: undefined,
      created_at: "2026-03-30T12:00:00.000Z",
      updated_at: "2026-03-30T12:00:00.000Z",
    });

    await database.upsertProcedure(procedure);

    const missing = await database.listProceduresWithoutEmbeddings();
    expect(missing.map((item) => item.id)).toContain(procedure.id);

    vi.setSystemTime(new Date("2026-03-30T13:00:00.000Z"));
    await database.updateProcedureEmbedding(procedure.id, createEmbedding(0, 1));

    const updated = await database.getProcedure(procedure.id);
    expect(updated?.embedding?.[0]).toBeCloseTo(1);
    expect(updated?.updated_at).toBe("2026-03-30T13:00:00.000Z");
  });

  it("updates procedure source metadata in place when the row id stays the same", async () => {
    vi.useFakeTimers();

    const database = await createTestDatabase();
    vi.setSystemTime(new Date("2026-03-31T09:00:00.000Z"));
    const original = createProcedure({
      id: "procedure-release",
      procedure_key: "agenr/release",
      source_file: "procedures/agenr-release.yaml",
      source_hash: "source-hash-a",
      created_at: "2026-03-31T09:00:00.000Z",
      updated_at: "2026-03-31T09:00:00.000Z",
    });

    await database.upsertProcedure(original);

    vi.setSystemTime(new Date("2026-03-31T10:00:00.000Z"));
    await database.upsertProcedure({
      ...original,
      source_hash: "source-hash-b",
      source_file: "procedures/release.yaml",
      updated_at: "2026-03-31T10:00:00.000Z",
    });

    const stored = await database.getProcedure(original.id);
    const byKey = await database.findActiveProcedureByKey("agenr/release");

    expect(stored).toMatchObject({
      id: "procedure-release",
      source_hash: "source-hash-b",
      source_file: "procedures/release.yaml",
      created_at: "2026-03-31T09:00:00.000Z",
      updated_at: "2026-03-31T10:00:00.000Z",
    });
    expect(byKey?.id).toBe("procedure-release");
  });

  it("excludes retired and superseded procedures from active queries", async () => {
    const database = await createTestDatabase();
    const retired = createProcedure({
      id: "procedure-retired",
      procedure_key: "agenr/sandbox-validation",
    });
    const superseded = createProcedure({
      id: "procedure-superseded",
      procedure_key: "agenr/release",
    });
    const replacement = createProcedure({
      id: "procedure-replacement",
      procedure_key: "agenr/release-next",
    });

    await database.upsertProcedure(retired);
    await database.upsertProcedure(superseded);
    await database.upsertProcedure(replacement);

    expect(await database.retireProcedure(retired.id, "obsolete")).toBe(true);
    expect(await database.supersedeProcedure(superseded.id, replacement.id, "new revision")).toBe(true);

    expect(await database.getProcedure(retired.id)).toBeNull();
    expect(await database.getProcedure(superseded.id)).toBeNull();
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
    valid_from: overrides.valid_from,
    valid_to: overrides.valid_to,
    claim_key: overrides.claim_key,
    claim_key_raw: overrides.claim_key_raw,
    claim_key_status: overrides.claim_key_status,
    claim_key_source: overrides.claim_key_source,
    claim_key_confidence: overrides.claim_key_confidence,
    claim_key_rationale: overrides.claim_key_rationale,
    claim_support_source_kind: overrides.claim_support_source_kind,
    claim_support_locator: overrides.claim_support_locator,
    claim_support_observed_at: overrides.claim_support_observed_at,
    claim_support_mode: overrides.claim_support_mode,
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

function createProcedure(overrides: Partial<Procedure> = {}): Procedure {
  const now = new Date().toISOString();
  const body = {
    procedure_key: overrides.procedure_key ?? "agenr/release",
    title: overrides.title ?? "Release agenr and publish packages",
    goal: overrides.goal ?? "Cut a release and publish packages safely.",
    when_to_use: overrides.when_to_use ?? ["You need to ship a new agenr release."],
    when_not_to_use: overrides.when_not_to_use ?? ["You only need a local build or dry-run validation."],
    prerequisites: overrides.prerequisites ?? ["Publish credentials are configured."],
    steps: overrides.steps ?? [
      {
        id: "read-release-skill",
        kind: "read_reference" as const,
        instruction: "Read the local release workflow.",
        ref: {
          kind: "manual" as const,
          label: "release workflow",
        },
      },
      {
        id: "run-checks",
        kind: "run_command" as const,
        instruction: "Run the required repo validation command.",
        command: "pnpm check",
      },
    ],
    verification: overrides.verification ?? ["Published package versions match the intended release."],
    failure_modes: overrides.failure_modes ?? ["Validation fails before publish."],
    sources: overrides.sources ?? [
      {
        kind: "manual" as const,
        label: "procedure fixture",
      },
    ],
  };

  return {
    id: overrides.id ?? randomUUID(),
    ...body,
    recall_text: overrides.recall_text ?? composeProcedureRecallText(body),
    revision_hash: overrides.revision_hash ?? computeProcedureRevisionHash(body),
    source_hash: overrides.source_hash ?? computeProcedureSourceHash(JSON.stringify(body)),
    source_file: overrides.source_file,
    embedding: overrides.embedding,
    retired: overrides.retired ?? false,
    retired_at: overrides.retired_at,
    retired_reason: overrides.retired_reason,
    superseded_by: overrides.superseded_by,
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
    embedding: number[];
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
    ...(overrides.embedding !== undefined ? { embedding: overrides.embedding } : {}),
  };
}
