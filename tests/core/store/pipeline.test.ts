import { describe, expect, it } from "vitest";

import { composeEmbeddingText } from "../../../src/adapters/embeddings.js";
import type { DatabasePort, EmbeddingPort } from "../../../src/core/ports.js";
import { computeContentHash, computeNormContentHash } from "../../../src/core/store/hashing.js";
import { storeEntries } from "../../../src/core/store/pipeline.js";
import type { Entry, StoreEntryInput } from "../../../src/core/types.js";

describe("storeEntries", () => {
  it("stores a single entry successfully", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();

    const result = await storeEntries([createInput()], db, embedding);

    expect(result).toEqual({ stored: 1, skipped: 0, rejected: 0 });
    expect(db.insertions).toHaveLength(1);
  });

  it("skips entries whose content hash already exists", async () => {
    const input = createInput();
    const db = new MockDatabase({
      existingHashes: new Set([computeContentHash(input.content, input.source_file)]),
    });
    const embedding = new MockEmbeddingPort();

    const result = await storeEntries([input], db, embedding);

    expect(result).toEqual({ stored: 0, skipped: 1, rejected: 0 });
    expect(db.insertions).toEqual([]);
    expect(embedding.calls).toEqual([]);
  });

  it("skips entries whose normalized content hash already exists", async () => {
    const input = createInput({
      content: "Hello,   WORLD!",
      source_file: "/tmp/source-a.md",
    });
    const db = new MockDatabase({
      existingNormHashes: new Set([computeNormContentHash(input.content)]),
    });
    const embedding = new MockEmbeddingPort();

    const result = await storeEntries([input], db, embedding);

    expect(result).toEqual({ stored: 0, skipped: 1, rejected: 0 });
    expect(db.insertions).toEqual([]);
    expect(embedding.calls).toEqual([]);
  });

  it("stores three entries and skips two duplicates in a batch of five", async () => {
    const inputs = [
      createInput({ subject: "one", content: "content-one" }),
      createInput({ subject: "two", content: "content-two" }),
      createInput({ subject: "three", content: "content-three" }),
      createInput({ subject: "four", content: "content-four" }),
      createInput({ subject: "five", content: "content-five" }),
    ];
    const db = new MockDatabase({
      existingHashes: new Set([computeContentHash(inputs[1].content, inputs[1].source_file), computeContentHash(inputs[4].content, inputs[4].source_file)]),
    });
    const embedding = new MockEmbeddingPort();

    const result = await storeEntries(inputs, db, embedding);

    expect(result).toEqual({ stored: 3, skipped: 2, rejected: 0 });
    expect(db.insertions).toHaveLength(3);
    expect(db.transactionCount).toBe(1);
  });

  it("stores only the first entry when a batch contains duplicate normalized content hashes", async () => {
    const inputs = [
      createInput({
        subject: "one",
        content: "Normalize me",
        source_file: "/tmp/source-a.md",
      }),
      createInput({
        subject: "two",
        content: " normalize   me ",
        source_file: "/tmp/source-b.md",
      }),
    ];
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();

    const result = await storeEntries(inputs, db, embedding);

    expect(result).toEqual({ stored: 1, skipped: 1, rejected: 0 });
    expect(db.insertions).toHaveLength(1);
    expect(db.insertions[0]?.entry.source_file).toBe("/tmp/source-a.md");
  });

  it("returns zero counts for empty input", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();

    await expect(storeEntries([], db, embedding)).resolves.toEqual({
      stored: 0,
      skipped: 0,
      rejected: 0,
    });
  });

  it("rejects invalid entries while still storing valid ones", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();

    const result = await storeEntries([createInput({ subject: "valid" }), createInput({ subject: "   " })], db, embedding);

    expect(result).toEqual({ stored: 1, skipped: 0, rejected: 1 });
    expect(db.insertions).toHaveLength(1);
  });

  it("does not insert entries during a dry run", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();

    const result = await storeEntries([createInput()], db, embedding, { dryRun: true });

    expect(result).toEqual({ stored: 0, skipped: 0, rejected: 0 });
    expect(db.insertions).toEqual([]);
    expect(embedding.calls).toEqual([]);
  });

  it("stores entries with empty embeddings when skipEmbeddings is true", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();

    const result = await storeEntries([createInput()], db, embedding, { skipEmbeddings: true });

    expect(result).toEqual({ stored: 1, skipped: 0, rejected: 0 });
    expect(embedding.calls).toEqual([]);
    expect(db.insertions[0]?.embedding).toEqual([]);
  });

  it("calls the embedding port with composed entry texts", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();
    const inputs = [
      createInput({ type: "decision", subject: "subject-a", content: "content-a" }),
      createInput({ type: "lesson", subject: "subject-b", content: "content-b" }),
    ];

    await storeEntries(inputs, db, embedding);

    expect(embedding.calls).toEqual([inputs.map((input) => composeEmbeddingText(input))]);
  });

  it("sets content hash and normalized content hash on persisted entries", async () => {
    const input = createInput({
      content: "Hello,   WORLD!",
      source_file: "/tmp/source.md",
    });
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();

    await storeEntries([input], db, embedding);

    expect(db.insertions[0]?.entry.content_hash).toBe(computeContentHash(input.content, input.source_file));
    expect(db.insertions[0]?.entry.norm_content_hash).toBe(computeNormContentHash(input.content));
  });
});

class MockDatabase implements DatabasePort {
  public readonly insertions: Array<{ entry: Entry; embedding: number[]; contentHash: string }> = [];
  public readonly existingHashes: Set<string>;
  public readonly existingNormHashes: Set<string>;
  public transactionCount = 0;

  public constructor(options: { existingHashes?: Set<string>; existingNormHashes?: Set<string> } = {}) {
    this.existingHashes = options.existingHashes ?? new Set();
    this.existingNormHashes = options.existingNormHashes ?? new Set();
  }

  public async insertEntry(entry: Entry, embedding: number[], contentHash: string): Promise<string> {
    this.insertions.push({
      entry,
      embedding,
      contentHash,
    });
    return entry.id;
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
    return null;
  }

  public async insertIngestLogEntry(): Promise<void> {}

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
