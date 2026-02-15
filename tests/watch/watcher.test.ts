import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeEntry, WatchState } from "../../src/types.js";
import { runWatcher } from "../../src/watch/watcher.js";

function makeEntry(content = "fact"): KnowledgeEntry {
  return {
    type: "fact",
    subject: "Jim",
    content,
    confidence: "high",
    expiry: "temporary",
    tags: [],
    source: {
      file: "source.jsonl",
      context: "test",
    },
  };
}

function makeState(filePath: string, offset = 0): WatchState {
  return {
    version: 1,
    files: {
      [filePath]: {
        filePath,
        byteOffset: offset,
        lastRunAt: "2026-02-15T00:00:00.000Z",
        totalEntriesStored: 1,
        totalRunCount: 1,
      },
    },
  };
}

function makeDeps(overrides?: Record<string, unknown>) {
  const saveSnapshots: WatchState[] = [];
  const statFileFn = vi.fn(async () => ({ size: 0, isFile: () => true }));
  const readFileFn = vi.fn(async () => Buffer.alloc(0));
  const parseTranscriptFileFn = vi.fn(async () => ({
    file: "/tmp/delta.txt",
    messages: [],
    chunks: [
      {
        chunk_index: 0,
        message_start: 0,
        message_end: 0,
        text: "chunk text",
        context_hint: "ctx",
      },
    ],
    warnings: [],
  }));
  const extractKnowledgeFromChunksFn = vi.fn(async () => ({
    entries: [makeEntry("one"), makeEntry("two")],
    successfulChunks: 1,
    failedChunks: 0,
    warnings: [],
  }));
  const storeEntriesFn = vi.fn(async () => ({
    added: 1,
    updated: 1,
    skipped: 0,
    relations_created: 0,
    total_entries: 2,
    duration_ms: 5,
  }));

  const deps = {
    readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } })),
    resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
    parseTranscriptFileFn,
    createLlmClientFn: vi.fn(() => ({ resolvedModel: { modelId: "test" }, credentials: { apiKey: "x" } } as any)),
    extractKnowledgeFromChunksFn,
    deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
    getDbFn: vi.fn(() => ({}) as any),
    initDbFn: vi.fn(async () => undefined),
    closeDbFn: vi.fn(() => undefined),
    storeEntriesFn,
    loadWatchStateFn: vi.fn(async () => ({ version: 1 as const, files: {} })),
    saveWatchStateFn: vi.fn(async (state: WatchState) => {
      saveSnapshots.push(JSON.parse(JSON.stringify(state)) as WatchState);
    }),
    statFileFn,
    readFileFn,
    mkdtempFn: vi.fn(async () => "/tmp/agenr-watch-test"),
    writeFileFn: vi.fn(async () => undefined),
    rmFn: vi.fn(async () => undefined),
    nowFn: vi.fn(() => new Date("2026-02-15T00:00:00.000Z")),
    sleepFn: vi.fn(async () => undefined),
    shouldShutdownFn: vi.fn(() => false),
    saveSnapshots,
    ...overrides,
  };

  return deps;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("watcher", () => {
  it("skips cycles when new content is below threshold", async () => {
    const filePath = "/tmp/watch.jsonl";
    const deps = makeDeps({
      statFileFn: vi.fn(async () => ({ size: 3, isFile: () => true })),
      readFileFn: vi.fn(async () => Buffer.from("abc")),
    });

    const cycleResults: Array<{ skipped: boolean; bytesRead: number }> = [];
    const result = await runWatcher(
      {
        filePath,
        intervalMs: 1,
        minChunkChars: 20,
        dryRun: false,
        verbose: false,
        once: true,
        onCycle: (cycle) => cycleResults.push({ skipped: cycle.skipped, bytesRead: cycle.bytesRead }),
      },
      deps,
    );

    expect(result.cycles).toBe(1);
    expect(cycleResults[0]).toEqual({ skipped: true, bytesRead: 3 });
    expect(deps.parseTranscriptFileFn).not.toHaveBeenCalled();
    expect(deps.storeEntriesFn).not.toHaveBeenCalled();
  });

  it("processes new content and advances offset", async () => {
    const filePath = "/tmp/watch.jsonl";
    const state = makeState(filePath, 5);
    const deps = makeDeps({
      loadWatchStateFn: vi.fn(async () => state),
      statFileFn: vi.fn(async () => ({ size: 20, isFile: () => true })),
      readFileFn: vi.fn(async (_target: string, offset: number) => {
        expect(offset).toBe(5);
        return Buffer.from("0123456789ABCDE");
      }),
    });

    const cycleResults: Array<{ extracted: number; stored: number; skipped: boolean }> = [];
    await runWatcher(
      {
        filePath,
        intervalMs: 1,
        minChunkChars: 5,
        dryRun: false,
        verbose: false,
        once: true,
        onCycle: (cycle) =>
          cycleResults.push({
            extracted: cycle.entriesExtracted,
            stored: cycle.entriesStored,
            skipped: cycle.skipped,
          }),
      },
      deps,
    );

    expect(cycleResults[0]).toEqual({ extracted: 2, stored: 2, skipped: false });
    expect(deps.storeEntriesFn).toHaveBeenCalledTimes(1);
    expect(deps.saveSnapshots.at(-1)?.files[filePath]?.byteOffset).toBe(20);
  });

  it("resets offset when file is truncated", async () => {
    const filePath = "/tmp/watch.jsonl";
    const state = makeState(filePath, 100);
    const statFileFn = vi
      .fn()
      .mockResolvedValueOnce({ size: 50, isFile: () => true })
      .mockResolvedValueOnce({ size: 50, isFile: () => true });

    const deps = makeDeps({
      loadWatchStateFn: vi.fn(async () => state),
      statFileFn,
      readFileFn: vi.fn(async (_target: string, offset: number) => {
        expect(offset).toBe(0);
        return Buffer.from("this is enough text");
      }),
      extractKnowledgeFromChunksFn: vi.fn(async () => ({
        entries: [],
        successfulChunks: 1,
        failedChunks: 0,
        warnings: [],
      })),
    });

    await runWatcher(
      {
        filePath,
        intervalMs: 1,
        minChunkChars: 5,
        dryRun: true,
        verbose: false,
        once: true,
      },
      deps,
    );

    expect(deps.saveSnapshots[0]?.files[filePath]?.byteOffset).toBe(0);
    expect(deps.saveSnapshots.at(-1)?.files[filePath]?.byteOffset).toBe(50);
  });

  it("honors once mode and exits after a single cycle", async () => {
    const filePath = "/tmp/watch.jsonl";
    const statFileFn = vi
      .fn()
      .mockResolvedValueOnce({ size: 0, isFile: () => true })
      .mockResolvedValueOnce({ size: 0, isFile: () => true });
    const deps = makeDeps({ statFileFn });

    const result = await runWatcher(
      {
        filePath,
        intervalMs: 1,
        minChunkChars: 5,
        dryRun: true,
        verbose: false,
        once: true,
      },
      deps,
    );

    expect(result.cycles).toBe(1);
    expect(statFileFn).toHaveBeenCalledTimes(2);
  });

  it("extracts in dry-run mode without storing", async () => {
    const filePath = "/tmp/watch.jsonl";
    const deps = makeDeps({
      statFileFn: vi.fn(async () => ({ size: 25, isFile: () => true })),
      readFileFn: vi.fn(async () => Buffer.from("this content passes threshold")),
    });

    await runWatcher(
      {
        filePath,
        intervalMs: 1,
        minChunkChars: 5,
        dryRun: true,
        verbose: false,
        once: true,
      },
      deps,
    );

    expect(deps.extractKnowledgeFromChunksFn).toHaveBeenCalledTimes(1);
    expect(deps.storeEntriesFn).not.toHaveBeenCalled();
  });

  it("stops looping when shutdown flag is raised", async () => {
    const filePath = "/tmp/watch.jsonl";
    let shutdown = false;
    const statFileFn = vi
      .fn()
      .mockResolvedValueOnce({ size: 20, isFile: () => true })
      .mockResolvedValueOnce({ size: 10, isFile: () => true })
      .mockResolvedValueOnce({ size: 20, isFile: () => true });
    const readFileFn = vi
      .fn()
      .mockResolvedValueOnce(Buffer.from("0123456789"))
      .mockResolvedValueOnce(Buffer.from("abcdefghij"));
    const deps = makeDeps({
      statFileFn,
      readFileFn,
      shouldShutdownFn: vi.fn(() => shutdown),
      sleepFn: vi.fn(async () => undefined),
    });

    const result = await runWatcher(
      {
        filePath,
        intervalMs: 1,
        minChunkChars: 5,
        dryRun: true,
        verbose: false,
        once: false,
        onCycle: () => {
          if (statFileFn.mock.calls.length >= 3) {
            shutdown = true;
          }
        },
      },
      deps,
    );

    expect(result.cycles).toBe(2);
    expect(readFileFn).toHaveBeenCalledTimes(2);
  });

  it("continues after extract errors", async () => {
    const filePath = "/tmp/watch.jsonl";
    let shutdown = false;
    const extractKnowledgeFromChunksFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("LLM temporary failure"))
      .mockResolvedValueOnce({
        entries: [makeEntry("ok")],
        successfulChunks: 1,
        failedChunks: 0,
        warnings: [],
      });
    const deps = makeDeps({
      statFileFn: vi
        .fn()
        .mockResolvedValueOnce({ size: 12, isFile: () => true })
        .mockResolvedValueOnce({ size: 12, isFile: () => true })
        .mockResolvedValueOnce({ size: 12, isFile: () => true }),
      readFileFn: vi.fn(async (_target: string, offset: number) => {
        expect(offset).toBe(0);
        return Buffer.from("hello world!");
      }),
      extractKnowledgeFromChunksFn,
      shouldShutdownFn: vi.fn(() => shutdown),
      sleepFn: vi.fn(async () => undefined),
    });

    const errors: string[] = [];
    const result = await runWatcher(
      {
        filePath,
        intervalMs: 1,
        minChunkChars: 5,
        dryRun: true,
        verbose: false,
        once: false,
        onCycle: (cycle) => {
          if (cycle.error) {
            errors.push(cycle.error);
          }
          if (errors.length >= 1 && deps.saveSnapshots.length >= 1) {
            shutdown = true;
          }
        },
      },
      deps,
    );

    expect(result.cycles).toBe(2);
    expect(errors.length).toBe(1);
    expect(deps.saveSnapshots).toHaveLength(1);
  });

  it("continues after store errors and retries same offset", async () => {
    const filePath = "/tmp/watch.jsonl";
    let shutdown = false;
    const readOffsets: number[] = [];
    const storeEntriesFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("db locked"))
      .mockResolvedValueOnce({
        added: 1,
        updated: 0,
        skipped: 0,
        relations_created: 0,
        total_entries: 1,
        duration_ms: 5,
      });
    const deps = makeDeps({
      statFileFn: vi
        .fn()
        .mockResolvedValueOnce({ size: 12, isFile: () => true })
        .mockResolvedValueOnce({ size: 12, isFile: () => true })
        .mockResolvedValueOnce({ size: 12, isFile: () => true }),
      readFileFn: vi.fn(async (_target: string, offset: number) => {
        readOffsets.push(offset);
        return Buffer.from("hello world!");
      }),
      storeEntriesFn,
      shouldShutdownFn: vi.fn(() => shutdown),
      sleepFn: vi.fn(async () => undefined),
    });

    const errors: string[] = [];
    await runWatcher(
      {
        filePath,
        intervalMs: 1,
        minChunkChars: 5,
        dryRun: false,
        verbose: false,
        once: false,
        onCycle: (cycle) => {
          if (cycle.error) {
            errors.push(cycle.error);
          }
          if (errors.length >= 1 && deps.saveSnapshots.length >= 1) {
            shutdown = true;
          }
        },
      },
      deps,
    );

    expect(errors.length).toBe(1);
    expect(readOffsets).toEqual([0, 0]);
    expect(deps.saveSnapshots).toHaveLength(1);
  });
});
