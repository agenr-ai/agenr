import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ingestFile } from "../../../src/core/ingestion/pipeline.js";
import type { DatabasePort, EmbeddingPort, LlmPort, TranscriptPort } from "../../../src/core/ports.js";
import type { Entry, ParsedTranscript } from "../../../src/core/types.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("ingestFile", () => {
  it("ingests a file, stores extracted entries, and records the ingest log", async () => {
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

    expect(result).toMatchObject({
      file: filePath,
      skipped: false,
      messageCount: 2,
      entriesExtracted: 1,
      storeResult: {
        stored: 1,
        skipped: 0,
        rejected: 0,
      },
      warnings: ["Parser warning"],
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(db.insertions).toHaveLength(1);
    expect(db.ingestLogInsertions).toEqual([
      {
        filePath,
        fileHash,
        entryCount: 1,
      },
    ]);
    expect(embedding.calls).toHaveLength(1);
    expect(transcript.parseCalls).toEqual([filePath]);
    expect(llm.completeJsonCalls).toBe(1);
  });

  it("skips a file that was already ingested with the same hash", async () => {
    const { filePath, fileHash } = await writeTranscriptFile("session-two");
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
      messageCount: 0,
      entriesExtracted: 0,
      storeResult: null,
      warnings: [],
    });
    expect(transcript.parseCalls).toEqual([]);
    expect(llm.completeJsonCalls).toBe(0);
    expect(embedding.calls).toEqual([]);
    expect(db.ingestLogInsertions).toEqual([]);
  });

  it("re-ingests a file when the content hash changed", async () => {
    const { filePath } = await writeTranscriptFile("session-three");
    const db = new MockDatabase({
      ingestLogEntry: {
        fileHash: "outdated-hash",
        ingestedAt: "2026-03-25T00:00:00.000Z",
      },
    });
    const transcript = new MockTranscriptPort(buildTranscript());
    const llm = new MockLlmPort([{ entries: [] }]);
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

    expect(result.skipped).toBe(false);
    expect(transcript.parseCalls).toEqual([filePath]);
    expect(db.ingestLogInsertions).toHaveLength(1);
  });

  it("does not store entries or update the ingest log during a dry run", async () => {
    const { filePath } = await writeTranscriptFile("session-four");
    const db = new MockDatabase();
    const transcript = new MockTranscriptPort(buildTranscript());
    const llm = new MockLlmPort([
      {
        entries: [
          {
            type: "fact",
            subject: "repo",
            content: "Dry runs should not write to the database.",
            importance: "medium",
            expiry: "temporary",
          },
        ],
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
        dryRun: true,
        wholeFile: "never",
      },
    );

    expect(result.storeResult).toEqual({
      stored: 0,
      skipped: 0,
      rejected: 0,
    });
    expect(db.insertions).toEqual([]);
    expect(db.ingestLogInsertions).toEqual([]);
    expect(embedding.calls).toEqual([]);
  });

  it("returns error information when transcript parsing fails", async () => {
    const { filePath } = await writeTranscriptFile("session-five");
    const db = new MockDatabase();
    const transcript = new MockTranscriptPort(new Error("Malformed transcript"));
    const llm = new MockLlmPort([{ entries: [] }]);
    const embedding = new MockEmbeddingPort();

    const result = await ingestFile(filePath, { transcript, llm, embedding, db });

    expect(result).toMatchObject({
      file: filePath,
      skipped: false,
      messageCount: 0,
      entriesExtracted: 0,
      storeResult: null,
      error: "Malformed transcript",
      warnings: ["Malformed transcript"],
    });
    expect(db.ingestLogInsertions).toEqual([]);
  });

  it("updates the ingest log even when extraction produces zero entries", async () => {
    const { filePath, fileHash } = await writeTranscriptFile("session-six");
    const db = new MockDatabase();
    const transcript = new MockTranscriptPort(buildTranscript());
    const llm = new MockLlmPort([{ entries: [] }]);
    const embedding = new MockEmbeddingPort();

    const result = await ingestFile(filePath, { transcript, llm, embedding, db }, { wholeFile: "never" });

    expect(result.storeResult).toEqual({
      stored: 0,
      skipped: 0,
      rejected: 0,
    });
    expect(db.insertions).toEqual([]);
    expect(db.ingestLogInsertions).toEqual([
      {
        filePath,
        fileHash,
        entryCount: 0,
      },
    ]);
  });
});

class MockDatabase implements DatabasePort {
  public readonly insertions: Array<{ entry: Entry; embedding: number[]; contentHash: string }> = [];
  public readonly ingestLogInsertions: Array<{ filePath: string; fileHash: string; entryCount: number }> = [];
  private readonly ingestLogEntry: { fileHash: string; ingestedAt: string } | null;

  public constructor(options: { ingestLogEntry?: { fileHash: string; ingestedAt: string } | null } = {}) {
    this.ingestLogEntry = options.ingestLogEntry ?? null;
  }

  public async insertEntry(entry: Entry, embedding: number[], contentHash: string): Promise<string> {
    this.insertions.push({ entry, embedding, contentHash });
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

  public async findExistingHashes(): Promise<Set<string>> {
    return new Set();
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
