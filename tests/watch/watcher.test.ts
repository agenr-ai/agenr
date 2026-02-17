import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeEntry, WatchState } from "../../src/types.js";
import { runWatcher } from "../../src/watch/watcher.js";
import { isShutdownRequested, requestShutdown, resetShutdownForTests } from "../../src/shutdown.js";

function makeEntry(content = "fact"): KnowledgeEntry {
  return {
    type: "fact",
    subject: "Jim",
    content,
    importance: 8,
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

function makeDeps(overrides?: Record<string, unknown>): any {
  const saveSnapshots: WatchState[] = [];
  const statFileFn = vi.fn(async () => ({ size: 0, isFile: () => true })) as any;
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
  const extractKnowledgeFromChunksFn = vi.fn(async (params: { onChunkComplete?: (result: {
    chunkIndex: number;
    totalChunks: number;
    entries: KnowledgeEntry[];
    warnings: string[];
  }) => Promise<void> }) => {
    await params.onChunkComplete?.({
      chunkIndex: 0,
      totalChunks: 1,
      entries: [makeEntry("one"), makeEntry("two")],
      warnings: [],
    });
    return {
      entries: [],
      successfulChunks: 1,
      failedChunks: 0,
      warnings: [],
    };
  });
  const storeEntriesFn = vi.fn(async () => ({
    added: 1,
    updated: 1,
    skipped: 0,
    superseded: 0,
    llm_dedup_calls: 0,
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
    walCheckpointFn: vi.fn(async () => undefined),
    nowFn: vi.fn(() => new Date("2026-02-15T00:00:00.000Z")),
    sleepFn: vi.fn(async () => undefined),
    shouldShutdownFn: vi.fn(() => false),
    saveSnapshots,
    ...overrides,
  };

  return deps;
}

afterEach(() => {
  resetShutdownForTests();
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

  it("streams extraction chunks through callback and stores incrementally", async () => {
    const filePath = "/tmp/watch.jsonl";
    const parseTranscriptFileFn = vi.fn(async () => ({
      file: "/tmp/delta.txt",
      messages: [],
      chunks: [
        {
          chunk_index: 0,
          message_start: 0,
          message_end: 0,
          text: "chunk 0",
          context_hint: "ctx 0",
        },
        {
          chunk_index: 1,
          message_start: 1,
          message_end: 1,
          text: "chunk 1",
          context_hint: "ctx 1",
        },
      ],
      warnings: [],
    }));
    const extractKnowledgeFromChunksFn = vi.fn(
      async (params: {
        onChunkComplete?: (result: {
          chunkIndex: number;
          totalChunks: number;
          entries: KnowledgeEntry[];
          warnings: string[];
        }) => Promise<void>;
      }) => {
        if (!params.onChunkComplete) {
          throw new Error("expected onChunkComplete callback");
        }

        await params.onChunkComplete({
          chunkIndex: 0,
          totalChunks: 2,
          entries: [makeEntry("one")],
          warnings: [],
        });
        await params.onChunkComplete({
          chunkIndex: 1,
          totalChunks: 2,
          entries: [makeEntry("two")],
          warnings: [],
        });

        return {
          entries: [],
          successfulChunks: 2,
          failedChunks: 0,
          warnings: [],
        };
      },
    );
    const storeEntriesFn = vi.fn(async (_db: unknown, entries: KnowledgeEntry[]) => ({
      added: entries.length,
      updated: 0,
      skipped: 0,
      superseded: 0,
      llm_dedup_calls: 0,
      relations_created: 0,
      total_entries: entries.length,
      duration_ms: 5,
    }));
    const deps = makeDeps({
      statFileFn: vi.fn(async () => ({ size: 25, isFile: () => true })),
      readFileFn: vi.fn(async () => Buffer.from("this content passes threshold")),
      parseTranscriptFileFn,
      extractKnowledgeFromChunksFn,
      storeEntriesFn,
      deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
    });

    const cycleResults: Array<{ extracted: number; stored: number }> = [];
    await runWatcher(
      {
        filePath,
        intervalMs: 1,
        minChunkChars: 5,
        dryRun: false,
        verbose: false,
        once: true,
        onCycle: (cycle) => {
          cycleResults.push({
            extracted: cycle.entriesExtracted,
            stored: cycle.entriesStored,
          });
        },
      },
      deps,
    );

    expect(cycleResults[0]).toEqual({ extracted: 2, stored: 2 });
    expect(extractKnowledgeFromChunksFn).toHaveBeenCalledTimes(1);
    expect(storeEntriesFn).toHaveBeenCalledTimes(2);
  });

  it("passes online dedup options to store by default", async () => {
    const filePath = "/tmp/watch.jsonl";
    const storeEntriesFn = vi.fn(async (_db: unknown, entries: KnowledgeEntry[]) => {
      return {
        added: entries.length,
        updated: 0,
        skipped: 0,
        superseded: 0,
        llm_dedup_calls: 1,
        relations_created: 0,
        total_entries: entries.length,
        duration_ms: 5,
      };
    });
    const deps = makeDeps({
      statFileFn: vi.fn(async () => ({ size: 25, isFile: () => true })),
      readFileFn: vi.fn(async () => Buffer.from("this content passes threshold")),
      storeEntriesFn,
      deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
    });

    await runWatcher(
      {
        filePath,
        intervalMs: 1,
        minChunkChars: 5,
        dryRun: false,
        verbose: false,
        once: true,
      },
      deps,
    );

    expect(storeEntriesFn).toHaveBeenCalledTimes(1);
    const optionsArg = (storeEntriesFn.mock.calls as unknown[][])[0]?.[3] as Record<string, unknown> | undefined;
    expect(optionsArg?.onlineDedup).toBe(true);
    expect(optionsArg?.llmClient).toBeTruthy();
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
        superseded: 0,
        llm_dedup_calls: 0,
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

  it("switches active files in directory mode and preserves per-file offsets", async () => {
    const fileA = "/tmp/watch-a.jsonl";
    const fileB = "/tmp/watch-b.jsonl";
    let shutdown = false;
    let resolveCalls = 0;

    const state: WatchState = {
      version: 1,
      files: {
        [fileA]: {
          filePath: fileA,
          byteOffset: 5,
          lastRunAt: "2026-02-15T00:00:00.000Z",
          totalEntriesStored: 0,
          totalRunCount: 0,
        },
        [fileB]: {
          filePath: fileB,
          byteOffset: 2,
          lastRunAt: "2026-02-15T00:00:00.000Z",
          totalEntriesStored: 0,
          totalRunCount: 0,
        },
      },
    };

    const resolver = {
      filePattern: "*.jsonl",
      resolveActiveSession: vi.fn(async () => {
        resolveCalls += 1;
        if (resolveCalls === 1) {
          return fileA;
        }
        return fileB;
      }),
    };

    const readOffsets: Record<string, number[]> = {
      [fileA]: [],
      [fileB]: [],
    };

    const deps = makeDeps({
      loadWatchStateFn: vi.fn(async () => state),
      statFileFn: vi.fn(async (target: string) => ({
        size: target === fileA ? 10 : 8,
        isFile: () => true,
      })),
      readFileFn: vi.fn(async (target: string, offset: number) => {
        readOffsets[target]?.push(offset);
        return Buffer.from(target === fileA ? "abcde" : "123456");
      }),
      extractKnowledgeFromChunksFn: vi.fn(async () => ({
        entries: [],
        successfulChunks: 1,
        failedChunks: 0,
        warnings: [],
      })),
      sleepFn: vi.fn(async () => undefined),
      shouldShutdownFn: vi.fn(() => shutdown),
    });

    let cycles = 0;
    await runWatcher(
      {
        intervalMs: 1,
        minChunkChars: 1,
        dryRun: true,
        verbose: false,
        once: false,
        directoryMode: true,
        sessionsDir: "/tmp/sessions",
        resolver,
        onCycle: () => {
          cycles += 1;
          if (cycles >= 3) {
            shutdown = true;
          }
        },
      },
      deps,
    );

    expect(readOffsets[fileA]).toEqual([5]);
    expect(readOffsets[fileB]).toEqual([2]);
    expect(deps.saveSnapshots.some((snapshot) => snapshot.files[fileA]?.byteOffset === 10)).toBe(true);
    expect(deps.saveSnapshots.some((snapshot) => snapshot.files[fileB]?.byteOffset === 8)).toBe(true);
  });

  it("keeps current file when resolver fails in directory mode", async () => {
    const filePath = "/tmp/watch.jsonl";
    const warnings: string[] = [];
    const deps = makeDeps({
      statFileFn: vi.fn(async () => ({ size: 15, isFile: () => true })),
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
        directoryMode: true,
        sessionsDir: "/tmp/sessions",
        resolver: {
          filePattern: "*.jsonl",
          resolveActiveSession: vi.fn(async () => {
            throw new Error("manifest temporarily unavailable");
          }),
        },
        onWarn: (message) => warnings.push(message),
      },
      deps,
    );

    expect(warnings.some((warning) => warning.includes("Session resolution failed"))).toBe(true);
    expect(deps.readFileFn).toHaveBeenCalledWith(filePath, 0);
  });

  it("supports immediate wake-up from fs.watch events", async () => {
    const filePath = "/tmp/watch.jsonl";
    let shutdown = false;
    let cycleCount = 0;
    let watchCallback: ((eventType: string, filename?: string) => void) | null = null;
    const fakeWatcher = { close: vi.fn() };

    const deps = makeDeps({
      statFileFn: vi.fn(async () => ({ size: 0, isFile: () => true })),
      sleepFn: vi.fn(() => new Promise<void>(() => undefined)),
      shouldShutdownFn: vi.fn(() => shutdown),
      watchFn: vi.fn((_target: string, _opts: unknown, callback: (eventType: string, filename?: string) => void) => {
        watchCallback = callback;
        return fakeWatcher as any;
      }),
    });

    await runWatcher(
      {
        intervalMs: 1000,
        minChunkChars: 5,
        dryRun: true,
        verbose: false,
        once: false,
        directoryMode: true,
        sessionsDir: "/tmp/sessions",
        resolver: {
          filePattern: "*.jsonl",
          resolveActiveSession: vi.fn(async () => filePath),
        },
        fsWatchDebounceMs: 0,
        onCycle: () => {
          cycleCount += 1;
          if (cycleCount === 1) {
            watchCallback?.("change", "session.jsonl");
            return;
          }
          shutdown = true;
        },
      },
      deps,
    );

    expect(cycleCount).toBe(2);
    expect(fakeWatcher.close).toHaveBeenCalled();
  });

  it("falls back to polling when fs.watch hits EMFILE", async () => {
    const warnings: string[] = [];
    const watchError = new Error("too many files") as NodeJS.ErrnoException;
    watchError.code = "EMFILE";

    const deps = makeDeps({
      watchFn: vi.fn(() => {
        throw watchError;
      }) as any,
      statFileFn: vi.fn(async () => ({ size: 0, isFile: () => true })),
    });

    await runWatcher(
      {
        intervalMs: 1,
        minChunkChars: 5,
        dryRun: true,
        verbose: false,
        once: true,
        directoryMode: true,
        sessionsDir: "/tmp/sessions",
        resolver: {
          filePattern: "*.jsonl",
          resolveActiveSession: vi.fn(async () => null),
        },
        onWarn: (message) => warnings.push(message),
      },
      deps,
    );

    expect(warnings.some((warning) => warning.includes("EMFILE"))).toBe(true);
  });

  it("closes fs.watch handles and exits when shutdown is requested", async () => {
    const filePath = "/tmp/watch.jsonl";
    const fakeWatcher = { close: vi.fn() };
    let cycleCount = 0;

    const deps = makeDeps({
      statFileFn: vi.fn(async () => ({ size: 0, isFile: () => true })),
      sleepFn: vi.fn(async () => undefined),
      shouldShutdownFn: isShutdownRequested,
      watchFn: vi.fn((_target: string, _opts: unknown, _callback: (eventType: string, filename?: string) => void) => {
        return fakeWatcher as any;
      }),
      walCheckpointFn: vi.fn(async () => undefined),
    });

    const result = await runWatcher(
      {
        intervalMs: 1,
        minChunkChars: 5,
        dryRun: false,
        verbose: false,
        once: false,
        directoryMode: true,
        sessionsDir: "/tmp/sessions",
        resolver: {
          filePattern: "*.jsonl",
          resolveActiveSession: vi.fn(async () => filePath),
        },
        onCycle: () => {
          cycleCount += 1;
          if (cycleCount === 1) {
            requestShutdown();
          }
        },
      },
      deps,
    );

    expect(result.cycles).toBe(1);
    expect(fakeWatcher.close).toHaveBeenCalled();
    expect(deps.walCheckpointFn).toHaveBeenCalled();
  });

  it("checkpoints WAL after cycles that stored entries", async () => {
    const walCheckpointFn = vi.fn(async () => undefined);
    let shutdown = false;

    const result = await runWatcher(
      {
        filePath: "/tmp/watch.jsonl",
        intervalMs: 1,
        minChunkChars: 5,
        dryRun: false,
        verbose: false,
        once: false,
        onCycle: (cycle) => {
          expect(cycle.entriesStored).toBeGreaterThan(0);
          expect(walCheckpointFn).toHaveBeenCalledTimes(0);
          shutdown = true;
        },
      },
      makeDeps({
        walCheckpointFn,
        shouldShutdownFn: vi.fn(() => shutdown),
      }),
    );

    expect(result.cycles).toBe(1);
    expect(walCheckpointFn).toHaveBeenCalledTimes(2);
  });

  it("does not checkpoint WAL per-cycle when no entries were stored", async () => {
    const walCheckpointFn = vi.fn(async () => undefined);
    let shutdown = false;
    const storeEntriesFn = vi.fn(async () => ({
      added: 0,
      updated: 0,
      skipped: 0,
      superseded: 0,
      llm_dedup_calls: 0,
      relations_created: 0,
      total_entries: 1,
      duration_ms: 5,
    }));

    const result = await runWatcher(
      {
        filePath: "/tmp/watch.jsonl",
        intervalMs: 1,
        minChunkChars: 5,
        dryRun: false,
        verbose: false,
        once: false,
        onCycle: (cycle) => {
          expect(cycle.entriesStored).toBe(0);
          expect(walCheckpointFn).toHaveBeenCalledTimes(0);
          shutdown = true;
        },
      },
      makeDeps({
        walCheckpointFn,
        storeEntriesFn,
        shouldShutdownFn: vi.fn(() => shutdown),
      }),
    );

    expect(result.cycles).toBe(1);
    expect(walCheckpointFn).toHaveBeenCalledTimes(1);
  });

  it("does not crash if per-cycle WAL checkpoint fails", async () => {
    const walCheckpointFn = vi.fn(async () => {
      throw new Error("checkpoint failed");
    });
    const warnings: string[] = [];
    let shutdown = false;

    const result = await runWatcher(
      {
        filePath: "/tmp/watch.jsonl",
        intervalMs: 1,
        minChunkChars: 5,
        dryRun: false,
        verbose: false,
        once: false,
        onCycle: () => {
          shutdown = true;
        },
        onWarn: (message) => {
          warnings.push(message);
        },
      },
      makeDeps({
        walCheckpointFn,
        shouldShutdownFn: vi.fn(() => shutdown),
      }),
    );

    expect(result.cycles).toBe(1);
    expect(warnings.some((message) => message.includes("WAL checkpoint failed: checkpoint failed"))).toBe(true);
    expect(walCheckpointFn).toHaveBeenCalledTimes(2);
  });
});
