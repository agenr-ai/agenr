import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IngestCommandDeps } from "../../src/commands/ingest.js";
import { runIngestCommand } from "../../src/commands/ingest.js";
import { initDb, checkAndRecoverBulkIngest } from "../../src/db/client.js";
import {
  bufferToMinhashSig,
  computeMinhashSig,
  computeNormContentHash,
  minhashJaccard,
  minhashSigToBuffer,
} from "../../src/db/minhash.js";
import {
  findDuplicateBulk,
  hashText,
  insertEntry,
} from "../../src/db/store.js";
import {
  CREATE_IDX_ENTRIES_EMBEDDING_SQL,
  dropFtsTriggersAndIndex,
  getBulkIngestMeta,
  rebuildFtsAndTriggers,
  rebuildVectorIndex,
  setBulkIngestMeta,
} from "../../src/db/schema.js";
import { WriteQueue, type WriteQueueOptions } from "../../src/ingest/write-queue.js";
import type { KnowledgeEntry, LlmClient, ParsedTranscript } from "../../src/types.js";

const clients: Client[] = [];
const tempDirs: string[] = [];

function makeClient(): Client {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  return client;
}

function countFromRow(row: unknown, key = "cnt"): number {
  if (!row || typeof row !== "object") {
    return 0;
  }
  const record = row as Record<string, unknown>;
  const raw = record[key] ?? Object.values(record)[0];
  if (typeof raw === "number") {
    return raw;
  }
  if (typeof raw === "bigint") {
    return Number(raw);
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function embedding(seed = 1): number[] {
  const vector = Array.from({ length: 1024 }, () => 0);
  vector[0] = seed;
  return vector;
}

function makeEntry(content: string, sourceFile = "bulk-ingest.test.txt"): KnowledgeEntry {
  return {
    type: "fact",
    subject: "Bulk ingest subject",
    content,
    importance: 7,
    expiry: "temporary",
    tags: ["bulk"],
    source: {
      file: sourceFile,
      context: "test",
    },
  };
}

async function insertEntryWithHashes(
  db: Client,
  entry: KnowledgeEntry,
  seed = 1,
): Promise<void> {
  await insertEntry(
    db,
    entry,
    embedding(seed),
    hashText(entry.content),
    computeNormContentHash(entry.content),
    minhashSigToBuffer(computeMinhashSig(entry.content)),
  );
}

async function triggerCount(db: Client): Promise<number> {
  const result = await db.execute(`
    SELECT COUNT(*) AS cnt
    FROM sqlite_master
    WHERE type = 'trigger' AND name IN ('entries_ai', 'entries_ad', 'entries_au')
  `);
  return countFromRow(result.rows[0]);
}

async function hasVectorIndex(db: Client): Promise<boolean> {
  const result = await db.execute(`
    SELECT COUNT(*) AS cnt
    FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_entries_embedding'
  `);
  return countFromRow(result.rows[0]) === 1;
}

afterEach(async () => {
  vi.restoreAllMocks();

  while (clients.length > 0) {
    clients.pop()?.close();
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("bulk ingest helpers", () => {
  it("computeNormContentHash normalizes case/spacing/punctuation", () => {
    const a = computeNormContentHash("Hello,   WORLD!!");
    const b = computeNormContentHash(" hello world ");
    const c = computeNormContentHash("HELLO world");

    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("computeMinhashSig yields higher similarity for near-identical text", () => {
    const nearA = "The quick brown fox jumps over the lazy dog near the river bank.";
    const nearB = "The quick brown fox jumps over the lazy dog near the river side bank.";
    const far = "Launch window moved to next week because weather conditions deteriorated overnight.";

    const nearSim = minhashJaccard(computeMinhashSig(nearA), computeMinhashSig(nearB));
    const farSim = minhashJaccard(computeMinhashSig(nearA), computeMinhashSig(far));

    expect(nearSim).toBeGreaterThan(0.72);
    expect(farSim).toBeLessThan(0.3);
  });

  it("round-trips minhash signatures through Buffer without loss", () => {
    const sig = computeMinhashSig("round trip signature test");
    const buffer = minhashSigToBuffer(sig);
    const roundTrip = bufferToMinhashSig(buffer);

    expect(Array.from(roundTrip)).toEqual(Array.from(sig));
  });

  it("findDuplicateBulk detects hash match, minhash match, and novel content", async () => {
    const db = makeClient();
    await initDb(db);

    const existing = makeEntry("The quick brown fox jumps over the lazy dog near the river bank.");
    await insertEntryWithHashes(db, existing, 1);

    const exactNormHash = computeNormContentHash(existing.content);
    const exactSig = computeMinhashSig(existing.content);
    await expect(findDuplicateBulk(db, exactNormHash, exactSig)).resolves.toBe(true);

    const nearContent = "The quick brown fox jumps over the lazy dog near the river side bank.";
    const nearNormHash = computeNormContentHash(nearContent);
    const nearSig = computeMinhashSig(nearContent);
    await expect(findDuplicateBulk(db, nearNormHash, nearSig, 0.65)).resolves.toBe(true);

    const novelContent = "The roadmap now includes native mobile telemetry and incremental sync.";
    const novelNormHash = computeNormContentHash(novelContent);
    const novelSig = computeMinhashSig(novelContent);
    await expect(findDuplicateBulk(db, novelNormHash, novelSig, 0.65)).resolves.toBe(false);
  });

  it("dropFtsTriggersAndIndex removes triggers/index but keeps entries_fts virtual table", async () => {
    const db = makeClient();
    await initDb(db);

    await dropFtsTriggersAndIndex(db);

    expect(await triggerCount(db)).toBe(0);
    expect(await hasVectorIndex(db)).toBe(false);

    const ftsTable = await db.execute({
      sql: "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      args: ["entries_fts"],
    });
    expect(ftsTable.rows.length).toBe(1);
    expect(String((ftsTable.rows[0] as { sql?: unknown }).sql ?? "")).toContain("VIRTUAL TABLE");
  });

  it("rebuildFtsAndTriggers recreates triggers and rebuilds FTS content", async () => {
    const db = makeClient();
    await initDb(db);
    await insertEntryWithHashes(db, makeEntry("outage mitigation runbook updated"), 1);

    await dropFtsTriggersAndIndex(db);
    await rebuildFtsAndTriggers(db);

    expect(await triggerCount(db)).toBe(3);

    const ftsMatches = await db.execute({
      sql: "SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?",
      args: ["outage"],
    });
    expect(ftsMatches.rows.length).toBeGreaterThan(0);

    const ftsTable = await db.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      args: ["entries_fts"],
    });
    expect(ftsTable.rows.length).toBe(1);
  });

  it("rebuildVectorIndex falls back to drop+create when REINDEX fails", async () => {
    const execute = vi.fn(async (statement: string) => {
      if (statement === "REINDEX idx_entries_embedding") {
        throw new Error("reindex unsupported");
      }
      return { rows: [] };
    });
    const mockDb = { execute } as unknown as Client;

    await expect(rebuildVectorIndex(mockDb)).resolves.toBeUndefined();

    const calls = execute.mock.calls.map((call) => call[0]);
    expect(calls[0]).toBe("REINDEX idx_entries_embedding");
    expect(calls[1]).toBe("DROP INDEX IF EXISTS idx_entries_embedding");
    expect(String(calls[2])).toContain("idx_entries_embedding");
    expect(String(calls[2])).toContain(CREATE_IDX_ENTRIES_EMBEDDING_SQL.trim().split("\n")[1]?.trim() ?? "CREATE");
  });

  it("checkAndRecoverBulkIngest restores dropped objects and clears meta flag", async () => {
    const db = makeClient();
    await initDb(db);

    await setBulkIngestMeta(db, "writing");
    await dropFtsTriggersAndIndex(db);

    await checkAndRecoverBulkIngest(db);

    expect(await triggerCount(db)).toBe(3);
    expect(await hasVectorIndex(db)).toBe(true);
    await expect(getBulkIngestMeta(db)).resolves.toBe(null);
  });

  it("bulk ingest intra-batch dedup inserts one row for duplicate entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-bulk-ingest-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "sample.txt");
    await fs.writeFile(filePath, "bulk ingest source", "utf8");

    const db = makeClient();
    const parsed: ParsedTranscript = {
      file: filePath,
      messages: [],
      chunks: [
        {
          chunk_index: 0,
          message_start: 0,
          message_end: 0,
          text: "chunk",
          context_hint: "ctx",
        },
      ],
      warnings: [],
    };
    const llmClient = {
      auth: "openai-api-key",
      resolvedModel: {
        provider: "openai",
        modelId: "gpt-4o",
        model: {},
      },
      credentials: {
        apiKey: "sk-test",
        source: "test",
      },
    } as unknown as LlmClient;

    const deps: IngestCommandDeps = {
      readConfigFn: () => ({ db: { path: ":memory:" } }),
      resolveEmbeddingApiKeyFn: () => "sk-test",
      expandInputFilesFn: async () => [filePath],
      parseTranscriptFileFn: async () => parsed,
      createLlmClientFn: () => llmClient,
      extractKnowledgeFromChunksFn: async (params) => {
        const duplicated = makeEntry("Identical duplicate content for bulk mode", filePath);
        await params.onChunkComplete?.({
          chunkIndex: 0,
          totalChunks: 1,
          entries: [duplicated, duplicated],
          warnings: [],
        });
        return {
          entries: [],
          successfulChunks: 1,
          failedChunks: 0,
          warnings: [],
        };
      },
      deduplicateEntriesFn: (entries) => entries,
      getDbFn: () => db,
      initDbFn: initDb,
      closeDbFn: () => undefined,
      storeEntriesFn: async () => ({
        added: 0,
        updated: 0,
        skipped: 0,
        superseded: 0,
        llm_dedup_calls: 0,
        relations_created: 0,
        total_entries: 0,
        duration_ms: 0,
      }),
      hashTextFn: hashText,
      loadWatchStateFn: async () => ({ version: 1 as const, files: {} }),
      saveWatchStateFn: async () => undefined,
      isWatcherRunningFn: async () => false,
      readWatcherPidFn: async () => null,
      resolveWatcherPidPathFn: () => "/tmp/agenr-watch.pid",
      nowFn: () => new Date("2026-02-22T00:00:00.000Z"),
      sleepFn: async () => undefined,
      shouldShutdownFn: () => false,
      createWriteQueueFn: (opts: WriteQueueOptions) => new WriteQueue(opts),
      embedFn: async (texts: string[]) => texts.map((_text, index) => embedding(index + 1)),
    };

    const result = await runIngestCommand([dir], { bulk: true, workers: 1, concurrency: 1 }, deps);
    expect(result.exitCode).toBe(0);

    const rowCountResult = await db.execute("SELECT COUNT(*) AS cnt FROM entries");
    expect(countFromRow(rowCountResult.rows[0])).toBe(1);
  });

  it("initDb default does not trigger bulk recovery check", async () => {
    const db = makeClient();
    await initDb(db);
    await setBulkIngestMeta(db, "writing");

    await initDb(db);

    const meta = await getBulkIngestMeta(db);
    expect(meta).not.toBe(null);
    expect(meta?.phase).toBe("writing");
  });
});
