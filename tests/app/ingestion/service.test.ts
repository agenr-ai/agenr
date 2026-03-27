import { describe, expect, it } from "vitest";

import { ingestPath } from "../../../src/app/ingestion/index.js";
import type { IngestFilePort, IngestionLlmPort, UsageStats } from "../../../src/app/ingestion/ports.js";
import type { DatabasePort, EmbeddingPort, TranscriptPort } from "../../../src/core/ports.js";
import type { Entry, ParsedTranscript, StoreEntryInput } from "../../../src/core/types.js";

describe("ingestPath", () => {
  it("discovers files and reuses dedup embeddings during store", async () => {
    const files = ["/tmp/session-a.jsonl", "/tmp/session-b.jsonl"];
    const filePort = new MockFilePort(files, {
      "/tmp/session-a.jsonl": "hash-a",
      "/tmp/session-b.jsonl": "hash-b",
    });
    const transcript = new MockTranscriptPort(buildTranscript());
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();
    let llmIndex = 0;
    const extractionResponses = [
      {
        entries: [
          createInput({
            subject: "one",
            content: "This is durable content from the first extracted file.",
            source_file: files[0],
          }),
        ],
      },
      {
        entries: [
          createInput({
            subject: "two",
            content: "This is durable content from the second extracted file.",
            source_file: files[1],
          }),
        ],
      },
    ];

    const result = await ingestPath(
      "/tmp",
      {
        files: filePort,
        transcript,
        db,
        embedding,
        createExtractionLlm: () => new MockIngestionLlm(extractionResponses[llmIndex++] ?? { entries: [] }),
      },
      {
        skipDedup: true,
        wholeFile: "never",
      },
    );

    expect(result.files).toEqual(files);
    expect(result.extractionRuns).toHaveLength(2);
    expect(embedding.calls).toHaveLength(1);
    expect(db.insertions.map(({ embedding: vector }) => vector)).toEqual([
      [1, 2],
      [2, 3],
    ]);
    expect(db.ingestLogInsertions).toEqual([
      {
        filePath: "/tmp/session-a.jsonl",
        fileHash: "hash-a",
        entryCount: 1,
      },
      {
        filePath: "/tmp/session-b.jsonl",
        fileHash: "hash-b",
        entryCount: 1,
      },
    ]);
  });

  it("returns an empty result when discovery finds no files", async () => {
    const result = await ingestPath(
      "/tmp",
      {
        files: new MockFilePort([], {}),
        transcript: new MockTranscriptPort(buildTranscript()),
        db: new MockDatabase(),
        embedding: new MockEmbeddingPort(),
        createExtractionLlm: () => new MockIngestionLlm({ entries: [] }),
      },
      {
        skipDedup: true,
      },
    );

    expect(result.files).toEqual([]);
    expect(result.extractionRuns).toEqual([]);
    expect(result.storeResults.size).toBe(0);
  });
});

class MockFilePort implements IngestFilePort {
  public constructor(
    private readonly discoveredFiles: string[],
    private readonly hashes: Record<string, string>,
  ) {}

  public async discoverFiles(): Promise<string[]> {
    return this.discoveredFiles;
  }

  public async computeFileHash(filePath: string): Promise<string> {
    return this.hashes[filePath] ?? "missing-hash";
  }
}

class MockDatabase implements DatabasePort {
  public readonly insertions: Array<{ entry: Entry; embedding: number[]; contentHash: string }> = [];
  public readonly ingestLogInsertions: Array<{ filePath: string; fileHash: string; entryCount: number }> = [];
  public transactionCount = 0;
  public prepareCalls = 0;
  public finalizeCalls = 0;

  public async insertEntry(entry: Entry, embedding: number[], contentHash: string): Promise<string> {
    this.insertions.push({ entry, embedding, contentHash });
    return entry.id;
  }

  public async prepareForBulkWrites(): Promise<void> {
    this.prepareCalls += 1;
  }

  public async finalizeBulkWrites(): Promise<void> {
    this.finalizeCalls += 1;
  }

  public async getEntries(): Promise<Entry[]> {
    return [];
  }

  public async getEntry(): Promise<Entry | null> {
    return null;
  }

  public async findExistingHashes(): Promise<Set<string>> {
    return new Set();
  }

  public async findExistingNormHashes(): Promise<Set<string>> {
    return new Set();
  }

  public async retireEntry(): Promise<boolean> {
    return false;
  }

  public async updateEntry(): Promise<boolean> {
    return false;
  }

  public async getIngestLogEntry(): Promise<{ fileHash: string; ingestedAt: string } | null> {
    return null;
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

class MockTranscriptPort implements TranscriptPort {
  public readonly parseCalls: string[] = [];

  public constructor(private readonly result: ParsedTranscript) {}

  public async parseFile(filePath: string): Promise<ParsedTranscript> {
    this.parseCalls.push(filePath);
    return this.result;
  }
}

class MockIngestionLlm implements IngestionLlmPort {
  public readonly metadata: { contextWindowTokens: number; maxOutputTokens: number; usage: UsageStats } = {
    contextWindowTokens: 16_000,
    maxOutputTokens: 4_000,
    usage: {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      totalCost: 0,
    },
  };

  public constructor(private readonly response: unknown) {}

  public async complete(): Promise<string> {
    throw new Error("complete should not be used in this test.");
  }

  public async completeJson<T>(): Promise<T> {
    this.metadata.usage.calls += 1;
    return this.response as T;
  }
}

function buildTranscript(): ParsedTranscript {
  return {
    messages: [
      {
        index: 0,
        role: "user",
        text: "Remember this.",
      },
      {
        index: 1,
        role: "assistant",
        text: "Understood.",
      },
    ],
    metadata: {},
    warnings: [],
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
