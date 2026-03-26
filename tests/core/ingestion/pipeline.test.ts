import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extractFile, ingestFile, storeExtractedResults, type ExtractedFileResult } from "../../../src/core/ingestion/pipeline.js";
import type { DatabasePort, EmbeddingPort, LlmPort, TranscriptPort } from "../../../src/core/ports.js";
import type { Entry, ParsedTranscript, StoreEntryInput } from "../../../src/core/types.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("extractFile", () => {
  it("returns extracted entries without storing them", async () => {
    const { filePath, fileHash } = await writeTranscriptFile("session-one");
    const db = new MockDatabase();
    const transcript = new MockTranscriptPort(
      buildTranscript({
        warnings: ["Parser warning"],
      }),
    );
    const llm = new MockLlmPort([
      {
        entries: [
          {
            type: "decision",
            subject: "package manager",
            content: "This repository uses pnpm for dependency management.",
            importance: "high",
            expiry: "permanent",
            tags: ["workflow"],
          },
        ],
      },
    ]);

    const result = await extractFile(
      filePath,
      {
        transcript,
        llm,
        db,
      },
      {
        wholeFile: "never",
      },
    );

    expect(result).toMatchObject({
      file: filePath,
      fileHash,
      skipped: false,
      messageCount: 2,
      warnings: ["Parser warning"],
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.source_file).toBe(filePath);
    expect(db.insertions).toEqual([]);
    expect(db.ingestLogInsertions).toEqual([]);
    expect(transcript.parseCalls).toEqual([filePath]);
    expect(llm.completeJsonCalls).toBe(1);
  });

  it("returns a skipped result when the ingest log hash matches", async () => {
    const { filePath, fileHash } = await writeTranscriptFile("session-two");
    const db = new MockDatabase({
      ingestLogEntry: {
        fileHash,
        ingestedAt: "2026-03-25T00:00:00.000Z",
      },
    });
    const transcript = new MockTranscriptPort(buildTranscript());
    const llm = new MockLlmPort([{ entries: [] }]);

    const result = await extractFile(filePath, { transcript, llm, db });

    expect(result).toMatchObject({
      file: filePath,
      fileHash,
      skipped: true,
      messageCount: 0,
      entries: [],
    });
    expect(transcript.parseCalls).toEqual([]);
    expect(llm.completeJsonCalls).toBe(0);
  });

  it("returns error information when transcript parsing fails", async () => {
    const { filePath, fileHash } = await writeTranscriptFile("session-three");
    const db = new MockDatabase();
    const transcript = new MockTranscriptPort(new Error("Malformed transcript"));
    const llm = new MockLlmPort([{ entries: [] }]);

    const result = await extractFile(filePath, { transcript, llm, db });

    expect(result).toMatchObject({
      file: filePath,
      fileHash,
      skipped: false,
      messageCount: 0,
      entries: [],
      error: "Malformed transcript",
      warnings: ["Malformed transcript"],
    });
    expect(db.ingestLogInsertions).toEqual([]);
  });
});

describe("storeExtractedResults", () => {
  it("batches entries from multiple files into one store phase", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();
    const results = [
      createExtractedFileResult({
        file: "/tmp/session-a.jsonl",
        fileHash: "hash-a",
        entries: [createInput({ subject: "one", content: "content-one", source_file: "/tmp/session-a.jsonl" })],
      }),
      createExtractedFileResult({
        file: "/tmp/session-b.jsonl",
        fileHash: "hash-b",
        entries: [createInput({ subject: "two", content: "content-two", source_file: "/tmp/session-b.jsonl" })],
      }),
    ];

    const stored = await storeExtractedResults(results, { db, embedding });

    expect(embedding.calls).toHaveLength(1);
    expect(db.insertions).toHaveLength(2);
    expect(db.transactionCount).toBe(1);
    expect(stored.get("/tmp/session-a.jsonl")?.storeResult).toEqual({
      stored: 1,
      skipped: 0,
      rejected: 0,
    });
    expect(stored.get("/tmp/session-b.jsonl")?.storeResult).toEqual({
      stored: 1,
      skipped: 0,
      rejected: 0,
    });
  });

  it("deduplicates matching normalized content across files", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();
    const results = [
      createExtractedFileResult({
        file: "/tmp/session-a.jsonl",
        fileHash: "hash-a",
        entries: [createInput({ content: "Hello, world!", source_file: "/tmp/session-a.jsonl" })],
      }),
      createExtractedFileResult({
        file: "/tmp/session-b.jsonl",
        fileHash: "hash-b",
        entries: [createInput({ content: "  hello world  ", source_file: "/tmp/session-b.jsonl" })],
      }),
    ];

    const stored = await storeExtractedResults(results, { db, embedding });

    expect(db.insertions).toHaveLength(1);
    expect(db.prepareCalls).toBe(1);
    expect(db.finalizeCalls).toBe(1);
    expect(stored.get("/tmp/session-a.jsonl")?.storeResult).toEqual({
      stored: 1,
      skipped: 0,
      rejected: 0,
    });
    expect(stored.get("/tmp/session-b.jsonl")?.storeResult).toEqual({
      stored: 0,
      skipped: 1,
      rejected: 0,
    });
  });

  it("updates the ingest log for every successfully extracted file", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();
    const results = [
      createExtractedFileResult({
        file: "/tmp/session-a.jsonl",
        fileHash: "hash-a",
        entries: [createInput({ content: "content-a", source_file: "/tmp/session-a.jsonl" })],
      }),
      createExtractedFileResult({
        file: "/tmp/session-b.jsonl",
        fileHash: "hash-b",
        entries: [],
      }),
    ];

    await storeExtractedResults(results, { db, embedding });

    expect(db.ingestLogInsertions).toEqual([
      {
        filePath: "/tmp/session-a.jsonl",
        fileHash: "hash-a",
        entryCount: 1,
      },
      {
        filePath: "/tmp/session-b.jsonl",
        fileHash: "hash-b",
        entryCount: 0,
      },
    ]);
  });

  it("passes precomputed survivor embeddings through to the store pipeline", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();
    const firstEntry = createInput({ subject: "one", content: "content-one", source_file: "/tmp/session-a.jsonl" });
    const secondEntry = createInput({ subject: "two", content: "content-two", source_file: "/tmp/session-b.jsonl" });
    const results = [
      createExtractedFileResult({
        file: "/tmp/session-a.jsonl",
        fileHash: "hash-a",
        entries: [firstEntry],
      }),
      createExtractedFileResult({
        file: "/tmp/session-b.jsonl",
        fileHash: "hash-b",
        entries: [secondEntry],
      }),
    ];
    const precomputedEmbeddings = new Map<StoreEntryInput, number[]>([
      [firstEntry, [10, 11]],
      [secondEntry, [20, 21]],
    ]);

    await storeExtractedResults(
      results,
      { db, embedding },
      {
        precomputedEmbeddings,
      },
    );

    expect(embedding.calls).toEqual([]);
    expect(db.insertions.map(({ embedding: vector }) => vector)).toEqual([
      [10, 11],
      [20, 21],
    ]);
  });

  it("prepares for bulk writes before storing and finalizes afterward", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();
    const results = [
      createExtractedFileResult({
        file: "/tmp/session-a.jsonl",
        fileHash: "hash-a",
        entries: [createInput({ content: "content-a", source_file: "/tmp/session-a.jsonl" })],
      }),
    ];

    await storeExtractedResults(results, { db, embedding });

    expect(db.prepareCalls).toBe(1);
    expect(db.finalizeCalls).toBe(1);
    expect(db.callOrder).toEqual(["prepare", "insert", "finalize"]);
  });

  it("finalizes bulk writes even when the store phase throws", async () => {
    const db = new MockDatabase({
      failInsertMessage: "insert failed",
    });
    const embedding = new MockEmbeddingPort();
    const results = [
      createExtractedFileResult({
        file: "/tmp/session-a.jsonl",
        fileHash: "hash-a",
        entries: [createInput({ content: "content-a", source_file: "/tmp/session-a.jsonl" })],
      }),
    ];

    await expect(storeExtractedResults(results, { db, embedding })).rejects.toThrow("insert failed");
    expect(db.prepareCalls).toBe(1);
    expect(db.finalizeCalls).toBe(1);
    expect(db.callOrder).toEqual(["prepare", "insert", "finalize"]);
  });

  it("skips store writes and ingest-log updates during a dry run", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();
    const results = [
      createExtractedFileResult({
        file: "/tmp/session-a.jsonl",
        fileHash: "hash-a",
        entries: [createInput({ content: "content-a", source_file: "/tmp/session-a.jsonl" })],
      }),
    ];

    const stored = await storeExtractedResults(
      results,
      {
        db,
        embedding,
      },
      {
        dryRun: true,
      },
    );

    expect(db.insertions).toEqual([]);
    expect(db.ingestLogInsertions).toEqual([]);
    expect(embedding.calls).toEqual([]);
    expect(db.prepareCalls).toBe(0);
    expect(db.finalizeCalls).toBe(0);
    expect(stored.get("/tmp/session-a.jsonl")?.storeResult).toEqual({
      stored: 0,
      skipped: 0,
      rejected: 0,
    });
  });
});

describe("ingestFile", () => {
  it("ingests a file by composing extract and store phases", async () => {
    const { filePath, fileHash } = await writeTranscriptFile("session-four");
    const db = new MockDatabase();
    const transcript = new MockTranscriptPort(buildTranscript());
    const llm = new MockLlmPort([
      {
        entries: [createInput({ content: "Stored from ingestFile", source_file: filePath })],
      },
    ]);
    const embedding = new MockEmbeddingPort();

    const result = await ingestFile(
      filePath,
      {
        transcript,
        llm,
        embedding,
        db,
      },
      {
        wholeFile: "never",
      },
    );

    expect(result.storeResult).toEqual({
      stored: 1,
      skipped: 0,
      rejected: 0,
    });
    expect(db.ingestLogInsertions).toEqual([
      {
        filePath,
        fileHash,
        entryCount: 1,
      },
    ]);
    expect(db.insertions[0]?.entry.source_file).toBe(filePath);
  });

  it("still skips an unchanged file", async () => {
    const { filePath, fileHash } = await writeTranscriptFile("session-five");
    const db = new MockDatabase({
      ingestLogEntry: {
        fileHash,
        ingestedAt: "2026-03-25T00:00:00.000Z",
      },
    });
    const transcript = new MockTranscriptPort(buildTranscript());
    const llm = new MockLlmPort([{ entries: [] }]);
    const embedding = new MockEmbeddingPort();

    const result = await ingestFile(filePath, { transcript, llm, embedding, db });

    expect(result).toMatchObject({
      file: filePath,
      skipped: true,
      entriesExtracted: 0,
      storeResult: null,
    });
    expect(db.insertions).toEqual([]);
    expect(db.ingestLogInsertions).toEqual([]);
  });
});

class MockDatabase implements DatabasePort {
  public readonly insertions: Array<{ entry: Entry; embedding: number[]; contentHash: string }> = [];
  public readonly ingestLogInsertions: Array<{ filePath: string; fileHash: string; entryCount: number }> = [];
  public readonly existingHashes: Set<string>;
  public readonly existingNormHashes: Set<string>;
  public readonly callOrder: string[] = [];
  public transactionCount = 0;
  public prepareCalls = 0;
  public finalizeCalls = 0;
  private readonly ingestLogEntry: { fileHash: string; ingestedAt: string } | null;
  private readonly failInsertMessage?: string;

  public constructor(
    options: {
      ingestLogEntry?: { fileHash: string; ingestedAt: string } | null;
      existingHashes?: Set<string>;
      existingNormHashes?: Set<string>;
      failInsertMessage?: string;
    } = {},
  ) {
    this.ingestLogEntry = options.ingestLogEntry ?? null;
    this.existingHashes = options.existingHashes ?? new Set();
    this.existingNormHashes = options.existingNormHashes ?? new Set();
    this.failInsertMessage = options.failInsertMessage;
  }

  public async insertEntry(entry: Entry, embedding: number[], contentHash: string): Promise<string> {
    this.callOrder.push("insert");
    if (this.failInsertMessage) {
      throw new Error(this.failInsertMessage);
    }
    this.insertions.push({ entry, embedding, contentHash });
    return entry.id;
  }

  public async prepareForBulkWrites(): Promise<void> {
    this.prepareCalls += 1;
    this.callOrder.push("prepare");
  }

  public async finalizeBulkWrites(): Promise<void> {
    this.finalizeCalls += 1;
    this.callOrder.push("finalize");
  }

  public async vectorSearch(): Promise<Array<{ id: string; score: number }>> {
    return [];
  }

  public async textSearch(): Promise<Array<{ id: string; score: number }>> {
    return [];
  }

  public async getEntries(): Promise<Entry[]> {
    return [];
  }

  public async getEntry(): Promise<Entry | null> {
    return null;
  }

  public async findExistingHashes(hashes: string[]): Promise<Set<string>> {
    return new Set(hashes.filter((hash) => this.existingHashes.has(hash)));
  }

  public async findExistingNormHashes(hashes: string[]): Promise<Set<string>> {
    return new Set(hashes.filter((hash) => this.existingNormHashes.has(hash)));
  }

  public async retireEntry(): Promise<boolean> {
    return false;
  }

  public async updateEntry(): Promise<boolean> {
    return false;
  }

  public async recordRecallEvent(): Promise<void> {}

  public async getIngestLogEntry(): Promise<{ fileHash: string; ingestedAt: string } | null> {
    return this.ingestLogEntry;
  }

  public async insertIngestLogEntry(filePath: string, fileHash: string, entryCount: number): Promise<void> {
    this.ingestLogInsertions.push({ filePath, fileHash, entryCount });
  }

  public async init(): Promise<void> {}

  public async close(): Promise<void> {}

  public async withTransaction<T>(fn: (db: DatabasePort) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    return fn(this);
  }
}

class MockEmbeddingPort implements EmbeddingPort {
  public readonly calls: string[][] = [];

  public async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return texts.map((_, index) => [index + 1, index + 2]);
  }
}

class MockLlmPort implements LlmPort {
  public completeJsonCalls = 0;

  public constructor(private readonly responses: unknown[]) {}

  public async complete(): Promise<string> {
    return "";
  }

  public async completeJson<T>(): Promise<T> {
    const response = this.responses[this.completeJsonCalls] ?? this.responses.at(-1) ?? { entries: [] };
    this.completeJsonCalls += 1;

    if (response instanceof Error) {
      throw response;
    }

    return response as T;
  }
}

class MockTranscriptPort implements TranscriptPort {
  public readonly parseCalls: string[] = [];

  public constructor(private readonly result: ParsedTranscript | Error) {}

  public async parseFile(filePath: string): Promise<ParsedTranscript> {
    this.parseCalls.push(filePath);

    if (this.result instanceof Error) {
      throw this.result;
    }

    return this.result;
  }
}

function buildTranscript(options: { warnings?: string[] } = {}): ParsedTranscript {
  return {
    messages: [
      {
        index: 0,
        role: "user",
        text: "We use pnpm in this repository.",
      },
      {
        index: 1,
        role: "assistant",
        text: "Understood.",
      },
    ],
    metadata: {},
    warnings: options.warnings ?? [],
  };
}

function createInput(overrides: Partial<StoreEntryInput> = {}): StoreEntryInput {
  return {
    type: overrides.type ?? "fact",
    subject: overrides.subject ?? "subject",
    content: overrides.content ?? "content",
    importance: overrides.importance,
    expiry: overrides.expiry,
    tags: overrides.tags,
    source_file: overrides.source_file,
    source_context: overrides.source_context,
  };
}

function createExtractedFileResult(overrides: Partial<ExtractedFileResult> = {}): ExtractedFileResult {
  const entries = overrides.entries ?? [];

  return {
    file: overrides.file ?? "/tmp/session.jsonl",
    skipped: overrides.skipped ?? false,
    messageCount: overrides.messageCount ?? 2,
    entries,
    chunkCount: overrides.chunkCount ?? (entries.length > 0 ? 1 : 0),
    successfulChunks: overrides.successfulChunks ?? (entries.length > 0 ? 1 : 0),
    failedChunks: overrides.failedChunks ?? 0,
    chunkDetails: overrides.chunkDetails ?? [],
    warnings: overrides.warnings ?? [],
    error: overrides.error,
    durationMs: overrides.durationMs ?? 10,
    fileHash:
      overrides.fileHash ??
      createHash("sha256")
        .update(entries.map((entry) => entry.content).join("\n"))
        .digest("hex"),
  };
}

async function writeTranscriptFile(content: string): Promise<{ filePath: string; fileHash: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "agenr-ingest-pipeline-"));
  tempDirectories.push(directory);

  const filePath = path.join(directory, "session.jsonl");
  await writeFile(filePath, content, "utf8");

  return {
    filePath,
    fileHash: createHash("sha256").update(content).digest("hex"),
  };
}
