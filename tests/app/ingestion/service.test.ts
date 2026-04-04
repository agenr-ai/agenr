import { describe, expect, it } from "vitest";

import { ingestPath } from "../../../src/app/ingestion/index.js";
import type { IngestFilePort, IngestionLlmPort, UsageStats } from "../../../src/app/ingestion/ports.js";
import type { DatabasePort, EmbeddingPort, LlmPort, TranscriptPort } from "../../../src/core/ports.js";
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

  it("extracts claim keys before store for eligible entries only", async () => {
    const filePath = "/tmp/session-claims.jsonl";
    const db = new MockDatabase();
    const claimCalls: string[] = [];

    await ingestPath(
      "/tmp",
      {
        files: new MockFilePort([filePath], { [filePath]: "hash-claims" }),
        transcript: new MockTranscriptPort(buildTranscript()),
        db,
        embedding: new MockEmbeddingPort(),
        createExtractionLlm: () =>
          new MockIngestionLlm({
            entries: [
              createInput({
                type: "fact",
                subject: "Project X status",
                content: "Project X is active.",
                source_file: filePath,
              }),
              createInput({
                type: "milestone",
                subject: "Launch day",
                content: "Project X launched today.",
                source_file: filePath,
              }),
            ],
          }),
        createClaimExtractionLlm: () =>
          new MockClaimExtractionLlm((_, userMessage) => {
            claimCalls.push(userMessage);
            return {
              entity: "project_x",
              attribute: "status",
              confidence: 0.95,
            };
          }),
      },
      {
        skipDedup: true,
        wholeFile: "never",
      },
    );

    expect(claimCalls).toHaveLength(1);
    expect(db.insertions).toHaveLength(2);
    expect(db.insertions[0]?.entry.claim_key).toBe("project_x/status");
    expect(db.insertions[1]?.entry.claim_key).toBeUndefined();
  });

  it("extracts claim keys for lesson entries under the default config", async () => {
    const filePath = "/tmp/session-lesson-claims.jsonl";
    const db = new MockDatabase();

    await ingestPath(
      "/tmp",
      {
        files: new MockFilePort([filePath], { [filePath]: "hash-lesson-claims" }),
        transcript: new MockTranscriptPort(buildTranscript()),
        db,
        embedding: new MockEmbeddingPort(),
        createExtractionLlm: () =>
          new MockIngestionLlm({
            entries: [
              createInput({
                type: "lesson",
                subject: "Pooling lesson",
                content: "Lesson: Postgres needs connection pooling under bursty load.",
                source_file: filePath,
              }),
            ],
          }),
        createClaimExtractionLlm: () =>
          new MockClaimExtractionLlm(() => ({
            entity: "postgres",
            attribute: "connection_pooling_lesson",
            confidence: 0.94,
          })),
      },
      {
        skipDedup: true,
        wholeFile: "never",
      },
    );

    expect(db.insertions).toHaveLength(1);
    expect(db.insertions[0]?.entry.claim_key).toBe("postgres/connection_pooling_lesson");
  });

  it("stores entries without claim keys when no claim-extraction LLM is provided", async () => {
    const filePath = "/tmp/session-no-claim-llm.jsonl";
    const db = new MockDatabase();

    await ingestPath(
      "/tmp",
      {
        files: new MockFilePort([filePath], { [filePath]: "hash-no-claim" }),
        transcript: new MockTranscriptPort(buildTranscript()),
        db,
        embedding: new MockEmbeddingPort(),
        createExtractionLlm: () =>
          new MockIngestionLlm({
            entries: [
              createInput({
                subject: "No claim extractor",
                content: "This entry should still store.",
                source_file: filePath,
              }),
            ],
          }),
      },
      {
        skipDedup: true,
        wholeFile: "never",
      },
    );

    expect(db.insertions).toHaveLength(1);
    expect(db.insertions[0]?.entry.claim_key).toBeUndefined();
  });

  it("reuses entity hints across ingest runs", async () => {
    const firstFile = "/tmp/session-project-x.jsonl";
    const secondFile = "/tmp/session-project-alias.jsonl";
    const db = new MockDatabase();
    const claimFactory = () =>
      new MockClaimExtractionLlm((systemPrompt, userMessage) => {
        if (userMessage.includes("Project X")) {
          return {
            entity: "project_x",
            attribute: "status",
            confidence: 0.95,
          };
        }

        return {
          entity: systemPrompt.includes("project_x") ? "the_project" : "new_project",
          attribute: "status",
          confidence: 0.95,
        };
      });

    await ingestPath(
      "/tmp",
      {
        files: new MockFilePort([firstFile], { [firstFile]: "hash-project-x" }),
        transcript: new MockTranscriptPort(buildTranscript()),
        db,
        embedding: new MockEmbeddingPort(),
        createExtractionLlm: () =>
          new MockIngestionLlm({
            entries: [
              createInput({
                subject: "Project X",
                content: "Project X is active.",
                source_file: firstFile,
              }),
            ],
          }),
        createClaimExtractionLlm: claimFactory,
      },
      {
        skipDedup: true,
        wholeFile: "never",
      },
    );

    await ingestPath(
      "/tmp",
      {
        files: new MockFilePort([secondFile], { [secondFile]: "hash-project-alias" }),
        transcript: new MockTranscriptPort(buildTranscript()),
        db,
        embedding: new MockEmbeddingPort(),
        createExtractionLlm: () =>
          new MockIngestionLlm({
            entries: [
              createInput({
                subject: "The project",
                content: "The project is active.",
                source_file: secondFile,
              }),
            ],
          }),
        createClaimExtractionLlm: claimFactory,
      },
      {
        skipDedup: true,
        wholeFile: "never",
      },
    );

    expect(db.insertions[0]?.entry.claim_key).toBe("project_x/status");
    expect(db.insertions[1]?.entry.claim_key).toBe("project_x/status");
  });

  it("continues ingest when claim extraction fails", async () => {
    const filePath = "/tmp/session-claim-failure.jsonl";
    const db = new MockDatabase();

    await ingestPath(
      "/tmp",
      {
        files: new MockFilePort([filePath], { [filePath]: "hash-claim-failure" }),
        transcript: new MockTranscriptPort(buildTranscript()),
        db,
        embedding: new MockEmbeddingPort(),
        createExtractionLlm: () =>
          new MockIngestionLlm({
            entries: [
              createInput({
                subject: "Failure case",
                content: "Claim extraction should fail open.",
                source_file: filePath,
              }),
            ],
          }),
        createClaimExtractionLlm: () => new MockClaimExtractionLlm(() => new Error("claim extraction failed")),
      },
      {
        skipDedup: true,
        wholeFile: "never",
      },
    );

    expect(db.insertions).toHaveLength(1);
    expect(db.insertions[0]?.entry.claim_key).toBeUndefined();
  });

  it("finishes claim extraction before the bulk-write window opens", async () => {
    const filePath = "/tmp/session-bulk-window.jsonl";
    const timeline: string[] = [];
    const db = new MockDatabase(timeline);

    await ingestPath(
      "/tmp",
      {
        files: new MockFilePort([filePath], { [filePath]: "hash-bulk-window" }),
        transcript: new MockTranscriptPort(buildTranscript()),
        db,
        embedding: new MockEmbeddingPort(),
        createExtractionLlm: () =>
          new MockIngestionLlm({
            entries: [
              createInput({
                subject: "Bulk window",
                content: "Claim extraction should happen first.",
                source_file: filePath,
              }),
            ],
          }),
        createClaimExtractionLlm: () =>
          new MockClaimExtractionLlm(() => {
            timeline.push("claim");
            return {
              entity: "project_x",
              attribute: "status",
              confidence: 0.95,
            };
          }),
      },
      {
        skipDedup: true,
        wholeFile: "never",
      },
    );

    expect(timeline).toEqual(["claim", "prepare", "insert", "finalize"]);
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
  public readonly callOrder: string[] = [];
  public transactionCount = 0;
  public prepareCalls = 0;
  public finalizeCalls = 0;

  public constructor(private readonly eventLog?: string[]) {}

  public async insertEntry(entry: Entry, embedding: number[], contentHash: string): Promise<string> {
    this.callOrder.push("insert");
    this.eventLog?.push("insert");
    this.insertions.push({ entry, embedding, contentHash });
    return entry.id;
  }

  public async prepareForBulkWrites(): Promise<void> {
    this.prepareCalls += 1;
    this.callOrder.push("prepare");
    this.eventLog?.push("prepare");
  }

  public async finalizeBulkWrites(): Promise<void> {
    this.finalizeCalls += 1;
    this.callOrder.push("finalize");
    this.eventLog?.push("finalize");
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

  public async supersedeEntry(): Promise<boolean> {
    return false;
  }

  public async findActiveEntriesByClaimKey(): Promise<Entry[]> {
    return [];
  }

  public async getDistinctClaimKeyPrefixes(): Promise<string[]> {
    return this.insertions
      .map(({ entry }) => entry.claim_key?.split("/", 1)[0])
      .filter((prefix): prefix is string => typeof prefix === "string" && prefix.length > 0);
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

class MockClaimExtractionLlm implements LlmPort {
  public constructor(private readonly responder: (systemPrompt: string, userMessage: string) => unknown) {}

  public async complete(): Promise<string> {
    throw new Error("complete should not be used in this test.");
  }

  public async completeJson<T>(systemPrompt: string, userMessage: string): Promise<T> {
    const response = this.responder(systemPrompt, userMessage);
    if (response instanceof Error) {
      throw response;
    }

    return response as T;
  }
}

function buildTranscript(): ParsedTranscript {
  const messages = [
    {
      index: 0,
      role: "user" as const,
      text: "Remember this.",
    },
    {
      index: 1,
      role: "assistant" as const,
      text: "Understood.",
    },
  ];

  return {
    messages,
    metadata: {
      messageCount: messages.length,
      transcriptHash: "service-transcript-hash",
    },
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
