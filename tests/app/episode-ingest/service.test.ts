import { describe, expect, it } from "vitest";

import { buildEpisodeSummaryPrompt, EPISODE_SUMMARY_SYSTEM_PROMPT } from "../../../src/core/episode/summary-prompt.js";
import { createEpisodeIngestPlan, executeEpisodeIngestPlan, prepareEpisodeIngest } from "../../../src/app/episode-ingest/index.js";
import type {
  EpisodeIngestFilePort,
  EpisodeIngestLlmPort,
  EpisodeIngestModelInfo,
  EpisodeIngestPorts,
  SessionMeta,
  SessionMetaInspectorPort,
  SessionRegistryPort,
} from "../../../src/app/episode-ingest/ports.js";
import type { EpisodeIngestCandidate } from "../../../src/app/episode-ingest/types.js";
import type { EpisodeInput, EpisodeUpsertResult } from "../../../src/core/episode/types.js";
import type { EpisodeDatabasePort, TranscriptPort } from "../../../src/core/ports.js";
import type { Episode, ParsedTranscript } from "../../../src/core/types.js";

describe("prepareEpisodeIngest", () => {
  it("builds candidates with registry metadata taking precedence over reconstructed metadata", async () => {
    const filePath = "/tmp/123e4567-e89b-12d3-a456-426614174000.jsonl";
    const result = await prepareEpisodeIngest(
      "/tmp",
      createPorts({
        files: new MockEpisodeFiles([filePath]),
        transcript: new MockTranscriptPort({
          [filePath]: buildTranscript({
            sessionId: "123e4567-e89b-12d3-a456-426614174000",
            endedAt: "2026-03-30T09:00:00.000Z",
          }),
        }),
        sessionRegistry: new MockSessionRegistry({
          "123e4567-e89b-12d3-a456-426614174000": {
            sessionId: "123e4567-e89b-12d3-a456-426614174000",
            sourceRef: "/sessions/123e4567-e89b-12d3-a456-426614174000.jsonl",
            agentId: "main",
            surface: "webchat",
            provider: "webchat",
            chatType: "direct",
            metadataSource: "registry",
          },
        }),
        sessionMetaInspector: new MockSessionMetaInspector({
          [filePath]: {
            surface: "telegram",
            metadataSource: "reconstructed",
          },
        }),
      }),
      {
        now: new Date("2026-03-30T10:00:00.000Z"),
      },
    );

    expect(result.invalid).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toEqual(
      expect.objectContaining({
        filePath,
        sessionId: "123e4567-e89b-12d3-a456-426614174000",
        sourceRef: "/sessions/123e4567-e89b-12d3-a456-426614174000.jsonl",
        agentId: "main",
        surface: "webchat",
        metadataSource: "registry",
        messageCount: 4,
        renderedTranscript: expect.stringContaining("User:"),
      }),
    );
    expect(result.candidates[0]?.estimatedInputTokens).toBeGreaterThan(0);
  });

  it("skips short and active sessions before candidate generation", async () => {
    const shortFile = "/tmp/short.jsonl";
    const activeFile = "/tmp/active.jsonl";
    const result = await prepareEpisodeIngest(
      "/tmp",
      createPorts({
        files: new MockEpisodeFiles([shortFile, activeFile]),
        transcript: new MockTranscriptPort({
          [shortFile]: buildTranscript({
            sessionId: "short-session",
            endedAt: "2026-03-30T09:00:00.000Z",
            messages: buildMessages(3),
          }),
          [activeFile]: buildTranscript({
            sessionId: "active-session",
            endedAt: "2026-03-30T09:57:00.000Z",
          }),
        }),
      }),
      {
        now: new Date("2026-03-30T10:00:00.000Z"),
      },
    );

    expect(result.candidates).toEqual([]);
    expect(result.invalid).toEqual([]);
    expect(result.skipped.map((entry) => [entry.filePath, entry.reason])).toEqual([
      [shortFile, "skipped_short"],
      [activeFile, "skipped_active"],
    ]);
  });

  it("skips existing episodes unless regenerate is enabled", async () => {
    const filePath = "/tmp/existing.jsonl";
    const existingEpisode = buildEpisode({
      id: "episode-1",
      sourceId: "existing-session",
      transcriptHash: "existing-hash",
    });
    const basePorts = createPorts({
      files: new MockEpisodeFiles([filePath]),
      transcript: new MockTranscriptPort({
        [filePath]: buildTranscript({
          sessionId: "existing-session",
          transcriptHash: "existing-hash",
          endedAt: "2026-03-30T09:00:00.000Z",
        }),
      }),
      episodes: new MockEpisodeDatabase({
        bySourceId: {
          "existing-session": existingEpisode,
        },
      }),
    });

    const skipped = await prepareEpisodeIngest("/tmp", basePorts, {
      now: new Date("2026-03-30T10:00:00.000Z"),
    });
    const regenerated = await prepareEpisodeIngest("/tmp", basePorts, {
      regenerate: true,
      now: new Date("2026-03-30T10:00:00.000Z"),
    });

    expect(skipped.candidates).toEqual([]);
    expect(skipped.skipped).toEqual([
      expect.objectContaining({
        filePath,
        reason: "skipped_exists",
        existingEpisode,
      }),
    ]);
    expect(regenerated.skipped).toEqual([]);
    expect(regenerated.candidates).toEqual([
      expect.objectContaining({
        filePath,
        existingEpisode,
      }),
    ]);
  });

  it("falls back to transcript-hash dedup when no session id is available", async () => {
    const filePath = "/tmp/no-session-id.jsonl";
    const existingEpisode = buildEpisode({
      id: "episode-hash",
      sourceId: undefined,
      transcriptHash: "hash-only",
    });
    const result = await prepareEpisodeIngest(
      "/tmp",
      createPorts({
        files: new MockEpisodeFiles([filePath]),
        transcript: new MockTranscriptPort({
          [filePath]: buildTranscript({
            sessionId: undefined,
            transcriptHash: "hash-only",
            endedAt: "2026-03-30T09:00:00.000Z",
          }),
        }),
        episodes: new MockEpisodeDatabase({
          byTranscriptHash: {
            "hash-only": existingEpisode,
          },
        }),
      }),
      {
        now: new Date("2026-03-30T10:00:00.000Z"),
      },
    );

    expect(result.skipped).toEqual([
      expect.objectContaining({
        filePath,
        reason: "skipped_exists",
        sessionId: undefined,
        existingEpisode,
      }),
    ]);
  });

  it("records invalid transcripts and caps long rendered transcripts", async () => {
    const invalidFile = "/tmp/invalid.jsonl";
    const longFile = "/tmp/long.jsonl";
    const result = await prepareEpisodeIngest(
      "/tmp",
      createPorts({
        files: new MockEpisodeFiles([invalidFile, longFile]),
        transcript: new MockTranscriptPort({
          [invalidFile]: buildTranscript({
            sessionId: undefined,
            endedAt: undefined,
            messages: [],
          }),
          [longFile]: buildTranscript({
            sessionId: "long-session",
            endedAt: "2026-03-30T09:00:00.000Z",
            messages: buildMessages(4, "segment ".repeat(2500)),
          }),
        }),
      }),
      {
        now: new Date("2026-03-30T10:00:00.000Z"),
      },
    );

    expect(result.invalid).toEqual([
      {
        filePath: invalidFile,
        sessionId: undefined,
        transcriptHash: "service-transcript-hash",
        messageCount: 0,
        metadataSource: "none",
      },
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.renderedTranscript.length).toBeLessThanOrEqual(14_000);
    expect(result.candidates[0]?.renderedTranscript).toContain("[Earlier middle transcript omitted for brevity]");
  });

  it("matches the sequential baseline when preflightConcurrency is 1 and larger worker counts run in parallel", async () => {
    const candidateNewest = "/tmp/candidate-newest.jsonl";
    const skippedShort = "/tmp/skipped-short.jsonl";
    const skippedExisting = "/tmp/skipped-existing.jsonl";
    const invalidFile = "/tmp/invalid.jsonl";
    const candidateOlder = "/tmp/candidate-older.jsonl";
    const files = [candidateNewest, skippedShort, skippedExisting, invalidFile, candidateOlder];
    const transcripts = {
      [candidateNewest]: buildTranscript({
        sessionId: "candidate-newest",
        transcriptHash: "hash-newest",
        endedAt: "2026-03-30T09:40:00.000Z",
      }),
      [skippedShort]: buildTranscript({
        sessionId: "skipped-short",
        transcriptHash: "hash-short",
        endedAt: "2026-03-30T09:20:00.000Z",
        messages: buildMessages(3),
      }),
      [skippedExisting]: buildTranscript({
        sessionId: "skipped-existing",
        transcriptHash: "hash-existing",
        endedAt: "2026-03-30T09:10:00.000Z",
      }),
      [invalidFile]: buildTranscript({
        sessionId: undefined,
        transcriptHash: "hash-invalid",
        endedAt: undefined,
        messages: [],
      }),
      [candidateOlder]: buildTranscript({
        sessionId: "candidate-older",
        transcriptHash: "hash-older",
        endedAt: "2026-03-30T09:05:00.000Z",
      }),
    };

    const sequential = await prepareEpisodeIngest(
      "/tmp",
      createPorts({
        files: new MockEpisodeFiles(files),
        transcript: new MockTranscriptPort(transcripts, {
          delaysMs: {
            [candidateNewest]: 30,
            [skippedShort]: 10,
            [skippedExisting]: 20,
            [invalidFile]: 5,
            [candidateOlder]: 1,
          },
        }),
        episodes: new MockEpisodeDatabase({
          bySourceId: {
            "skipped-existing": buildEpisode({
              id: "episode-existing",
              sourceId: "skipped-existing",
              transcriptHash: "hash-existing",
            }),
          },
        }),
      }),
      {
        now: new Date("2026-03-30T10:00:00.000Z"),
        preflightConcurrency: 1,
      },
    );

    const parallel = await prepareEpisodeIngest(
      "/tmp",
      createPorts({
        files: new MockEpisodeFiles(files),
        transcript: new MockTranscriptPort(transcripts, {
          delaysMs: {
            [candidateNewest]: 30,
            [skippedShort]: 10,
            [skippedExisting]: 20,
            [invalidFile]: 5,
            [candidateOlder]: 1,
          },
        }),
        episodes: new MockEpisodeDatabase({
          bySourceId: {
            "skipped-existing": buildEpisode({
              id: "episode-existing",
              sourceId: "skipped-existing",
              transcriptHash: "hash-existing",
            }),
          },
        }),
      }),
      {
        now: new Date("2026-03-30T10:00:00.000Z"),
        preflightConcurrency: 3,
      },
    );

    expect(parallel).toEqual(sequential);
    expect(parallel.candidates.map((candidate) => candidate.filePath)).toEqual([candidateNewest, candidateOlder]);
    expect(parallel.skipped.map((entry) => entry.filePath)).toEqual([skippedShort, skippedExisting]);
    expect(parallel.invalid.map((entry) => entry.filePath)).toEqual([invalidFile]);
  });

  it("reports preflight progress for every parsed file", async () => {
    const files = ["/tmp/first.jsonl", "/tmp/second.jsonl", "/tmp/third.jsonl"];
    const progressCalls: Array<[completed: number, total: number]> = [];

    await prepareEpisodeIngest(
      "/tmp",
      createPorts({
        files: new MockEpisodeFiles(files),
        transcript: new MockTranscriptPort(
          {
            [files[0]]: buildTranscript({
              sessionId: "first",
              transcriptHash: "first-hash",
              endedAt: "2026-03-30T09:00:00.000Z",
            }),
            [files[1]]: buildTranscript({
              sessionId: "second",
              transcriptHash: "second-hash",
              endedAt: "2026-03-30T09:10:00.000Z",
            }),
            [files[2]]: buildTranscript({
              sessionId: "third",
              transcriptHash: "third-hash",
              endedAt: "2026-03-30T09:20:00.000Z",
            }),
          },
          {
            delaysMs: {
              [files[0]]: 15,
              [files[1]]: 5,
              [files[2]]: 10,
            },
          },
        ),
      }),
      {
        now: new Date("2026-03-30T10:00:00.000Z"),
        preflightConcurrency: 2,
        onPreflightProgress: (completed, total) => {
          progressCalls.push([completed, total]);
        },
      },
    );

    expect(progressCalls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });
});

describe("createEpisodeIngestPlan", () => {
  it("preserves candidate order, filters by recent, and estimates from the full prompt size", () => {
    const newestCandidate = buildCandidate({
      filePath: "/tmp/newest.jsonl",
      endedAt: "2026-03-29T09:00:00.000Z",
      renderedTranscript: "User: Keep Stage 2 dry-run planning pure.\nAssistant: Build the plan before execution.",
    });
    const undatedCandidate = buildCandidate({
      filePath: "/tmp/undated.jsonl",
      endedAt: undefined,
    });
    const olderCandidate = buildCandidate({
      filePath: "/tmp/older.jsonl",
      endedAt: "2026-03-01T09:00:00.000Z",
    });

    const plan = createEpisodeIngestPlan(
      {
        files: [],
        candidates: [newestCandidate, undatedCandidate, olderCandidate],
        skipped: [],
        invalid: [],
        totals: {
          discovered: 3,
          candidates: 3,
          skipped: 0,
          invalid: 0,
          skippedShort: 0,
          skippedActive: 0,
          skippedExists: 0,
        },
      },
      TEST_MODEL,
      {
        recent: "7d",
        now: new Date("2026-03-30T10:00:00.000Z"),
      },
    );

    const expectedInputTokens = estimateTokens(EPISODE_SUMMARY_SYSTEM_PROMPT) + estimateTokens(buildEpisodeSummaryPrompt(newestCandidate.renderedTranscript));

    expect(plan.candidates.map((candidate) => candidate.filePath)).toEqual(["/tmp/newest.jsonl"]);
    expect(plan.candidates[0]?.estimatedInputTokens).toBe(expectedInputTokens);
    expect(plan.estimate).toEqual({
      candidateCount: 1,
      inputTokens: expectedInputTokens,
      outputTokens: 500,
      totalTokens: expectedInputTokens + 500,
      estimatedCostUsd: (expectedInputTokens / 1_000_000) * TEST_MODEL.pricing.input + (500 / 1_000_000) * TEST_MODEL.pricing.output,
    });
    expect(plan.totals).toEqual({
      preflightCandidates: 3,
      selectedCandidates: 1,
      excludedByRecent: 2,
      excludedUndated: 1,
    });
    expect(plan.recentCutoff).toBe("2026-03-23T10:00:00.000Z");
  });
});

describe("executeEpisodeIngestPlan", () => {
  it("preserves final result order and aggregates usage across concurrent workers", async () => {
    const database = new MockEpisodeDatabase(
      {},
      {
        upsertHandler: async (input, index) => createUpsertResult(input, "inserted", `episode-${index + 1}`),
      },
    );

    const plan = buildPlan([
      buildCandidate({
        filePath: "/tmp/first.jsonl",
        sessionId: "first",
        renderedTranscript: "User: First candidate.\nAssistant: Delayed completion.",
      }),
      buildCandidate({
        filePath: "/tmp/second.jsonl",
        sessionId: "second",
        renderedTranscript: "User: Second candidate.\nAssistant: Immediate completion.",
      }),
    ]);

    const result = await executeEpisodeIngestPlan(
      plan,
      createPorts({
        episodes: database,
        createSummaryLlm: createSummaryLlmFactory([
          {
            delayMs: 20,
            response: buildSummaryJson("The first candidate completed after a delay but should still appear first in the final result array."),
            usage: {
              calls: 1,
              inputTokens: 11,
              outputTokens: 3,
              totalTokens: 14,
              totalCost: 0.01,
            },
          },
          {
            response: buildSummaryJson("The second candidate completed immediately and should still be stored in its original plan slot."),
            usage: {
              calls: 1,
              inputTokens: 19,
              outputTokens: 4,
              totalTokens: 23,
              totalCost: 0.02,
            },
          },
        ]),
      }),
      {
        concurrency: 2,
        genVersion: "cli-episodic-summary-v1",
      },
    );

    expect(result.sessions.map((session) => session.filePath)).toEqual(["/tmp/first.jsonl", "/tmp/second.jsonl"]);
    expect(result.sessions.map((session) => session.action)).toEqual(["written", "written"]);
    expect(result.usage).toEqual({
      calls: 2,
      inputTokens: 30,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 37,
      totalCost: 0.03,
    });
  });

  it("maps write outcomes, continues after failures, and reports progress", async () => {
    const database = new MockEpisodeDatabase(
      {},
      {
        upsertQueue: [
          createUpsertResult({ source: "openclaw", startedAt: "2026-03-30T09:00:00.000Z", summary: "written" }, "inserted", "episode-written"),
          createUpsertResult({ source: "openclaw", startedAt: "2026-03-30T09:00:00.000Z", summary: "updated" }, "updated", "episode-updated"),
          createUpsertResult({ source: "openclaw", startedAt: "2026-03-30T09:00:00.000Z", summary: "unchanged" }, "unchanged", "episode-unchanged"),
        ],
      },
    );
    const progressActions: string[] = [];

    const result = await executeEpisodeIngestPlan(
      buildPlan([
        buildCandidate({ filePath: "/tmp/written.jsonl", sessionId: "written" }),
        buildCandidate({ filePath: "/tmp/updated.jsonl", sessionId: "updated" }),
        buildCandidate({ filePath: "/tmp/unchanged.jsonl", sessionId: "unchanged" }),
        buildCandidate({ filePath: "/tmp/invalid.jsonl", sessionId: "invalid" }),
        buildCandidate({ filePath: "/tmp/error.jsonl", sessionId: "error" }),
      ]),
      createPorts({
        episodes: database,
        createSummaryLlm: createSummaryLlmFactory([
          { response: buildSummaryJson("Written candidate.") },
          { response: buildSummaryJson("Updated candidate.") },
          { response: buildSummaryJson("Unchanged candidate.") },
          { response: "not valid json" },
          { error: new Error("llm exploded") },
        ]),
      }),
      {
        concurrency: 1,
        genVersion: "cli-episodic-summary-v1",
        onProgress: (_completed, _total, session) => {
          progressActions.push(`${session.filePath}:${session.action}`);
        },
      },
    );

    expect(result.sessions.map((session) => session.action)).toEqual(["written", "updated", "unchanged", "failed", "failed"]);
    expect(result.sessions[3]).toEqual(
      expect.objectContaining({
        filePath: "/tmp/invalid.jsonl",
        action: "failed",
        error: "invalid_response",
      }),
    );
    expect(result.sessions[4]).toEqual(
      expect.objectContaining({
        filePath: "/tmp/error.jsonl",
        action: "failed",
        error: "llm exploded",
      }),
    );
    expect(progressActions).toEqual([
      "/tmp/written.jsonl:written",
      "/tmp/updated.jsonl:updated",
      "/tmp/unchanged.jsonl:unchanged",
      "/tmp/invalid.jsonl:failed",
      "/tmp/error.jsonl:failed",
    ]);
    expect(result.totals).toEqual({
      attempted: 5,
      written: 1,
      updated: 1,
      unchanged: 1,
      failed: 2,
    });
  });

  it("preserves existing metadata when regenerate candidates only provide weaker values", async () => {
    const existingEpisode = buildEpisode({
      id: "episode-existing",
      sourceRef: "/persisted/source.jsonl",
      agentId: "main",
      surface: "telegram",
    });
    const database = new MockEpisodeDatabase(
      {},
      {
        upsertHandler: async (input) => createUpsertResult(input, "updated", "episode-existing"),
      },
    );

    await executeEpisodeIngestPlan(
      buildPlan([
        buildCandidate({
          filePath: "/tmp/regenerate.jsonl",
          sourceRef: "/tmp/regenerate.jsonl",
          agentId: null,
          surface: null,
          metadataSource: "reconstructed",
          existingEpisode,
        }),
      ]),
      createPorts({
        episodes: database,
        createSummaryLlm: createSummaryLlmFactory([{ response: buildSummaryJson("Regenerated summary.") }]),
      }),
      {
        concurrency: 1,
        genVersion: "cli-episodic-summary-v1",
      },
    );

    expect(database.upsertInputs[0]).toEqual(
      expect.objectContaining({
        sourceRef: "/persisted/source.jsonl",
        agentId: "main",
        surface: "telegram",
      }),
    );
  });

  it("fails new candidates without startedAt and falls back to existing timestamps during regenerate", async () => {
    const existingEpisode = buildEpisode({
      id: "episode-fallback",
      startedAt: "2026-03-15T09:00:00.000Z",
      endedAt: "2026-03-15T09:30:00.000Z",
    });
    const database = new MockEpisodeDatabase(
      {},
      {
        upsertHandler: async (input) => createUpsertResult(input, "updated", "episode-fallback"),
      },
    );

    const result = await executeEpisodeIngestPlan(
      buildPlan([
        buildCandidate({
          filePath: "/tmp/missing-started-at.jsonl",
          sessionId: "missing-started-at",
          startedAt: undefined,
        }),
        buildCandidate({
          filePath: "/tmp/regenerate-fallback.jsonl",
          sessionId: "regenerate-fallback",
          startedAt: undefined,
          endedAt: undefined,
          existingEpisode,
        }),
      ]),
      createPorts({
        episodes: database,
        createSummaryLlm: createSummaryLlmFactory([{ response: buildSummaryJson("Timestamp fallback candidate.") }]),
      }),
      {
        concurrency: 1,
        genVersion: "cli-episodic-summary-v1",
      },
    );

    expect(result.sessions[0]).toEqual(
      expect.objectContaining({
        filePath: "/tmp/missing-started-at.jsonl",
        action: "failed",
        error: "missing_started_at",
        usage: expect.objectContaining({
          totalTokens: 0,
        }),
      }),
    );
    expect(result.sessions[1]).toEqual(
      expect.objectContaining({
        filePath: "/tmp/regenerate-fallback.jsonl",
        action: "updated",
        episodeId: "episode-fallback",
      }),
    );
    expect(database.upsertInputs[0]).toEqual(
      expect.objectContaining({
        startedAt: "2026-03-15T09:00:00.000Z",
        endedAt: "2026-03-15T09:30:00.000Z",
      }),
    );
  });
});

function createPorts(overrides: Partial<EpisodeIngestPorts> = {}): EpisodeIngestPorts {
  return {
    files: overrides.files ?? new MockEpisodeFiles([]),
    transcript: overrides.transcript ?? new MockTranscriptPort({}),
    episodes: overrides.episodes ?? new MockEpisodeDatabase(),
    createSummaryLlm: overrides.createSummaryLlm ?? createSummaryLlmFactory([]),
    sessionRegistry: overrides.sessionRegistry,
    sessionMetaInspector: overrides.sessionMetaInspector,
  };
}

class MockEpisodeFiles implements EpisodeIngestFilePort {
  public constructor(private readonly discoveredFiles: string[]) {}

  public async discoverFiles(): Promise<string[]> {
    return this.discoveredFiles;
  }
}

class MockTranscriptPort implements TranscriptPort {
  public constructor(
    private readonly transcripts: Record<string, ParsedTranscript>,
    private readonly options: {
      delaysMs?: Record<string, number>;
    } = {},
  ) {}

  public async parseFile(filePath: string): Promise<ParsedTranscript> {
    const delayMs = this.options.delaysMs?.[filePath];
    if (delayMs) {
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }

    const transcript = this.transcripts[filePath];
    if (!transcript) {
      throw new Error(`Missing transcript fixture for ${filePath}`);
    }

    return transcript;
  }
}

class MockEpisodeDatabase implements EpisodeDatabasePort {
  public readonly upsertInputs: EpisodeInput[] = [];
  private readonly upsertQueue: EpisodeUpsertResult[];
  private readonly upsertHandler?: (input: EpisodeInput, index: number) => Promise<EpisodeUpsertResult> | EpisodeUpsertResult;

  public constructor(
    private readonly episodes: {
      bySourceId?: Record<string, Episode>;
      byTranscriptHash?: Record<string, Episode>;
    } = {},
    options: {
      upsertQueue?: EpisodeUpsertResult[];
      upsertHandler?: (input: EpisodeInput, index: number) => Promise<EpisodeUpsertResult> | EpisodeUpsertResult;
    } = {},
  ) {
    this.upsertQueue = [...(options.upsertQueue ?? [])];
    this.upsertHandler = options.upsertHandler;
  }

  public async getEpisodeBySourceId(_source: "openclaw", sourceId: string): Promise<Episode | null> {
    return this.episodes.bySourceId?.[sourceId] ?? null;
  }

  public async getEpisodeByTranscriptHash(_source: "openclaw", transcriptHash: string): Promise<Episode | null> {
    return this.episodes.byTranscriptHash?.[transcriptHash] ?? null;
  }

  public async upsertEpisode(input: EpisodeInput): Promise<EpisodeUpsertResult> {
    this.upsertInputs.push(input);
    const index = this.upsertInputs.length - 1;
    if (this.upsertHandler) {
      return await this.upsertHandler(input, index);
    }

    const queued = this.upsertQueue.shift();
    if (queued) {
      return queued;
    }

    throw new Error("Stage 1 preflight should not write episodes.");
  }

  public async listEpisodesByTimeWindow(): Promise<Episode[]> {
    return [];
  }
}

type SummaryLlmBehavior = {
  response?: string;
  error?: Error;
  delayMs?: number;
  usage?: Partial<EpisodeIngestLlmPort["metadata"]["usage"]>;
  modelRef?: string;
};

function createSummaryLlmFactory(behaviors: SummaryLlmBehavior[]): () => EpisodeIngestLlmPort {
  const queue = [...behaviors];

  return () =>
    new MockSummaryLlm(
      queue.shift() ?? {
        response: buildSummaryJson("Default episode summary response."),
      },
    );
}

class MockSummaryLlm implements EpisodeIngestLlmPort {
  public readonly metadata;

  public constructor(private readonly behavior: SummaryLlmBehavior) {
    this.metadata = {
      modelRef: behavior.modelRef ?? TEST_MODEL.modelRef,
      pricing: TEST_MODEL.pricing,
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
  }

  public async complete(_systemPrompt: string, _userMessage: string): Promise<string> {
    if (this.behavior.delayMs) {
      await new Promise((resolve) => {
        setTimeout(resolve, this.behavior.delayMs);
      });
    }

    const usage = this.behavior.usage ?? {
      calls: 1,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      totalCost: 0.01,
    };
    this.metadata.usage = {
      ...this.metadata.usage,
      ...usage,
      calls: usage.calls ?? this.metadata.usage.calls,
      inputTokens: usage.inputTokens ?? this.metadata.usage.inputTokens,
      outputTokens: usage.outputTokens ?? this.metadata.usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? this.metadata.usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens ?? this.metadata.usage.cacheWriteTokens,
      totalTokens: usage.totalTokens ?? this.metadata.usage.totalTokens,
      totalCost: usage.totalCost ?? this.metadata.usage.totalCost,
    };

    if (this.behavior.error) {
      throw this.behavior.error;
    }

    return this.behavior.response ?? buildSummaryJson("Default episode summary response.");
  }

  public async completeJson<T>(systemPrompt: string, userMessage: string): Promise<T> {
    return JSON.parse(await this.complete(systemPrompt, userMessage)) as T;
  }
}

class MockSessionRegistry implements SessionRegistryPort {
  public constructor(private readonly entries: Record<string, SessionMeta>) {}

  public async getSessionMeta(sessionId: string): Promise<SessionMeta | undefined> {
    return this.entries[sessionId];
  }

  public async listSessions(): Promise<SessionMeta[]> {
    return Object.values(this.entries);
  }
}

class MockSessionMetaInspector implements SessionMetaInspectorPort {
  public constructor(private readonly entries: Record<string, { surface: string | null; metadataSource: "reconstructed" | "none" }>) {}

  public async inspectFile(filePath: string): Promise<{ surface: string | null; metadataSource: "reconstructed" | "none" }> {
    return this.entries[filePath] ?? { surface: null, metadataSource: "none" };
  }
}

function buildTranscript(
  overrides: {
    sessionId?: string;
    transcriptHash?: string;
    endedAt?: string;
    messages?: ParsedTranscript["messages"];
  } = {},
): ParsedTranscript {
  const messages = overrides.messages ?? buildMessages(4);

  return {
    messages,
    metadata: {
      sessionId: overrides.sessionId,
      startedAt: messages[0]?.timestamp,
      endedAt: overrides.endedAt ?? messages[messages.length - 1]?.timestamp,
      messageCount: messages.length,
      transcriptHash: overrides.transcriptHash ?? "service-transcript-hash",
    },
    warnings: [],
  };
}

function buildMessages(count: number, text = "This is a durable transcript message."): ParsedTranscript["messages"] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    role: index % 2 === 0 ? "user" : "assistant",
    text,
    timestamp: `2026-03-30T09:0${index}:00.000Z`,
  }));
}

function buildEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: overrides.id ?? "episode-default",
    source: "openclaw",
    sourceId: overrides.sourceId,
    sourceRef: overrides.sourceRef ?? "/tmp/source.jsonl",
    transcriptHash: overrides.transcriptHash,
    summaryHash: overrides.summaryHash ?? "summary-hash",
    agentId: overrides.agentId,
    surface: overrides.surface,
    startedAt: overrides.startedAt ?? "2026-03-30T09:00:00.000Z",
    endedAt: overrides.endedAt ?? "2026-03-30T09:30:00.000Z",
    summary: overrides.summary ?? "Stored episode summary.",
    tags: overrides.tags ?? ["episodes"],
    activityLevel: overrides.activityLevel ?? "substantial",
    userId: overrides.userId,
    project: overrides.project,
    genModel: overrides.genModel,
    genVersion: overrides.genVersion,
    messageCount: overrides.messageCount ?? 4,
    embedding: overrides.embedding,
    retired: overrides.retired ?? false,
    retiredAt: overrides.retiredAt,
    retiredReason: overrides.retiredReason,
    supersededBy: overrides.supersededBy,
    createdAt: overrides.createdAt ?? "2026-03-30T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-03-30T10:00:00.000Z",
  };
}

function buildCandidate(overrides: Partial<EpisodeIngestCandidate> = {}): EpisodeIngestCandidate {
  return {
    filePath: "filePath" in overrides ? (overrides.filePath ?? "/tmp/candidate.jsonl") : "/tmp/candidate.jsonl",
    sessionId: "sessionId" in overrides ? overrides.sessionId : "candidate-session",
    sourceRef: "sourceRef" in overrides ? (overrides.sourceRef ?? "/tmp/candidate.jsonl") : "/tmp/candidate.jsonl",
    transcriptHash: "transcriptHash" in overrides ? (overrides.transcriptHash ?? "candidate-transcript-hash") : "candidate-transcript-hash",
    startedAt: "startedAt" in overrides ? overrides.startedAt : "2026-03-30T09:00:00.000Z",
    endedAt: "endedAt" in overrides ? overrides.endedAt : "2026-03-30T09:30:00.000Z",
    messageCount: "messageCount" in overrides ? (overrides.messageCount ?? 4) : 4,
    agentId: "agentId" in overrides ? (overrides.agentId ?? null) : "main",
    surface: "surface" in overrides ? (overrides.surface ?? null) : "webchat",
    metadataSource: "metadataSource" in overrides ? (overrides.metadataSource ?? "registry") : "registry",
    renderedTranscript:
      "renderedTranscript" in overrides
        ? (overrides.renderedTranscript ?? "User: Candidate transcript.\nAssistant: Candidate reply.")
        : "User: Candidate transcript.\nAssistant: Candidate reply.",
    estimatedInputTokens: "estimatedInputTokens" in overrides ? (overrides.estimatedInputTokens ?? 1) : 1,
    existingEpisode: "existingEpisode" in overrides ? overrides.existingEpisode : undefined,
  };
}

function buildPlan(candidates: EpisodeIngestCandidate[]) {
  return createEpisodeIngestPlan(
    {
      files: candidates.map((candidate) => candidate.filePath),
      candidates,
      skipped: [],
      invalid: [],
      totals: {
        discovered: candidates.length,
        candidates: candidates.length,
        skipped: 0,
        invalid: 0,
        skippedShort: 0,
        skippedActive: 0,
        skippedExists: 0,
      },
    },
    TEST_MODEL,
  );
}

function buildSummaryJson(summary: string): string {
  return JSON.stringify({
    summary,
    tags: ["episodes", "stage2", "agenr"],
    activityLevel: "substantial",
    project: "agenr",
  });
}

function createUpsertResult(input: Partial<EpisodeInput>, action: EpisodeUpsertResult["action"], id: string): EpisodeUpsertResult {
  return {
    action,
    episode: buildEpisode({
      id,
      source: input.source ?? "openclaw",
      sourceId: input.sourceId,
      sourceRef: input.sourceRef ?? "/tmp/source.jsonl",
      transcriptHash: input.transcriptHash,
      agentId: input.agentId,
      surface: input.surface,
      startedAt: input.startedAt ?? "2026-03-30T09:00:00.000Z",
      endedAt: input.endedAt,
      summary: input.summary ?? "Stored episode summary.",
      tags: input.tags,
      activityLevel: input.activityLevel,
      project: input.project,
      genModel: input.genModel,
      genVersion: input.genVersion,
      messageCount: input.messageCount,
    }),
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

const TEST_MODEL: EpisodeIngestModelInfo = {
  modelRef: "openai/gpt-5.4-mini",
  pricing: {
    input: 0.75,
    output: 4.5,
    cacheRead: 0.075,
    cacheWrite: 0,
  },
};
