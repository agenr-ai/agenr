import { describe, expect, it, vi } from "vitest";

import { ingestPath } from "../../../src/app/ingestion/index.js";
import type { IngestFilePort, IngestionLlmPort, UsageStats } from "../../../src/app/ingestion/ports.js";
import type { DatabasePort, EmbeddingPort, LlmPort, TranscriptPort } from "../../../src/core/ports.js";
import { composeEmbeddingText } from "../../../src/core/store/embedding-text.js";
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
        transcript: new MockTranscriptPort(
          buildTranscript({
            timestamps: ["2026-04-01T09:00:00.000Z", "2026-04-01T09:01:00.000Z"],
          }),
        ),
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
    expect(db.insertions[0]?.entry).toMatchObject({
      claim_key: "project_x/status",
      claim_key_status: "trusted",
      claim_key_source: "model",
      claim_key_confidence: 0.95,
      claim_key_rationale: "claim key extracted from model output",
      claim_support_source_kind: "transcript_ingest",
      claim_support_locator: `${filePath}#observed_at:2026-04-01T09:01:00.000Z`,
      claim_support_observed_at: "2026-04-01T09:01:00.000Z",
      claim_support_mode: "inferred",
    });
    expect(db.insertions[1]?.entry.claim_key).toBeUndefined();
  });

  it("emits post-extraction stage progress during ingest", async () => {
    const files = ["/tmp/session-stage-a.jsonl", "/tmp/session-stage-b.jsonl"];
    const phases: string[] = [];

    await ingestPath(
      "/tmp",
      {
        files: new MockFilePort(files, {
          [files[0]]: "hash-stage-a",
          [files[1]]: "hash-stage-b",
        }),
        transcript: new MockTranscriptPort(buildTranscript()),
        db: new MockDatabase(),
        embedding: new MockEmbeddingPort(),
        createExtractionLlm: () =>
          new MockIngestionLlm({
            entries: [
              createInput({
                type: "fact",
                subject: "Project X status",
                content: "Project X is active.",
              }),
            ],
          }),
        createClaimExtractionLlm: () =>
          new MockClaimExtractionLlm(() => ({
            entity: "project_x",
            attribute: "status",
            confidence: 0.95,
          })),
      },
      {
        wholeFile: "never",
        onStageProgress: (event) => {
          phases.push(`${event.phase}:${event.totalEntries}`);
        },
      },
    );

    expect(phases).toEqual(["dedup_start:2", "claim_extraction_start:2", "store_start:2"]);
  });

  it("propagates configured ingest concurrency into dedup arbitration", async () => {
    const filePath = "/tmp/session-dedup-concurrency.jsonl";
    const { entries, vectors } = createPairedClusterScenario(3);
    const responses = [deferred<string>(), deferred<string>(), deferred<string>()];
    let dedupLlm: MockDedupLlm | null = null;

    const ingestPromise = ingestPath(
      "/tmp",
      {
        files: new MockFilePort([filePath], { [filePath]: "hash-dedup-concurrency" }),
        transcript: new MockTranscriptPort(buildTranscript()),
        db: new MockDatabase(),
        embedding: new MockEmbeddingPort(entries, vectors),
        createExtractionLlm: () => new MockIngestionLlm({ entries }),
        createDedupLlm: () => {
          dedupLlm = new MockDedupLlm(responses.map((response) => response.promise));
          return dedupLlm;
        },
      },
      {
        concurrency: 2,
        wholeFile: "never",
      },
    );

    await vi.waitFor(() => {
      expect(dedupLlm?.completeCalls).toBe(2);
    });
    expect(dedupLlm?.maxActiveRequests).toBe(2);

    responses[0].resolve('{"keep":[0],"drop":[1]}');
    await vi.waitFor(() => {
      expect(dedupLlm?.completeCalls).toBe(3);
    });
    expect(dedupLlm?.maxActiveRequests).toBe(2);

    responses[1].resolve('{"keep":[0],"drop":[1]}');
    responses[2].resolve('{"keep":[0],"drop":[1]}');
    await ingestPromise;
  });

  it("defaults dedup arbitration concurrency to 10 when ingest concurrency is unset", async () => {
    const filePath = "/tmp/session-dedup-default-concurrency.jsonl";
    const { entries, vectors } = createPairedClusterScenario(11);
    const responses = Array.from({ length: 11 }, () => deferred<string>());
    let dedupLlm: MockDedupLlm | null = null;

    const ingestPromise = ingestPath(
      "/tmp",
      {
        files: new MockFilePort([filePath], { [filePath]: "hash-dedup-default" }),
        transcript: new MockTranscriptPort(buildTranscript()),
        db: new MockDatabase(),
        embedding: new MockEmbeddingPort(entries, vectors),
        createExtractionLlm: () => new MockIngestionLlm({ entries }),
        createDedupLlm: () => {
          dedupLlm = new MockDedupLlm(responses.map((response) => response.promise));
          return dedupLlm;
        },
      },
      {
        wholeFile: "never",
      },
    );

    await vi.waitFor(() => {
      expect(dedupLlm?.completeCalls).toBe(10);
    });
    expect(dedupLlm?.maxActiveRequests).toBe(10);

    responses[0]?.resolve('{"keep":[0],"drop":[1]}');
    await vi.waitFor(() => {
      expect(dedupLlm?.completeCalls).toBe(11);
    });
    expect(dedupLlm?.maxActiveRequests).toBe(10);

    for (const response of responses.slice(1)) {
      response.resolve('{"keep":[0],"drop":[1]}');
    }
    await ingestPromise;
  });

  it("honors claimExtractionConfig concurrency across path ingest", async () => {
    const filePath = "/tmp/session-claim-concurrency-path.jsonl";
    const db = new MockDatabase();
    const responses = [
      deferred<{ entity: string; attribute: string; confidence: number }>(),
      deferred<{ entity: string; attribute: string; confidence: number }>(),
    ];
    let claimLlm: MockClaimExtractionLlm | null = null;

    const ingestPromise = ingestPath(
      "/tmp",
      {
        files: new MockFilePort([filePath], { [filePath]: "hash-claim-concurrency-path" }),
        transcript: new MockTranscriptPort(buildTranscript()),
        db,
        embedding: new MockEmbeddingPort(),
        createExtractionLlm: () =>
          new MockIngestionLlm({
            entries: [
              createInput({
                type: "fact",
                subject: "Jim timezone",
                content: "Jim's timezone is America/Chicago.",
                source_file: filePath,
              }),
              createInput({
                type: "fact",
                subject: "Jim city",
                content: "Jim lives in Denver, Colorado.",
                source_file: filePath,
              }),
            ],
          }),
        createClaimExtractionLlm: () => {
          claimLlm = new MockClaimExtractionLlm(responses.map((response) => response.promise));
          return claimLlm;
        },
      },
      {
        concurrency: 10,
        skipDedup: true,
        wholeFile: "never",
        claimExtractionConfig: {
          enabled: true,
          confidenceThreshold: 0.8,
          eligibleTypes: ["fact", "preference", "decision", "lesson"],
          concurrency: 1,
        },
      },
    );

    await vi.waitFor(() => {
      expect(claimLlm?.completeJsonCalls).toBe(1);
    });
    expect(claimLlm?.maxActiveRequests).toBe(1);

    responses[0].resolve({ entity: "jim", attribute: "timezone", confidence: 0.95 });
    await vi.waitFor(() => {
      expect(claimLlm?.completeJsonCalls).toBe(2);
    });
    expect(claimLlm?.maxActiveRequests).toBe(1);

    responses[1].resolve({ entity: "jim", attribute: "home_city", confidence: 0.95 });
    await ingestPromise;
  });

  it("threads transcript-derived project metadata into claim extraction hints and persistence", async () => {
    const filePath = "/tmp/session-project-metadata.jsonl.reset.2026-04-01T09-00-00.000Z";
    const db = new MockDatabase();

    await ingestPath(
      "/tmp",
      {
        files: new MockFilePort([filePath], { [filePath]: "hash-project-metadata" }),
        transcript: new MockTranscriptPort(
          buildTranscript({
            timestamps: ["2026-04-01T09:00:00.000Z", "2026-04-01T09:01:00.000Z"],
            metadata: {
              sourceIdentity: "openclaw-session:session-project-metadata",
              workingDirectory: "/Users/jmartin/Code/project-x",
            },
          }),
        ),
        db,
        embedding: new MockEmbeddingPort(),
        createExtractionLlm: () =>
          new MockIngestionLlm({
            entries: [
              createInput({
                type: "fact",
                subject: "Project X status",
                content: "The project is active and healthy.",
                tags: ["project_x", "status"],
              }),
            ],
          }),
        createClaimExtractionLlm: () =>
          new MockClaimExtractionLlm((systemPrompt) => ({
            entity: systemPrompt.includes("project=project_x") ? "the_project" : "new_project",
            attribute: "status",
            confidence: 0.95,
          })),
      },
      {
        skipDedup: true,
        wholeFile: "never",
      },
    );

    expect(db.insertions[0]?.entry).toMatchObject({
      source_file: "openclaw-session:session-project-metadata",
      project: "project_x",
      claim_key: "project_x/status",
    });
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

  it("preserves explicit claim-key metadata when dedup keeps a sibling entry", async () => {
    const filePath = "/tmp/session-preserved-claim-key.jsonl";
    const db = new MockDatabase();

    await ingestPath(
      "/tmp",
      {
        files: new MockFilePort([filePath], { [filePath]: "hash-preserved-claim-key" }),
        transcript: new MockTranscriptPort(
          buildTranscript({
            timestamps: ["2026-04-01T10:00:00.000Z", "2026-04-01T10:01:00.000Z"],
          }),
        ),
        db,
        embedding: new MockEmbeddingPort(),
        createExtractionLlm: () =>
          new MockIngestionLlm({
            entries: [
              createInput({
                subject: "Jim home city",
                content: "Jim lives in Denver, Colorado.",
                claim_key: " Jim / Home City ",
                claim_key_raw: "Jim / Home City",
                source_file: filePath,
              }),
              createInput({
                subject: "Jim home city",
                content: "Jim lives in Denver, Colorado.",
                source_file: filePath,
              }),
            ],
          }),
        createDedupLlm: () => new MockDedupLlm('{"keep":[1],"drop":[0]}'),
      },
      {
        wholeFile: "never",
      },
    );

    expect(db.insertions).toHaveLength(1);
    expect(db.insertions[0]?.entry).toMatchObject({
      claim_key: "jim/home_city",
      claim_key_raw: "Jim / Home City",
      claim_key_status: "trusted",
      claim_key_source: "manual",
      claim_key_confidence: 1,
      claim_key_rationale: "manual claim key supplied by caller",
      claim_support_source_kind: "tool_call",
      claim_support_locator: `${filePath}#entry:1`,
      claim_support_observed_at: "2026-04-01T10:01:00.000Z",
      claim_support_mode: "explicit",
    });
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

  it("returns a compact claim-key health summary with reviewable near-miss candidates", async () => {
    const filePath = "/tmp/session-health-summary.jsonl";
    const db = new MockDatabase();
    let claimCall = 0;

    const result = await ingestPath(
      "/tmp",
      {
        files: new MockFilePort([filePath], { [filePath]: "hash-health-summary" }),
        transcript: new MockTranscriptPort(
          buildTranscript({
            timestamps: ["2026-04-01T10:00:00.000Z", "2026-04-01T10:01:00.000Z"],
          }),
        ),
        db,
        embedding: new MockEmbeddingPort(),
        createExtractionLlm: () =>
          new MockIngestionLlm({
            entries: [
              createInput({
                type: "decision",
                subject: "Repo workflow docs",
                content: "The repo workflow is defined by AGENTS.md, even when older notes disagree.",
                source_file: filePath,
                tags: ["workflow"],
                source_context: "AGENTS.md is the repo workflow source of truth",
              }),
              createInput({
                type: "decision",
                subject: "Repo workflow note",
                content: "AGENTS.md remains the workflow source of truth for the repo.",
                source_file: filePath,
                tags: ["workflow"],
                source_context: "Workflow docs note",
              }),
            ],
          }),
        createClaimExtractionLlm: () =>
          new MockClaimExtractionLlm(() => {
            claimCall += 1;
            return claimCall === 1
              ? {
                  entity: "Repo workflow",
                  attribute: "source of truth",
                  confidence: 0.95,
                }
              : {
                  entity: "Repo workflow",
                  attribute: "source of truth",
                  confidence: 0.68,
                };
          }),
      },
      {
        skipDedup: true,
        wholeFile: "never",
      },
    );

    expect(result.claimKeyHealth).toMatchObject({
      eligibleRows: 2,
      keyedEligibleRows: 1,
      missingEligibleRows: 1,
      metadataCoverage: {
        rowsWithUserId: 0,
        rowsWithProject: 0,
        snapshotStyleSourceRows: 0,
      },
      keyedRows: 1,
      keyedWithSupportCount: 1,
      keyedMissingSupportCount: 0,
      supportFillRate: 1,
      supportBySource: [
        {
          source: "model",
          keyed: 1,
          withSupport: 1,
          missingSupport: 0,
          fillRate: 1,
        },
      ],
      diagnostics: {
        lowConfidenceCandidate: 1,
        reviewable: 1,
      },
    });
    expect(result.claimKeyHealth?.reviewCandidates).toEqual([
      expect.objectContaining({
        subject: "Repo workflow note",
        suggestedClaimKey: "repo_workflow/source_of_truth",
        reviewable: true,
      }),
    ]);
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
  private readonly vectorsByText?: Map<string, number[]>;

  public constructor(entries: StoreEntryInput[] = [], vectors: number[][] = []) {
    this.vectorsByText =
      entries.length > 0
        ? new Map(entries.map((entry, index) => [composeEmbeddingText(entry), vectors[index] ?? []]))
        : undefined;
  }

  public async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    if (this.vectorsByText) {
      return texts.map((text) => {
        const vector = this.vectorsByText?.get(text);
        if (!vector) {
          throw new Error(`No mock embedding configured for ${text}.`);
        }

        return vector;
      });
    }

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

type MockDedupResponse = string | Promise<string>;

class MockDedupLlm implements IngestionLlmPort {
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
  public completeCalls = 0;
  public maxActiveRequests = 0;
  private activeRequests = 0;

  public constructor(private readonly responses: MockDedupResponse[] | MockDedupResponse) {}

  public async complete(): Promise<string> {
    this.metadata.usage.calls += 1;
    const response = Array.isArray(this.responses)
      ? this.responses[this.completeCalls] ?? this.responses.at(-1) ?? '{"keep":[0],"drop":[1]}'
      : this.responses;
    this.completeCalls += 1;
    this.activeRequests += 1;
    this.maxActiveRequests = Math.max(this.maxActiveRequests, this.activeRequests);

    try {
      return await response;
    } finally {
      this.activeRequests -= 1;
    }
  }

  public async completeJson<T>(): Promise<T> {
    throw new Error("completeJson should not be used in this test.");
  }
}

type MockClaimExtractionResponse =
  | unknown
  | Promise<{ entity: string; attribute: string; confidence: number }>;

class MockClaimExtractionLlm implements LlmPort {
  public completeJsonCalls = 0;
  public maxActiveRequests = 0;
  private activeRequests = 0;

  public constructor(
    private readonly responder:
      | ((systemPrompt: string, userMessage: string) => MockClaimExtractionResponse)
      | MockClaimExtractionResponse[],
  ) {}

  public async complete(): Promise<string> {
    throw new Error("complete should not be used in this test.");
  }

  public async completeJson<T>(systemPrompt: string, userMessage: string): Promise<T> {
    const response =
      typeof this.responder === "function"
        ? this.responder(systemPrompt, userMessage)
        : this.responder[this.completeJsonCalls] ?? this.responder.at(-1);
    this.completeJsonCalls += 1;
    this.activeRequests += 1;
    this.maxActiveRequests = Math.max(this.maxActiveRequests, this.activeRequests);

    try {
      if (response instanceof Error) {
        throw response;
      }

      return (await response) as T;
    } finally {
      this.activeRequests -= 1;
    }
  }
}

function createPairedClusterScenario(clusterCount: number): { entries: StoreEntryInput[]; vectors: number[][] } {
  const entries: StoreEntryInput[] = [];
  const vectors: number[][] = [];

  for (let clusterIndex = 0; clusterIndex < clusterCount; clusterIndex += 1) {
    const vector = Array.from({ length: clusterCount }, (_, index) => (index === clusterIndex ? 1 : 0));
    entries.push(
      createInput({
        subject: `cluster-${clusterIndex}-primary`,
        content: `cluster-${clusterIndex}-primary content`,
      }),
      createInput({
        subject: `cluster-${clusterIndex}-secondary`,
        content: `cluster-${clusterIndex}-secondary content`,
      }),
    );
    vectors.push([...vector], [...vector]);
  }

  return { entries, vectors };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

function buildTranscript(
  options: {
    timestamps?: [string, string] | string[];
    metadata?: Partial<ParsedTranscript["metadata"]>;
  } = {},
): ParsedTranscript {
  const messages = [
    {
      index: 0,
      role: "user" as const,
      text: "Remember this.",
      timestamp: options.timestamps?.[0],
    },
    {
      index: 1,
      role: "assistant" as const,
      text: "Understood.",
      timestamp: options.timestamps?.[1],
    },
  ];

  return {
    messages,
    metadata: {
      messageCount: messages.length,
      transcriptHash: "service-transcript-hash",
      ...options.metadata,
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
    created_at: overrides.created_at,
    user_id: overrides.user_id,
    project: overrides.project,
  };
}
