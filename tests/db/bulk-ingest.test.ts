import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import * as clack from "@clack/prompts";
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
  backfillBulkColumns,
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
  const raw = record[key];
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

function makeLlmClient(): LlmClient {
  return {
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
}

function makeIngestDeps(params: {
  db: Client;
  filePath: string;
  extractKnowledgeFromChunksFn: IngestCommandDeps["extractKnowledgeFromChunksFn"];
  embedFn?: IngestCommandDeps["embedFn"];
}): IngestCommandDeps {
  const parsed: ParsedTranscript = {
    file: params.filePath,
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

  return {
    readConfigFn: () => ({ db: { path: ":memory:" } }),
    resolveEmbeddingApiKeyFn: () => "sk-test",
    expandInputFilesFn: async () => [params.filePath],
    parseTranscriptFileFn: async () => parsed,
    createLlmClientFn: () => makeLlmClient(),
    extractKnowledgeFromChunksFn: params.extractKnowledgeFromChunksFn,
    deduplicateEntriesFn: (entries) => entries,
    getDbFn: () => params.db,
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
    embedFn: params.embedFn ?? (async (texts: string[]) => texts.map((_text, index) => embedding(index + 1))),
  };
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

  it("handles empty and short text minhash edge cases", () => {
    expect(() => computeMinhashSig("")).not.toThrow();
    const shortSig = computeMinhashSig("abc");
    expect(shortSig).toBeInstanceOf(Uint32Array);
    expect(shortSig.length).toBe(128);

    const same = computeMinhashSig("identical short text");
    expect(minhashJaccard(same, same)).toBe(1);
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

  it("backfillBulkColumns fills missing norm_content_hash and minhash_sig columns", async () => {
    const db = makeClient();
    await initDb(db);

    for (let i = 0; i < 5; i += 1) {
      const entry = makeEntry(`legacy content ${i}`);
      await insertEntryWithHashes(db, entry, i + 1);
      await db.execute({
        sql: "UPDATE entries SET norm_content_hash = NULL, minhash_sig = NULL WHERE content = ?",
        args: [entry.content],
      });
    }

    const updated = await backfillBulkColumns(db);
    expect(updated).toBe(5);

    const result = await db.execute(`
      SELECT
        SUM(CASE WHEN norm_content_hash IS NOT NULL THEN 1 ELSE 0 END) AS norm_count,
        SUM(CASE WHEN minhash_sig IS NOT NULL THEN 1 ELSE 0 END) AS minhash_count
      FROM entries
    `);
    const row = result.rows[0] as { norm_count?: unknown; minhash_count?: unknown } | undefined;
    expect(countFromRow({ cnt: row?.norm_count })).toBe(5);
    expect(countFromRow({ cnt: row?.minhash_count })).toBe(5);
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
    expect(calls[1]).toBe("BEGIN IMMEDIATE");
    expect(calls[2]).toBe("DROP INDEX IF EXISTS idx_entries_embedding");
    expect(String(calls[3])).toContain("idx_entries_embedding");
    expect(String(calls[3])).toContain(CREATE_IDX_ENTRIES_EMBEDDING_SQL.trim().split("\n")[1]?.trim() ?? "CREATE");
    expect(calls[4]).toBe("COMMIT");
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

  it("checkAndRecoverBulkIngest restores missing vector index when triggers already exist", async () => {
    const db = makeClient();
    await initDb(db);
    await insertEntryWithHashes(db, makeEntry("vector-only recovery content"), 1);

    expect(await triggerCount(db)).toBe(3);
    await db.execute("DROP INDEX IF EXISTS idx_entries_embedding");
    await setBulkIngestMeta(db, "rebuilding_vector");

    await checkAndRecoverBulkIngest(db);

    expect(await triggerCount(db)).toBe(3);
    expect(await hasVectorIndex(db)).toBe(true);
    expect(await getBulkIngestMeta(db)).toBe(null);
  });

  it("ignores --bulk behavior when --dry-run is enabled", async () => {
    const warnSpy = vi.spyOn(clack.log, "warn");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-bulk-ingest-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "sample.txt");
    await fs.writeFile(filePath, "bulk ingest source", "utf8");

    const db = makeClient();
    const deps = makeIngestDeps({
      db,
      filePath,
      extractKnowledgeFromChunksFn: async (params) => {
        const duplicated = makeEntry("Dry run bulk content", filePath);
        await params.onChunkComplete?.({
          chunkIndex: 0,
          totalChunks: 1,
          entries: [duplicated],
          warnings: [],
        });
        return {
          entries: [],
          successfulChunks: 1,
          failedChunks: 0,
          warnings: [],
        };
      },
    });

    const result = await runIngestCommand([dir], { bulk: true, dryRun: true, workers: 1, concurrency: 1 }, deps);
    expect(result.exitCode).toBe(0);

    expect(await triggerCount(db)).toBe(3);
    expect(await getBulkIngestMeta(db)).toBe(null);
    const rowCountResult = await db.execute("SELECT COUNT(*) AS cnt FROM entries");
    expect(countFromRow(rowCountResult.rows[0])).toBe(0);
    expect(
      warnSpy.mock.calls.some((call) => String(call[0]).includes("--bulk is ignored when --dry-run is enabled")),
    ).toBe(true);
  });

  it("bulk ingest intra-batch dedup inserts one row and restores post-rebuild state", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-bulk-ingest-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "sample.txt");
    await fs.writeFile(filePath, "bulk ingest source", "utf8");

    const db = makeClient();
    const deps = makeIngestDeps({
      db,
      filePath,
      extractKnowledgeFromChunksFn: async (params) => {
        const duplicated = makeEntry("Identical duplicate content for bulk mode test", filePath);
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
    });

    const result = await runIngestCommand([dir], { bulk: true, workers: 1, concurrency: 1 }, deps);
    expect(result.exitCode).toBe(0);

    const rowCountResult = await db.execute("SELECT COUNT(*) AS cnt FROM entries");
    expect(countFromRow(rowCountResult.rows[0])).toBe(1);
    expect(result.dedupStats.entries_skipped).toBe(1);
    expect(await getBulkIngestMeta(db)).toBe(null);
    expect(await triggerCount(db)).toBe(3);
    expect(await hasVectorIndex(db)).toBe(true);

    const ftsMatches = await db.execute({
      sql: "SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?",
      args: ["duplicate"],
    });
    expect(ftsMatches.rows.length).toBeGreaterThan(0);
  });

  it("bulk ingest deduplicates across chunk batches using seenNormHashes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-bulk-ingest-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "sample.txt");
    await fs.writeFile(filePath, "bulk ingest source", "utf8");

    const db = makeClient();
    const deps = makeIngestDeps({
      db,
      filePath,
      extractKnowledgeFromChunksFn: async (params) => {
        const entry = makeEntry("Cross batch duplicate content", filePath);
        await params.onChunkComplete?.({
          chunkIndex: 0,
          totalChunks: 2,
          entries: [entry],
          warnings: [],
        });
        await params.onChunkComplete?.({
          chunkIndex: 1,
          totalChunks: 2,
          entries: [entry],
          warnings: [],
        });
        return {
          entries: [],
          successfulChunks: 2,
          failedChunks: 0,
          warnings: [],
        };
      },
    });

    const result = await runIngestCommand([dir], { bulk: true, workers: 1, concurrency: 1 }, deps);
    expect(result.exitCode).toBe(0);

    const rowCountResult = await db.execute("SELECT COUNT(*) AS cnt FROM entries");
    expect(countFromRow(rowCountResult.rows[0])).toBe(1);
    expect(result.dedupStats.entries_skipped).toBe(1);
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
