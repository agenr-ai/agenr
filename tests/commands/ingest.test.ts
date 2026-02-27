import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as clack from "@clack/prompts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runIngestCommand } from "../../src/commands/ingest.js";
import { runWatchCommand } from "../../src/commands/watch.js";
import { initDb } from "../../src/db/client.js";
import { hashText } from "../../src/db/store.js";
import { storeEntries } from "../../src/db/store.js";
import { expandInputFiles } from "../../src/parser.js";
import type { IngestCommandDeps } from "../../src/commands/ingest.js";
import type { KnowledgeEntry, LlmClient, ParsedTranscript } from "../../src/types.js";
import { WriteQueue, type BatchWriteResult, type WriteQueueOptions } from "../../src/ingest/write-queue.js";
import { createEmptyWatchState, loadWatchState, saveWatchState, updateFileState } from "../../src/watch/state.js";
import { readFileFromOffset } from "../../src/watch/watcher.js";
import { isShutdownRequested, requestShutdown, resetShutdownForTests } from "../../src/shutdown.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-ingest-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeEntry(content: string): KnowledgeEntry {
  return {
    type: "fact",
    subject: "Jim",
    content,
    importance: 8,
    expiry: "temporary",
    tags: ["ingest"],
    source: {
      file: "source.txt",
      context: "test",
    },
  };
}

function makeDistinctEntries(): KnowledgeEntry[] {
  return [
    makeEntry("vec-base one"),
    { ...makeEntry("vec-low two"), subject: "Pam" },
    { ...makeEntry("vec-mid three"), subject: "Dwight" },
  ];
}

function makeParsed(filePath: string): ParsedTranscript {
  return {
    file: filePath,
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
  };
}

function makeParsedWithMessages(filePath: string): ParsedTranscript {
  return {
    ...makeParsed(filePath),
    messages: [
      {
        index: 0,
        role: "user",
        text: "message one",
        timestamp: "2026-02-21T00:00:00.000Z",
      },
      {
        index: 1,
        role: "assistant",
        text: "message two",
        timestamp: "2026-02-21T00:01:00.000Z",
      },
    ],
  };
}

function fakeLlmClient(): LlmClient {
  return {
    auth: "openai-api-key",
    resolvedModel: {
      provider: "openai",
      modelId: "gpt-4o",
      model: {} as any,
    },
    credentials: {
      apiKey: "test-key",
      source: "test",
    },
  };
}

function to1024(head: number[]): number[] {
  return [...head, ...Array.from({ length: 1021 }, () => 0)];
}

function vectorForText(text: string): number[] {
  if (text.includes("vec-base")) return to1024([1, 0, 0]);
  if (text.includes("vec-mid")) return to1024([0.94, 0.34, 0]);
  if (text.includes("vec-85")) return to1024([0.85, Math.sqrt(1 - 0.85 ** 2), 0]);
  if (text.includes("vec-low")) return to1024([0.7, 0.71, 0]);
  return to1024([0, 1, 0]);
}

async function mockEmbed(texts: string[]): Promise<number[][]> {
  return texts.map((text) => vectorForText(text));
}

function makeStoreEntriesFn(): IngestCommandDeps["storeEntriesFn"] {
  return async (db, entries, apiKey, options) =>
    storeEntries(db, entries, apiKey, {
      ...options,
      skipLlmDedup: true,
      embedFn: async (texts: string[]) => mockEmbed(texts),
    });
}

function makeDeps(overrides?: Partial<IngestCommandDeps> & { db?: { execute: ReturnType<typeof vi.fn> } }): IngestCommandDeps {
  const db = overrides?.db ?? { execute: vi.fn(async () => ({ rows: [] })) };
  return {
    readConfigFn: overrides?.readConfigFn ?? vi.fn(() => ({ db: { path: ":memory:" } })),
    resolveEmbeddingApiKeyFn: overrides?.resolveEmbeddingApiKeyFn ?? vi.fn(() => "sk-test"),
    expandInputFilesFn: overrides?.expandInputFilesFn ?? (async (inputs: string[]) => inputs),
    parseTranscriptFileFn: overrides?.parseTranscriptFileFn ?? (async (filePath: string) => makeParsed(filePath)),
    createLlmClientFn:
      overrides?.createLlmClientFn ??
      (vi.fn(() => ({ resolvedModel: { provider: "openai", modelId: "gpt-4o" }, credentials: { apiKey: "x" } }) as any) as IngestCommandDeps["createLlmClientFn"]),
    extractKnowledgeFromChunksFn:
      overrides?.extractKnowledgeFromChunksFn ??
      (vi.fn(async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
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
      }) as IngestCommandDeps["extractKnowledgeFromChunksFn"]),
    deduplicateEntriesFn: overrides?.deduplicateEntriesFn ?? (vi.fn((entries: KnowledgeEntry[]) => entries.slice(0, 1))),
    getDbFn: overrides?.getDbFn ?? (vi.fn(() => db as any) as IngestCommandDeps["getDbFn"]),
    initDbFn: overrides?.initDbFn ?? vi.fn(async () => undefined),
    closeDbFn: overrides?.closeDbFn ?? vi.fn(() => undefined),
    storeEntriesFn:
      overrides?.storeEntriesFn ??
      (vi.fn(async (_db, entries: KnowledgeEntry[]) => ({
        added: entries.length,
        updated: 0,
        skipped: 0,
        superseded: 0,
        llm_dedup_calls: 0,
        relations_created: 0,
        total_entries: entries.length,
        duration_ms: 5,
      })) as IngestCommandDeps["storeEntriesFn"]),
    hashTextFn: overrides?.hashTextFn ?? hashText,
    loadWatchStateFn: overrides?.loadWatchStateFn ?? (vi.fn(async () => ({ version: 1 as const, files: {} }))),
    saveWatchStateFn: overrides?.saveWatchStateFn ?? vi.fn(async () => undefined),
    isWatcherRunningFn: overrides?.isWatcherRunningFn ?? (vi.fn(async () => false) as IngestCommandDeps["isWatcherRunningFn"]),
    readWatcherPidFn: overrides?.readWatcherPidFn ?? vi.fn(async () => null),
    resolveWatcherPidPathFn: overrides?.resolveWatcherPidPathFn ?? vi.fn(() => "/tmp/agenr-test/watcher.pid"),
    nowFn: overrides?.nowFn ?? (() => new Date("2026-02-15T00:00:00.000Z")),
    sleepFn: overrides?.sleepFn ?? (vi.fn(async () => undefined) as IngestCommandDeps["sleepFn"]),
    shouldShutdownFn: overrides?.shouldShutdownFn ?? (vi.fn(() => false) as IngestCommandDeps["shouldShutdownFn"]),
    createWriteQueueFn: overrides?.createWriteQueueFn ?? ((opts) => new WriteQueue(opts)),
    embedFn:
      overrides?.embedFn ??
      (vi.fn(async (texts: string[], _apiKey: string) => mockEmbed(texts)) as IngestCommandDeps["embedFn"]),
  };
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
  resetShutdownForTests();
  vi.restoreAllMocks();
});

describe("ingest command", () => {
  it("wires CLI options into runIngestCommand", async () => {
    const { createProgram } = await import("../../src/cli-main.js");
    const program = createProgram();
    const ingestCommand = program.commands.find((command) => command.name() === "ingest");
    const runIngestCommandMock = vi.fn(async (..._args: unknown[]) => undefined);
    ingestCommand?.action(runIngestCommandMock as any);

    await program.parseAsync([
      "node",
      "agenr",
      "ingest",
      "/tmp/one",
      "/tmp/two",
      "--glob",
      "**/*.md",
      "--db",
      "/tmp/db.sqlite",
      "--model",
      "gpt-4o",
      "--provider",
      "openai",
      "--verbose",
      "--dry-run",
      "--json",
      "--concurrency",
      "3",
      "--workers",
      "7",
      "--queue-high-watermark",
      "3000",
      "--queue-backpressure-timeout-ms",
      "240000",
      "--log-dir",
      "/tmp/ingest-logs",
      "--log-all",
      "--sample-rate",
      "9",
      "--skip-ingested",
      "--bulk",
      "--no-retry",
      "--max-retries",
      "5",
      "--force",
      "--whole-file",
    ]);

    expect(runIngestCommandMock).toHaveBeenCalledTimes(1);
    const firstCall = (runIngestCommandMock.mock.calls as unknown[][])[0] as [string[], Record<string, unknown>] | undefined;
    expect(firstCall?.[0]).toEqual(["/tmp/one", "/tmp/two"]);
    expect(firstCall?.[1]).toMatchObject({
      glob: "**/*.md",
      db: "/tmp/db.sqlite",
      model: "gpt-4o",
      provider: "openai",
      verbose: true,
      dryRun: true,
      json: true,
      concurrency: 3,
      workers: 7,
      queueHighWatermark: 3000,
      queueBackpressureTimeoutMs: 240000,
      logDir: "/tmp/ingest-logs",
      logAll: true,
      sampleRate: 9,
      skipIngested: true,
      bulk: true,
      retry: false,
      maxRetries: 5,
      force: true,
      wholeFile: true,
    });
  });

  it("exits with code 1 when --whole-file and --chunk are used together", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runIngestCommand(
      ["/tmp/does-not-matter"],
      { wholeFile: true, chunk: true },
      makeDeps(),
    );

    expect(result.exitCode).toBe(1);
    expect(result.filesProcessed).toBe(0);
    expect(result.filesFailed).toBe(0);
    expect(result.filesSkipped).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith("Error: Cannot use --whole-file and --chunk together");
  });

  it("processes files with --workers and wires createWriteQueueFn options", async () => {
    const dir = await makeTempDir();
    const files = await Promise.all(
      Array.from({ length: 6 }, async (_, index) => {
        const filePath = path.join(dir, `f-${index}.txt`);
        await fs.writeFile(filePath, `content-${index}`, "utf8");
        return filePath;
      }),
    );

    const createWriteQueueFn = vi.fn((opts: WriteQueueOptions) => new WriteQueue(opts));
    const deps = makeDeps({
      expandInputFilesFn: vi.fn(async () => files),
      createWriteQueueFn: createWriteQueueFn as IngestCommandDeps["createWriteQueueFn"],
    });

    const result = await runIngestCommand(
      [dir],
      { workers: 3, dryRun: true, queueHighWatermark: 777, queueBackpressureTimeoutMs: 4567 },
      deps,
    );

    expect(result.exitCode).toBe(0);
    expect(result.filesProcessed).toBe(6);
    expect(createWriteQueueFn).toHaveBeenCalledTimes(1);
    expect(createWriteQueueFn).toHaveBeenCalledWith(
      expect.objectContaining({
        db: expect.anything(),
        storeEntriesFn: deps.storeEntriesFn,
        apiKey: "sk-test",
        llmClient: expect.anything(),
        dbPath: ":memory:",
        batchSize: 40,
        highWatermark: 777,
        backpressureTimeoutMs: 4567,
        retryOnFailure: true,
        isShutdownRequested: deps.shouldShutdownFn,
      }),
    );
  });

  it("caps file workers at the number of files", async () => {
    const dir = await makeTempDir();
    const files = await Promise.all(
      Array.from({ length: 3 }, async (_, i) => {
        const filePath = path.join(dir, `f-${i}.txt`);
        await fs.writeFile(filePath, `content-${i}`, "utf8");
        return filePath;
      }),
    );

    const createWriteQueueFn = vi.fn((opts: WriteQueueOptions) => new WriteQueue(opts));
    const result = await runIngestCommand(
      [dir],
      { workers: 20, dryRun: true },
      makeDeps({
        expandInputFilesFn: vi.fn(async () => files),
        createWriteQueueFn: createWriteQueueFn as IngestCommandDeps["createWriteQueueFn"],
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.filesProcessed).toBe(3);
  });

  it("uses injected createWriteQueueFn and calls push/drain/destroy", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "a.txt");
    await fs.writeFile(filePath, "hello", "utf8");

    const pushMock = vi.fn(
      async (entries: KnowledgeEntry[]): Promise<BatchWriteResult> => ({
        added: entries.length,
        updated: 0,
        skipped: 0,
        superseded: 0,
        llm_dedup_calls: 0,
      }),
    );
    const cancelMock = vi.fn(async () => undefined);
    const runExclusiveMock = vi.fn(async <T>(fn: () => Promise<T>) => await fn());
    const drainMock = vi.fn(async () => undefined);
    const destroyMock = vi.fn(() => undefined);

    const queueMock = {
      pendingCount: 0,
      push: pushMock,
      cancel: cancelMock,
      runExclusive: runExclusiveMock,
      drain: drainMock,
      destroy: destroyMock,
    } as unknown as WriteQueue;

    const createWriteQueueFn = vi.fn(() => queueMock);
    const deps = makeDeps({
      expandInputFilesFn: vi.fn(async () => [filePath]),
      createWriteQueueFn: createWriteQueueFn as IngestCommandDeps["createWriteQueueFn"],
    });

    const result = await runIngestCommand([filePath], {}, deps);

    expect(result.exitCode).toBe(0);
    expect(createWriteQueueFn).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    const firstPushCall = pushMock.mock.calls[0] as unknown[] | undefined;
    expect(firstPushCall?.[0]).toHaveLength(1);
    expect(firstPushCall?.[1]).toBe(filePath);
    expect(firstPushCall?.[2]).toEqual(expect.any(String));
    expect(drainMock).toHaveBeenCalledTimes(1);
    expect(destroyMock).toHaveBeenCalledTimes(1);
    expect(runExclusiveMock).toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("calls queue.cancel and routes cleanup through runExclusive on write failure", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "a.txt");
    await fs.writeFile(filePath, "hello", "utf8");

    const writeError = new Error("write failed");
    const pushMock = vi.fn().mockRejectedValue(writeError);
    const cancelMock = vi.fn(async () => undefined);
    const runExclusiveMock = vi.fn(async <T>(fn: () => Promise<T>) => await fn());
    const drainMock = vi.fn(async () => undefined);
    const destroyMock = vi.fn(() => undefined);

    const queueMock = {
      pendingCount: 0,
      push: pushMock,
      cancel: cancelMock,
      runExclusive: runExclusiveMock,
      drain: drainMock,
      destroy: destroyMock,
    } as unknown as WriteQueue;

    const result = await runIngestCommand(
      [filePath],
      {},
      makeDeps({
        expandInputFilesFn: vi.fn(async () => [filePath]),
        createWriteQueueFn: vi.fn(() => queueMock) as IngestCommandDeps["createWriteQueueFn"],
      }),
    );

    expect(result.exitCode).toBe(2);
    expect(result.filesFailed).toBe(1);
    expect(cancelMock).toHaveBeenCalledWith(filePath);
    expect(runExclusiveMock).toHaveBeenCalled();
  });

  it("does not call queue.push during dry-run", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "a.txt");
    await fs.writeFile(filePath, "hello", "utf8");

    const pushMock = vi.fn(
      async (_entries: KnowledgeEntry[]): Promise<BatchWriteResult> => ({
        added: 0,
        updated: 0,
        skipped: 0,
        superseded: 0,
        llm_dedup_calls: 0,
      }),
    );
    const queueMock = {
      pendingCount: 0,
      push: pushMock,
      cancel: vi.fn(async () => undefined),
      runExclusive: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
      drain: vi.fn(async () => undefined),
      destroy: vi.fn(() => undefined),
    } as unknown as WriteQueue;
    const createWriteQueueFn = vi.fn(() => queueMock);

    const result = await runIngestCommand(
      [filePath],
      { dryRun: true },
      makeDeps({
        expandInputFilesFn: vi.fn(async () => [filePath]),
        createWriteQueueFn: createWriteQueueFn as IngestCommandDeps["createWriteQueueFn"],
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("rejects invalid --workers values", async () => {
    await expect(runIngestCommand(["/tmp/does-not-matter"], { workers: 0 }, makeDeps())).rejects.toThrow(
      "--workers must be a positive number.",
    );
    await expect(runIngestCommand(["/tmp/does-not-matter"], { workers: -1 }, makeDeps())).rejects.toThrow(
      "--workers must be a positive number.",
    );
  });

  it("blocks ingest when watcher is running", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "a.txt");
    await fs.writeFile(filePath, "hello", "utf8");

    const isWatcherRunningFn = vi.fn(async () => true) as IngestCommandDeps["isWatcherRunningFn"];
    const expandInputFilesFn = vi.fn(async () => [filePath]);
    const errorSpy = vi.spyOn(clack.log, "error").mockImplementation(() => undefined);

    const result = await runIngestCommand(
      [filePath],
      { force: true },
      makeDeps({
        isWatcherRunningFn,
        expandInputFilesFn,
      }),
    );

    expect(isWatcherRunningFn).toHaveBeenCalledTimes(1);
    expect(expandInputFilesFn).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message] = (errorSpy.mock.calls[0] ?? []) as [string | undefined];
    const loggedMessage = message ?? "";
    expect(loggedMessage).toContain("watcher is running");
    expect(loggedMessage).toContain("PID file:");
    expect(loggedMessage).toContain("To stop:");
    expect(result.exitCode).toBe(1);
    expect(result.filesProcessed).toBe(0);
    expect(result.filesSkipped).toBe(0);
    expect(result.filesFailed).toBe(0);
    expect(result.totalEntriesExtracted).toBe(0);
    expect(result.totalEntriesStored).toBe(0);
    expect(result.dedupStats.entries_added).toBe(0);
  });

  it("proceeds when watcher is not running", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "a.txt");
    await fs.writeFile(filePath, "hello", "utf8");

    const isWatcherRunningFn = vi.fn(async () => false) as IngestCommandDeps["isWatcherRunningFn"];
    const deps = makeDeps({
      isWatcherRunningFn,
      expandInputFilesFn: vi.fn(async () => [filePath]),
    });

    const result = await runIngestCommand([filePath], {}, deps);

    expect(isWatcherRunningFn).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
    expect(result.filesProcessed).toBe(1);
    expect(result.filesFailed).toBe(0);
  });

  it("processes a directory with mixed file types", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "a.jsonl"), '{"role":"user","content":"x"}\n', "utf8");
    await fs.writeFile(path.join(dir, "b.md"), "# note\nhello\n", "utf8");
    await fs.writeFile(path.join(dir, "c.txt"), "plain text\n", "utf8");

    const expandInputFilesFn = vi.fn(async (inputs: string[]) => {
      if (inputs[0]?.endsWith("**/*.{jsonl,md,txt}")) {
        return [path.join(dir, "a.jsonl"), path.join(dir, "b.md"), path.join(dir, "c.txt")];
      }
      return inputs;
    });
    const deps = makeDeps({ expandInputFilesFn });

    const result = await runIngestCommand([dir], {}, deps);

    expect(result.exitCode).toBe(0);
    expect(result.filesProcessed).toBe(3);
    expect(result.filesSkipped).toBe(0);
    expect(result.filesFailed).toBe(0);
    expect(result.totalEntriesExtracted).toBe(6);
    expect(result.totalEntriesStored).toBe(3);
  });

  it("tags stored entries with --platform when provided", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "a.txt");
    await fs.writeFile(filePath, "plain text\n", "utf8");

    const storeEntriesFn = vi.fn(async (_db: unknown, entries: KnowledgeEntry[]) => ({
      added: entries.length,
      updated: 0,
      skipped: 0,
      superseded: 0,
      llm_dedup_calls: 0,
      relations_created: 0,
      total_entries: entries.length,
      duration_ms: 1,
    }));

    const deps = makeDeps({
      storeEntriesFn: storeEntriesFn as any,
      deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
      getDbFn: vi.fn(() => ({ execute: vi.fn(async () => ({ rows: [] })) }) as any),
    });

    const result = await runIngestCommand([filePath], { platform: "codex", concurrency: 1 }, deps);
    expect(result.exitCode).toBe(0);

    const call = (storeEntriesFn.mock.calls as unknown[][])[0] as [unknown, KnowledgeEntry[]] | undefined;
    const stored = call?.[1] ?? [];
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((entry) => entry.platform === "codex")).toBe(true);
  });

  it("skips already-ingested files by checking ingest_log", async () => {
    const dir = await makeTempDir();
    const fileA = path.join(dir, "a.md");
    const fileB = path.join(dir, "b.md");
    const fileAContent = "alpha";
    await fs.writeFile(fileA, fileAContent, "utf8");
    await fs.writeFile(fileB, "beta", "utf8");

    const dbExecute = vi.fn(async (query: { sql?: string; args?: unknown[] }) => {
      const sql = query?.sql ?? "";
      if (sql.includes("FROM ingest_log")) {
        const args = query.args ?? [];
        if (args[0] === fileA && args[1] === hashText(fileAContent)) {
          return { rows: [{ id: "already" }] };
        }
      }
      return { rows: [] };
    });
    const deps = makeDeps({
      db: { execute: dbExecute },
      expandInputFilesFn: vi.fn(async () => [fileA, fileB]),
    });

    const result = await runIngestCommand([dir], {}, deps);

    expect(result.filesProcessed).toBe(1);
    expect(result.filesSkipped).toBe(1);
    expect(result.filesFailed).toBe(0);
    expect(result.results.find((item) => item.file === fileA)?.skipped).toBe(true);
  });

  it("stops scheduling new files after shutdown is requested (finishes current file)", async () => {
    const dir = await makeTempDir();
    const fileA = path.join(dir, "a.md");
    const fileB = path.join(dir, "b.md");
    await fs.writeFile(fileA, "alpha", "utf8");
    await fs.writeFile(fileB, "beta", "utf8");

    const dbExecute = vi.fn(async () => ({ rows: [] }));
    let storeCalls = 0;
    const deps = makeDeps({
      db: { execute: dbExecute },
      expandInputFilesFn: vi.fn(async (inputs: string[]) => {
        if (inputs[0]?.includes("**/*.{jsonl,md,txt}")) {
          return [fileA, fileB];
        }
        return inputs;
      }),
      storeEntriesFn: vi.fn(async (_db: Client, entries: KnowledgeEntry[]) => {
        storeCalls += 1;
        const result = {
          added: entries.length,
          updated: 0,
          skipped: 0,
          superseded: 0,
          llm_dedup_calls: 0,
          relations_created: 0,
          total_entries: entries.length,
          duration_ms: 5,
        };
        if (storeCalls === 1) {
          requestShutdown();
          expect(isShutdownRequested()).toBe(true);
        }
        return result;
      }) as any,
      shouldShutdownFn: isShutdownRequested,
    });

    const result = await runIngestCommand([dir], { concurrency: 1, workers: 1 }, deps);

    expect(result.exitCode).toBe(130);
    expect(result.filesProcessed).toBe(1);
    expect(result.filesFailed).toBe(0);
    expect(result.filesSkipped).toBe(0);

    type ExecuteStmt = { sql: string; args?: unknown[] };
    type ExecuteCall = [ExecuteStmt, ...unknown[]];
    const isIngestLogInsert = (call: unknown[]): call is ExecuteCall => {
      const first = call[0];
      if (typeof first !== "object" || first === null) {
        return false;
      }
      const statement = first as { sql?: unknown };
      return typeof statement.sql === "string" && statement.sql.includes("INTO ingest_log");
    };

    const ingestLogInserts = dbExecute.mock.calls.filter(isIngestLogInsert);
    expect(ingestLogInserts).toHaveLength(1);
    interface IngestResultRow {
      file: string;
      skipped?: boolean;
      error?: string;
    }
    const isStoredResult = (item: unknown): item is IngestResultRow => {
      if (typeof item !== "object" || item === null) {
        return false;
      }
      const row = item as { file?: unknown; skipped?: unknown; error?: unknown };
      return typeof row.file === "string" && !row.skipped && !row.error;
    };
    const storedFiles = result.results.filter(isStoredResult).map((item) => item.file);
    expect(storedFiles).toHaveLength(1);
    const firstIngestLogInsert = ingestLogInserts[0];
    const firstInsertArgs = firstIngestLogInsert?.[0].args;
    const insertedFile = Array.isArray(firstInsertArgs) ? firstInsertArgs[1] : undefined;
    expect(insertedFile).toBe(storedFiles[0]);
  });

  it("re-processes already-ingested files with --force", async () => {
    const dir = await makeTempDir();
    const fileA = path.join(dir, "a.md");
    await fs.writeFile(fileA, "alpha", "utf8");

    const dbExecute = vi.fn(async () => ({ rows: [{ id: "already" }] }));
    const parseTranscriptFileFn = vi.fn(async (filePath: string) => makeParsed(filePath));
    const deps = makeDeps({
      db: { execute: dbExecute },
      expandInputFilesFn: vi.fn(async () => [fileA]),
      parseTranscriptFileFn,
    });

    const result = await runIngestCommand([dir], { force: true }, deps);

    expect(result.filesProcessed).toBe(1);
    expect(result.filesSkipped).toBe(0);
    expect(parseTranscriptFileFn).toHaveBeenCalledTimes(1);
  });

  it("deletes prior file-owned rows before storing when --force is enabled", async () => {
    const dir = await makeTempDir();
    const fileA = path.join(dir, "a.md");
    await fs.writeFile(fileA, "alpha", "utf8");

    const dbExecute = vi.fn(async (query: { sql?: string }) => {
      const sql = query?.sql ?? "";
      if (sql.includes("COUNT(*) AS count")) {
        return { rows: [{ count: 1 }] };
      }
      return { rows: [] };
    });
    const storeEntriesFn = vi.fn(async () => ({
      added: 1,
      updated: 0,
      skipped: 0,
      superseded: 0,
      llm_dedup_calls: 0,
      relations_created: 0,
      total_entries: 1,
      duration_ms: 1,
    }));

    await runIngestCommand(
      [dir],
      { force: true },
      makeDeps({
        db: { execute: dbExecute },
        expandInputFilesFn: vi.fn(async () => [fileA]),
        storeEntriesFn: storeEntriesFn as IngestCommandDeps["storeEntriesFn"],
      }),
    );

    expect(dbExecute).toHaveBeenCalledWith(
      expect.objectContaining({ sql: expect.stringContaining("DELETE FROM entry_sources") }),
    );
    expect(dbExecute).toHaveBeenCalledWith(
      expect.objectContaining({ sql: expect.stringContaining("DELETE FROM ingest_log") }),
    );
    expect(dbExecute).toHaveBeenCalledWith(
      expect.objectContaining({ sql: expect.stringContaining("DELETE FROM entries WHERE source_file = ?") }),
    );

    const optionsArg = (storeEntriesFn.mock.calls as unknown[][])[0]?.[3] as Record<string, unknown> | undefined;
    expect(optionsArg?.onlineDedup).toBe(true);
    expect(optionsArg?.skipLlmDedup).toBe(false);
    expect(optionsArg?.force).toBeUndefined();
  });

  it("supports --dry-run by extracting without storing", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "a.txt");
    await fs.writeFile(filePath, "hello", "utf8");

    const storeEntriesFn = vi.fn(async () => {
      throw new Error("store should not be called");
    });
    const deps = makeDeps({
      expandInputFilesFn: vi.fn(async () => [filePath]),
      storeEntriesFn: storeEntriesFn as IngestCommandDeps["storeEntriesFn"],
    });

    const result = await runIngestCommand([dir], { dryRun: true }, deps);

    expect(result.exitCode).toBe(0);
    expect(result.totalEntriesExtracted).toBeGreaterThan(0);
    expect(result.totalEntriesStored).toBe(0);
    expect(storeEntriesFn).not.toHaveBeenCalled();
  });

  it("creates co-recall edges between entries from the same session file", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "edges.jsonl");
    await fs.writeFile(filePath, '{"role":"user","content":"hello"}\n', "utf8");

    const db = createClient({ url: ":memory:" });
    const storeEntriesFn = makeStoreEntriesFn();
    const extractKnowledgeFromChunksFn = vi.fn(
      async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
        await params.onChunkComplete?.({
          chunkIndex: 0,
          totalChunks: 1,
          entries: makeDistinctEntries(),
          warnings: [],
        });
        return {
          entries: [],
          successfulChunks: 1,
          failedChunks: 0,
          warnings: [],
        };
      },
    );

    try {
      const result = await runIngestCommand(
        [filePath],
        {},
        makeDeps({
          getDbFn: vi.fn(() => db) as IngestCommandDeps["getDbFn"],
          initDbFn: vi.fn(async () => initDb(db)),
          closeDbFn: vi.fn(() => undefined),
          expandInputFilesFn: vi.fn(async () => [filePath]),
          extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
          deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
          resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
          storeEntriesFn,
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.filesProcessed).toBe(1);
      expect(result.filesFailed).toBe(0);

      const edgeRows = await db.execute({ sql: "SELECT COUNT(*) AS cnt FROM co_recall_edges" });
      const edgeCount = Number(edgeRows.rows[0]?.cnt);
      expect(edgeCount).toBeGreaterThan(0);

      const sameSourceEdges = await db.execute({
        sql: `
          SELECT COUNT(*) AS cnt
          FROM co_recall_edges edge
          JOIN entries entry_a ON entry_a.id = edge.entry_a
          JOIN entries entry_b ON entry_b.id = edge.entry_b
          WHERE entry_a.source_file = ? AND entry_b.source_file = ?
        `,
        args: [filePath, filePath],
      });
      expect(Number(sameSourceEdges.rows[0]?.cnt)).toBe(edgeCount);
    } finally {
      db.close();
    }
  });

  it("does not create edges for single-entry files", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "single.jsonl");
    await fs.writeFile(filePath, '{"role":"user","content":"hello"}\n', "utf8");

    const db = createClient({ url: ":memory:" });
    const storeEntriesFn = makeStoreEntriesFn();
    const extractKnowledgeFromChunksFn = vi.fn(
      async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
        await params.onChunkComplete?.({
          chunkIndex: 0,
          totalChunks: 1,
          entries: [makeDistinctEntries()[0]!],
          warnings: [],
        });
        return {
          entries: [],
          successfulChunks: 1,
          failedChunks: 0,
          warnings: [],
        };
      },
    );

    try {
      const result = await runIngestCommand(
        [filePath],
        {},
        makeDeps({
          getDbFn: vi.fn(() => db) as IngestCommandDeps["getDbFn"],
          initDbFn: vi.fn(async () => initDb(db)),
          closeDbFn: vi.fn(() => undefined),
          expandInputFilesFn: vi.fn(async () => [filePath]),
          extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
          deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
          resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
          storeEntriesFn,
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.filesProcessed).toBe(1);
      const edgeRows = await db.execute({ sql: "SELECT COUNT(*) AS cnt FROM co_recall_edges" });
      expect(Number(edgeRows.rows[0]?.cnt)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("does not create edges in dry-run mode", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "dry-run.jsonl");
    await fs.writeFile(filePath, '{"role":"user","content":"hello"}\n', "utf8");

    const db = createClient({ url: ":memory:" });
    const extractKnowledgeFromChunksFn = vi.fn(
      async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
        await params.onChunkComplete?.({
          chunkIndex: 0,
          totalChunks: 1,
          entries: makeDistinctEntries(),
          warnings: [],
        });
        return {
          entries: [],
          successfulChunks: 1,
          failedChunks: 0,
          warnings: [],
        };
      },
    );

    try {
      const result = await runIngestCommand(
        [filePath],
        { dryRun: true },
        makeDeps({
          getDbFn: vi.fn(() => db) as IngestCommandDeps["getDbFn"],
          initDbFn: vi.fn(async () => initDb(db)),
          closeDbFn: vi.fn(() => undefined),
          expandInputFilesFn: vi.fn(async () => [filePath]),
          extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
          deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.filesProcessed).toBe(1);
      const edgeRows = await db.execute({ sql: "SELECT COUNT(*) AS cnt FROM co_recall_edges" });
      expect(Number(edgeRows.rows[0]?.cnt)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("continues ingest when co-recall edge creation fails", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "edge-failure.txt");
    await fs.writeFile(filePath, "hello", "utf8");

    const pushMock = vi.fn(
      async (entries: KnowledgeEntry[]): Promise<BatchWriteResult> => ({
        added: entries.length,
        updated: 0,
        skipped: 0,
        superseded: 0,
        llm_dedup_calls: 0,
      }),
    );
    const cancelMock = vi.fn(async () => undefined);
    let runExclusiveCalls = 0;
    const runExclusiveMock = vi.fn(async <T>(fn: () => Promise<T>) => {
      runExclusiveCalls += 1;
      if (runExclusiveCalls === 2) {
        throw new Error("co-recall edge write failed");
      }
      return await fn();
    });
    const drainMock = vi.fn(async () => undefined);
    const destroyMock = vi.fn(() => undefined);
    const queueMock = {
      pendingCount: 0,
      push: pushMock,
      cancel: cancelMock,
      runExclusive: runExclusiveMock,
      drain: drainMock,
      destroy: destroyMock,
    } as unknown as WriteQueue;

    const extractKnowledgeFromChunksFn = vi.fn(
      async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
        await params.onChunkComplete?.({
          chunkIndex: 0,
          totalChunks: 1,
          entries: [makeDistinctEntries()[0]!, makeDistinctEntries()[1]!],
          warnings: [],
        });
        return {
          entries: [],
          successfulChunks: 1,
          failedChunks: 0,
          warnings: [],
        };
      },
    );

    const result = await runIngestCommand(
      [filePath],
      {},
      makeDeps({
        expandInputFilesFn: vi.fn(async () => [filePath]),
        createWriteQueueFn: vi.fn(() => queueMock) as IngestCommandDeps["createWriteQueueFn"],
        extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
        deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.filesProcessed).toBe(1);
    expect(result.filesFailed).toBe(0);
    expect(runExclusiveMock).toHaveBeenCalledTimes(2);
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("backfills co-recall edges for already-ingested files on re-ingest", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "backfill.jsonl");
    await fs.writeFile(filePath, '{"role":"user","content":"hello"}\n', "utf8");

    const db = createClient({ url: ":memory:" });
    const storeEntriesFn = makeStoreEntriesFn();
    const extractKnowledgeFromChunksFn = vi.fn(
      async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
        await params.onChunkComplete?.({
          chunkIndex: 0,
          totalChunks: 1,
          entries: makeDistinctEntries(),
          warnings: [],
        });
        return {
          entries: [],
          successfulChunks: 1,
          failedChunks: 0,
          warnings: [],
        };
      },
    );
    const baseDeps = {
      getDbFn: vi.fn(() => db) as IngestCommandDeps["getDbFn"],
      initDbFn: vi.fn(async () => initDb(db)),
      closeDbFn: vi.fn(() => undefined),
      expandInputFilesFn: vi.fn(async () => [filePath]),
      extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
      deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
      resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
      storeEntriesFn,
    };

    try {
      // First ingest - creates entries and edges.
      const result1 = await runIngestCommand([filePath], {}, makeDeps(baseDeps));
      expect(result1.exitCode).toBe(0);
      expect(result1.filesProcessed).toBe(1);

      // Delete all edges to simulate pre-edge-feature data.
      await db.execute("DELETE FROM co_recall_edges");
      const noEdges = await db.execute({ sql: "SELECT COUNT(*) AS cnt FROM co_recall_edges" });
      expect(Number(noEdges.rows[0]?.cnt)).toBe(0);

      // Second ingest - file is skipped but edges should be backfilled.
      const result2 = await runIngestCommand([filePath], {}, makeDeps(baseDeps));
      expect(result2.exitCode).toBe(0);

      const edgeRows = await db.execute({ sql: "SELECT COUNT(*) AS cnt FROM co_recall_edges" });
      expect(Number(edgeRows.rows[0]?.cnt)).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });



  it("resolves embedding API key even when --no-pre-fetch is set", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "a.txt");
    await fs.writeFile(filePath, "hello", "utf8");

    const resolveEmbeddingApiKeyFn = vi.fn(() => "sk-test");
    const extractKnowledgeFromChunksFn = vi.fn(
      async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
        await params.onChunkComplete?.({
          chunkIndex: 0,
          totalChunks: 1,
          entries: [makeEntry("one")],
          warnings: [],
        });
        return {
          entries: [],
          successfulChunks: 1,
          failedChunks: 0,
          warnings: [],
        };
      },
    );

    await runIngestCommand(
      [dir],
      { dryRun: true, noPreFetch: true },
      makeDeps({
        expandInputFilesFn: vi.fn(async () => [filePath]),
        resolveEmbeddingApiKeyFn: resolveEmbeddingApiKeyFn as IngestCommandDeps["resolveEmbeddingApiKeyFn"],
        extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
      }),
    );

    expect(resolveEmbeddingApiKeyFn).toHaveBeenCalledTimes(1);
    expect(extractKnowledgeFromChunksFn).toHaveBeenCalledTimes(1);
    expect(extractKnowledgeFromChunksFn.mock.calls[0]?.[0]?.noPreFetch).toBe(true);
  });

  it("ingest resolves embedding key eagerly when noPreFetch=false", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "a.txt");
    await fs.writeFile(filePath, "hello", "utf8");

    const resolveEmbeddingApiKeyFn = vi.fn(() => "test-key");
    const extractKnowledgeFromChunksFn = vi.fn(
      async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
        await params.onChunkComplete?.({
          chunkIndex: 0,
          totalChunks: 1,
          entries: [makeEntry("one")],
          warnings: [],
        });
        return {
          entries: [],
          successfulChunks: 1,
          failedChunks: 0,
          warnings: [],
        };
      },
    );

    await runIngestCommand(
      [dir],
      { dryRun: true },
      makeDeps({
        expandInputFilesFn: vi.fn(async () => [filePath]),
        resolveEmbeddingApiKeyFn: resolveEmbeddingApiKeyFn as IngestCommandDeps["resolveEmbeddingApiKeyFn"],
        extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
      }),
    );

    expect(resolveEmbeddingApiKeyFn).toHaveBeenCalledTimes(1);
    expect(extractKnowledgeFromChunksFn).toHaveBeenCalledTimes(1);
    expect(extractKnowledgeFromChunksFn.mock.calls[0]?.[0]?.embeddingApiKey).toBe("test-key");
  });

  it("--whole-file forces whole-file mode and passes parsed messages", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "a.txt");
    await fs.writeFile(filePath, "hello", "utf8");
    const parsed = makeParsedWithMessages(filePath);

    const extractKnowledgeFromChunksFn = vi.fn(
      async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
        await params.onChunkComplete?.({
          chunkIndex: 0,
          totalChunks: 1,
          entries: [makeEntry("one")],
          warnings: [],
          entriesExtracted: 1,
          durationMs: 0,
        });
        return {
          entries: [],
          successfulChunks: 1,
          failedChunks: 0,
          warnings: [],
        };
      },
    );

    await runIngestCommand(
      [dir],
      { dryRun: true, wholeFile: true },
      makeDeps({
        expandInputFilesFn: vi.fn(async () => [filePath]),
        parseTranscriptFileFn: vi.fn(async () => parsed),
        extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
      }),
    );

    expect(extractKnowledgeFromChunksFn).toHaveBeenCalledTimes(1);
    expect(extractKnowledgeFromChunksFn.mock.calls[0]?.[0]?.wholeFile).toBe("force");
    expect(extractKnowledgeFromChunksFn.mock.calls[0]?.[0]?.messages).toEqual(parsed.messages);
  });

  it("--chunk forces chunked mode even when auto could use whole-file", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "a.txt");
    await fs.writeFile(filePath, "hello", "utf8");
    const parsed = makeParsedWithMessages(filePath);

    const extractKnowledgeFromChunksFn = vi.fn(
      async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
        await params.onChunkComplete?.({
          chunkIndex: 0,
          totalChunks: 1,
          entries: [makeEntry("one")],
          warnings: [],
          entriesExtracted: 1,
          durationMs: 0,
        });
        return {
          entries: [],
          successfulChunks: 1,
          failedChunks: 0,
          warnings: [],
        };
      },
    );

    await runIngestCommand(
      [dir],
      { dryRun: true, chunk: true },
      makeDeps({
        expandInputFilesFn: vi.fn(async () => [filePath]),
        parseTranscriptFileFn: vi.fn(async () => parsed),
        extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
      }),
    );

    expect(extractKnowledgeFromChunksFn).toHaveBeenCalledTimes(1);
    expect(extractKnowledgeFromChunksFn.mock.calls[0]?.[0]?.wholeFile).toBe("never");
  });

  it("defaults to wholeFile=auto when no mode flags are provided", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "a.txt");
    await fs.writeFile(filePath, "hello", "utf8");
    const parsed = makeParsedWithMessages(filePath);

    const extractKnowledgeFromChunksFn = vi.fn(
      async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
        await params.onChunkComplete?.({
          chunkIndex: 0,
          totalChunks: 1,
          entries: [makeEntry("one")],
          warnings: [],
          entriesExtracted: 1,
          durationMs: 0,
        });
        return {
          entries: [],
          successfulChunks: 1,
          failedChunks: 0,
          warnings: [],
        };
      },
    );

    await runIngestCommand(
      [dir],
      { dryRun: true },
      makeDeps({
        expandInputFilesFn: vi.fn(async () => [filePath]),
        parseTranscriptFileFn: vi.fn(async () => parsed),
        extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
      }),
    );

    expect(extractKnowledgeFromChunksFn).toHaveBeenCalledTimes(1);
    expect(extractKnowledgeFromChunksFn.mock.calls[0]?.[0]?.wholeFile).toBe("auto");
  });

  it("passes verbose=true to extraction when --verbose is enabled", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "a.txt");
    await fs.writeFile(filePath, "hello", "utf8");

    const extractKnowledgeFromChunksFn = vi.fn(
      async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
        await params.onChunkComplete?.({
          chunkIndex: 0,
          totalChunks: 1,
          entries: [makeEntry("one")],
          warnings: [],
          entriesExtracted: 1,
          durationMs: 0,
        });
        return {
          entries: [],
          successfulChunks: 1,
          failedChunks: 0,
          warnings: [],
        };
      },
    );

    await runIngestCommand(
      [dir],
      { dryRun: true, verbose: true },
      makeDeps({
        expandInputFilesFn: vi.fn(async () => [filePath]),
        extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
      }),
    );

    expect(extractKnowledgeFromChunksFn).toHaveBeenCalledTimes(1);
    expect(extractKnowledgeFromChunksFn.mock.calls[0]?.[0]?.verbose).toBe(true);
  });

  it("does not delete rows during --force --dry-run and reports would-delete summary", async () => {
    const dir = await makeTempDir();
    const fileA = path.join(dir, "a.md");
    await fs.writeFile(fileA, "alpha", "utf8");

    const dbExecute = vi.fn(async (query: { sql?: string }) => {
      const sql = query?.sql ?? "";
      if (sql.includes("COUNT(*) AS count")) {
        return { rows: [{ count: 2 }] };
      }
      if (sql.includes("DELETE FROM")) {
        throw new Error("delete should not run in dry-run");
      }
      return { rows: [] };
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await runIngestCommand(
      [dir],
      { force: true, dryRun: true },
      makeDeps({
        db: { execute: dbExecute },
        expandInputFilesFn: vi.fn(async () => [fileA]),
      }),
    );

    const output = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Force cleanup (dry-run): would delete");
    expect(result.totalEntriesStored).toBe(0);
  });

  it("streams extraction chunks through callback and stores each chunk incrementally", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "a.txt");
    await fs.writeFile(filePath, "hello", "utf8");

    const deduplicateEntriesFn = vi.fn((entries: KnowledgeEntry[]) => entries.slice(0, 1));
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
    const extractKnowledgeFromChunksFn = vi.fn(
      async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
        if (!params.onChunkComplete) {
          throw new Error("expected onChunkComplete callback");
        }

        await params.onChunkComplete({
          chunkIndex: 0,
          totalChunks: 2,
          entries: [makeEntry("one"), makeEntry("one-dup")],
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

    const result = await runIngestCommand(
      [dir],
      { verbose: true },
      makeDeps({
        expandInputFilesFn: vi.fn(async () => [filePath]),
        extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
        deduplicateEntriesFn,
        storeEntriesFn: storeEntriesFn as IngestCommandDeps["storeEntriesFn"],
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.totalEntriesExtracted).toBe(3);
    expect(result.totalEntriesStored).toBe(2);
    expect(deduplicateEntriesFn).toHaveBeenCalledTimes(2);
    expect(storeEntriesFn).toHaveBeenCalledTimes(2);
    expect(storeEntriesFn.mock.calls[0]?.[1]).toHaveLength(1);
    expect(storeEntriesFn.mock.calls[1]?.[1]).toHaveLength(1);
  });

  it("always passes deterministic ingest dedup options to store", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "a.txt");
    await fs.writeFile(filePath, "hello", "utf8");

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

    await runIngestCommand(
      [dir],
      {},
      makeDeps({
        expandInputFilesFn: vi.fn(async () => [filePath]),
        deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries.slice(0, 1)),
        storeEntriesFn: storeEntriesFn as IngestCommandDeps["storeEntriesFn"],
      }),
    );

    expect(storeEntriesFn).toHaveBeenCalledTimes(1);
    const optionsArg = (storeEntriesFn.mock.calls as unknown[][])[0]?.[3] as Record<string, unknown> | undefined;
    expect(optionsArg?.onlineDedup).toBe(true);
    expect(optionsArg?.skipLlmDedup).toBe(false);
    expect(optionsArg?.force).toBeUndefined();
    expect(optionsArg?.llmClient).toBeTruthy();
  });

  it("handles missing files gracefully", async () => {
    const missing = path.join("/tmp", "agenr-ingest-missing-file.txt");
    const deps = makeDeps();

    const result = await runIngestCommand([missing], {}, deps);

    expect(result.exitCode).toBe(2);
    expect(result.filesProcessed).toBe(0);
    expect(result.filesFailed).toBe(1);
    expect(result.results[0]?.error).toContain("no such file");
  });

  it("handles empty directories", async () => {
    const dir = await makeTempDir();
    const deps = makeDeps({
      expandInputFilesFn: vi.fn(async () => []),
    });

    const result = await runIngestCommand([dir], {}, deps);

    expect(result.exitCode).toBe(0);
    expect(result.filesProcessed).toBe(0);
    expect(result.filesSkipped).toBe(0);
    expect(result.filesFailed).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("continues processing after per-file LLM errors", async () => {
    const dir = await makeTempDir();
    const badFile = path.join(dir, "bad.md");
    const goodFile = path.join(dir, "good.md");
    await fs.writeFile(badFile, "bad", "utf8");
    await fs.writeFile(goodFile, "good", "utf8");

    const extractKnowledgeFromChunksFn = vi.fn(
      async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
        if (params.file === badFile) {
          throw new Error("timeout");
        }
        await params.onChunkComplete?.({
          chunkIndex: 0,
          totalChunks: 1,
          entries: [makeEntry("ok")],
          warnings: [],
        });
        return {
          entries: [],
          successfulChunks: 1,
          failedChunks: 0,
          warnings: [],
        };
      },
    );

    const result = await runIngestCommand(
      [dir],
      {},
      makeDeps({
        expandInputFilesFn: vi.fn(async () => [badFile, goodFile]),
        extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
      }),
    );

    expect(result.filesProcessed).toBe(1);
    expect(result.filesFailed).toBe(1);
    expect(result.results.find((item) => item.file === badFile)?.error).toBe("timeout");
  });

  it("treats all-chunks-failed extraction as a file-level failure (no ingest_log entry)", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "all-fail.md");
    await fs.writeFile(filePath, "hello", "utf8");

    const db = createClient({ url: ":memory:" });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const extractKnowledgeFromChunksFn = vi.fn(async () => ({
        entries: [],
        successfulChunks: 0,
        failedChunks: 5,
        warnings: ["rate limited"],
      }));

      const result = await runIngestCommand(
        [filePath],
        {},
        makeDeps({
          getDbFn: vi.fn(() => db) as IngestCommandDeps["getDbFn"],
          initDbFn: vi.fn(async () => initDb(db)),
          closeDbFn: vi.fn(() => undefined),
          expandInputFilesFn: vi.fn(async () => [filePath]),
          extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
          deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
          resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
        }),
      );

      expect(result.exitCode).toBe(2);
      expect(result.filesProcessed).toBe(0);
      expect(result.filesFailed).toBe(1);
      expect(result.results[0]?.error).toContain("All chunks failed");

      const ingestRows = await db.execute({
        sql: "SELECT COUNT(*) AS count FROM ingest_log WHERE file_path = ?",
        args: [path.resolve(filePath)],
      });
      expect(Number(ingestRows.rows[0]?.count)).toBe(0);

      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("All chunks failed");
    } finally {
      db.close();
    }
  });

  it("warns (but succeeds) when a majority of chunks fail", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "mostly-fail.md");
    await fs.writeFile(filePath, "hello", "utf8");

    const db = createClient({ url: ":memory:" });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const extractKnowledgeFromChunksFn = vi.fn(
        async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
          await params.onChunkComplete?.({
            chunkIndex: 0,
            totalChunks: 10,
            entries: [makeEntry("one")],
            warnings: [],
          });
          await params.onChunkComplete?.({
            chunkIndex: 1,
            totalChunks: 10,
            entries: [makeEntry("two")],
            warnings: [],
          });
          return {
            entries: [],
            successfulChunks: 2,
            failedChunks: 8,
            warnings: ["timeout"],
          };
        },
      );

      const result = await runIngestCommand(
        [filePath],
        {},
        makeDeps({
          getDbFn: vi.fn(() => db) as IngestCommandDeps["getDbFn"],
          initDbFn: vi.fn(async () => initDb(db)),
          closeDbFn: vi.fn(() => undefined),
          expandInputFilesFn: vi.fn(async () => [filePath]),
          extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
          deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
          resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
          storeEntriesFn: vi.fn(async (_db: unknown, entries: KnowledgeEntry[]) => ({
            added: entries.length,
            updated: 0,
            skipped: 0,
            superseded: 0,
            llm_dedup_calls: 0,
            relations_created: 0,
            total_entries: entries.length,
            duration_ms: 1,
          })) as IngestCommandDeps["storeEntriesFn"],
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.filesProcessed).toBe(1);
      expect(result.filesFailed).toBe(0);

      const ingestRows = await db.execute({
        sql: "SELECT COUNT(*) AS count FROM ingest_log WHERE file_path = ?",
        args: [path.resolve(filePath)],
      });
      expect(Number(ingestRows.rows[0]?.count)).toBe(1);

      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("warning");
      expect(output).toContain("partial extraction");
      expect(output).toContain("chunks failed");
    } finally {
      db.close();
    }
  });

  it("logs an info note (not a warning) when a minority of chunks fail", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "minor-fail.md");
    await fs.writeFile(filePath, "hello", "utf8");

    const db = createClient({ url: ":memory:" });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const extractKnowledgeFromChunksFn = vi.fn(
        async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
          await params.onChunkComplete?.({
            chunkIndex: 0,
            totalChunks: 10,
            entries: [makeEntry("one")],
            warnings: [],
          });
          return {
            entries: [],
            successfulChunks: 8,
            failedChunks: 2,
            warnings: ["rate limit"],
          };
        },
      );

      const result = await runIngestCommand(
        [filePath],
        {},
        makeDeps({
          getDbFn: vi.fn(() => db) as IngestCommandDeps["getDbFn"],
          initDbFn: vi.fn(async () => initDb(db)),
          closeDbFn: vi.fn(() => undefined),
          expandInputFilesFn: vi.fn(async () => [filePath]),
          extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
          deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
          resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
          storeEntriesFn: vi.fn(async (_db: unknown, entries: KnowledgeEntry[]) => ({
            added: entries.length,
            updated: 0,
            skipped: 0,
            superseded: 0,
            llm_dedup_calls: 0,
            relations_created: 0,
            total_entries: entries.length,
            duration_ms: 1,
          })) as IngestCommandDeps["storeEntriesFn"],
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.filesProcessed).toBe(1);
      expect(result.filesFailed).toBe(0);

      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("partial extraction");
      expect(output).toContain("chunks failed");
      expect(output).not.toContain("warning");
    } finally {
      db.close();
    }
  });

  it("cleans up partial rows and avoids ingest_log for failed embedding files while continuing other files", async () => {
    const dir = await makeTempDir();
    const badFile = path.join(dir, "bad.jsonl");
    const goodFile = path.join(dir, "good.jsonl");
    await fs.writeFile(badFile, '{"role":"user","content":"bad"}\n', "utf8");
    await fs.writeFile(goodFile, '{"role":"user","content":"good"}\n', "utf8");

    const db = createClient({ url: ":memory:" });
    const storeEntriesFn: IngestCommandDeps["storeEntriesFn"] = async (client, entries, apiKey, options) =>
      storeEntries(client, entries, apiKey, {
        ...options, skipLlmDedup: true,
        embedFn: async (texts: string[]) => {
          if (texts.some((text) => text.includes("force-embed-fail"))) {
            throw new Error("OpenAI embeddings request failed (500)");
          }
          return texts.map(() => to1024([1, 0, 0]));
        },
      });

    try {
      const extractKnowledgeFromChunksFn = vi.fn(
        async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
          const entries =
            params.file === badFile
              ? [makeEntry("bad-one"), makeEntry("force-embed-fail")]
              : [makeEntry("good-one")];
          await params.onChunkComplete?.({
            chunkIndex: 0,
            totalChunks: 1,
            entries,
            warnings: [],
          });
          return {
            entries: [],
            successfulChunks: 1,
            failedChunks: 0,
            warnings: [],
          };
        },
      );

      const result = await runIngestCommand(
        [dir],
        { retry: false },
        makeDeps({
          getDbFn: vi.fn(() => db) as IngestCommandDeps["getDbFn"],
          initDbFn: vi.fn(async () => initDb(db)),
          closeDbFn: vi.fn(() => undefined),
          createLlmClientFn: vi.fn(() => fakeLlmClient()) as IngestCommandDeps["createLlmClientFn"],
          expandInputFilesFn: vi.fn(async () => [badFile, goodFile]),
          extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
          deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
          resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
          storeEntriesFn,
        }),
      );

      expect(result.exitCode).toBe(1);
      expect(result.filesProcessed).toBe(1);
      expect(result.filesFailed).toBe(1);
      expect(result.results.find((item) => item.file === badFile)?.error).toContain("OpenAI embeddings request failed (500)");

      const badEntries = await db.execute({
        sql: "SELECT COUNT(*) AS count FROM entries WHERE source_file = ?",
        args: [badFile],
      });
      expect(Number(badEntries.rows[0]?.count)).toBe(0);

      const badLog = await db.execute({
        sql: "SELECT COUNT(*) AS count FROM ingest_log WHERE file_path = ?",
        args: [badFile],
      });
      expect(Number(badLog.rows[0]?.count)).toBe(0);

      const goodLog = await db.execute({
        sql: "SELECT COUNT(*) AS count FROM ingest_log WHERE file_path = ?",
        args: [goodFile],
      });
      expect(Number(goodLog.rows[0]?.count)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("retries a failed file on the next run because failure leaves no ingest_log entry", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "retry.jsonl");
    await fs.writeFile(filePath, '{"role":"user","content":"retry"}\n', "utf8");

    const db = createClient({ url: ":memory:" });
    const storeEntriesFn = vi.fn(async (): ReturnType<IngestCommandDeps["storeEntriesFn"]> => {
      throw new Error("OpenAI embeddings request failed (500)");
    });
    // Fail once, then succeed on the first retry round.
    storeEntriesFn.mockImplementationOnce(async () => {
      throw new Error("OpenAI embeddings request failed (500)");
    });
    storeEntriesFn.mockImplementationOnce(async () => ({
      added: 1,
      updated: 0,
      skipped: 0,
      superseded: 0,
      llm_dedup_calls: 0,
      relations_created: 0,
      total_entries: 1,
      duration_ms: 1,
    }));

    try {
      const result = await runIngestCommand(
        [filePath],
        { maxRetries: "3" },
        makeDeps({
          getDbFn: vi.fn(() => db) as IngestCommandDeps["getDbFn"],
          initDbFn: vi.fn(async () => initDb(db)),
          closeDbFn: vi.fn(() => undefined),
          createLlmClientFn: vi.fn(() => fakeLlmClient()) as IngestCommandDeps["createLlmClientFn"],
          expandInputFilesFn: vi.fn(async () => [filePath]),
          deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
          resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
          storeEntriesFn: storeEntriesFn as IngestCommandDeps["storeEntriesFn"],
          sleepFn: vi.fn(async () => undefined),
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.filesProcessed).toBe(1);
      expect(result.filesFailed).toBe(0);
      expect(storeEntriesFn).toHaveBeenCalledTimes(2);

      const ingestRows = await db.execute({
        sql: "SELECT COUNT(*) AS count FROM ingest_log WHERE file_path = ?",
        args: [filePath],
      });
      expect(Number(ingestRows.rows[0]?.count)).toBe(1);
    } finally {
      db.close();
    }
  });

  it(
    "exhausts max retries for a permanently failing file and returns non-zero",
    async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "always-fail.jsonl");
    await fs.writeFile(filePath, '{"role":"user","content":"retry"}\n', "utf8");

    const db = createClient({ url: ":memory:" });
    const storeEntriesFn = vi.fn(async () => {
      throw new Error("OpenAI embeddings request failed (500)");
    });
    const sleepFn = vi.fn(async (_ms: number) => undefined);

    try {
      const result = await runIngestCommand(
        [filePath],
        { maxRetries: "3" },
        makeDeps({
          getDbFn: vi.fn(() => db) as IngestCommandDeps["getDbFn"],
          initDbFn: vi.fn(async () => initDb(db)),
          closeDbFn: vi.fn(() => undefined),
          createLlmClientFn: vi.fn(() => fakeLlmClient()) as IngestCommandDeps["createLlmClientFn"],
          expandInputFilesFn: vi.fn(async () => [filePath]),
          deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
          resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
          storeEntriesFn: storeEntriesFn as IngestCommandDeps["storeEntriesFn"],
          sleepFn,
        }),
      );

      expect(result.exitCode).toBe(2);
      expect(result.filesProcessed).toBe(0);
      expect(result.filesFailed).toBe(1);
      // 1 initial + 3 retry rounds = 4 outer rounds x 2 inner write attempts
      expect(storeEntriesFn).toHaveBeenCalledTimes(8);
      expect(sleepFn).toHaveBeenCalledTimes(3);
      expect(sleepFn.mock.calls.map((call) => call[0])).toEqual([10_000, 30_000, 60_000]);
    } finally {
      db.close();
    }
    },
    15_000,
  );

  it("--no-retry disables the retry loop", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "no-retry.jsonl");
    await fs.writeFile(filePath, '{"role":"user","content":"retry"}\n', "utf8");

    const db = createClient({ url: ":memory:" });
    const storeEntriesFn = vi.fn(async () => {
      throw new Error("OpenAI embeddings request failed (500)");
    });
    const sleepFn = vi.fn(async (_ms: number) => undefined);

    try {
      const result = await runIngestCommand(
        [filePath],
        { retry: false, maxRetries: "3" },
        makeDeps({
          getDbFn: vi.fn(() => db) as IngestCommandDeps["getDbFn"],
          initDbFn: vi.fn(async () => initDb(db)),
          closeDbFn: vi.fn(() => undefined),
          createLlmClientFn: vi.fn(() => fakeLlmClient()) as IngestCommandDeps["createLlmClientFn"],
          expandInputFilesFn: vi.fn(async () => [filePath]),
          deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
          resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
          storeEntriesFn: storeEntriesFn as IngestCommandDeps["storeEntriesFn"],
          sleepFn,
        }),
      );

      expect(result.exitCode).toBe(2);
      expect(result.filesProcessed).toBe(0);
      expect(result.filesFailed).toBe(1);
      expect(storeEntriesFn).toHaveBeenCalledTimes(1);
      expect(sleepFn).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("applies glob filtering", async () => {
    const dir = await makeTempDir();
    const md = path.join(dir, "a.md");
    const txt = path.join(dir, "b.txt");
    await fs.writeFile(md, "md", "utf8");
    await fs.writeFile(txt, "txt", "utf8");

    const parseTranscriptFileFn = vi.fn(async (filePath: string) => makeParsed(filePath));

    const result = await runIngestCommand(
      [dir],
      { glob: "**/*.md" },
      makeDeps({
        expandInputFilesFn: vi.fn(async (inputs: string[]) => (inputs[0]?.endsWith("**/*.md") ? [md] : [])),
        parseTranscriptFileFn,
      }),
    );

    expect(result.filesProcessed).toBe(1);
    expect(parseTranscriptFileFn).toHaveBeenCalledTimes(1);
    expect(parseTranscriptFileFn).toHaveBeenCalledWith(md, { raw: false, verbose: false });
  });

  it("resolveInputFiles with directory path finds files matching glob", async () => {
    const dir = await makeTempDir();
    const rootMd = path.join(dir, "root.md");
    const rootTxt = path.join(dir, "root.txt");
    const nestedMd = path.join(dir, "nested", "child.md");
    const ignored = path.join(dir, "nested", "skip.png");
    await fs.mkdir(path.dirname(nestedMd), { recursive: true });
    await fs.writeFile(rootMd, "root", "utf8");
    await fs.writeFile(rootTxt, "txt", "utf8");
    await fs.writeFile(nestedMd, "nested", "utf8");
    await fs.writeFile(ignored, "ignored", "utf8");

    const parseTranscriptFileFn = vi.fn(async (filePath: string) => makeParsed(filePath));
    const result = await runIngestCommand(
      [dir],
      {},
      makeDeps({
        expandInputFilesFn: expandInputFiles,
        parseTranscriptFileFn,
      }),
    );

    expect(result.filesProcessed).toBe(3);
    expect(parseTranscriptFileFn).toHaveBeenCalledTimes(3);
    expect(parseTranscriptFileFn).toHaveBeenCalledWith(rootMd, { raw: false, verbose: false });
    expect(parseTranscriptFileFn).toHaveBeenCalledWith(rootTxt, { raw: false, verbose: false });
    expect(parseTranscriptFileFn).toHaveBeenCalledWith(nestedMd, { raw: false, verbose: false });
  });

  it("resolveInputFiles with directory finds files in immediate directory with ** glob", async () => {
    const dir = await makeTempDir();
    const rootMd = path.join(dir, "root.md");
    const nestedMd = path.join(dir, "nested", "child.md");
    await fs.mkdir(path.dirname(nestedMd), { recursive: true });
    await fs.writeFile(rootMd, "root", "utf8");
    await fs.writeFile(nestedMd, "nested", "utf8");

    const parseTranscriptFileFn = vi.fn(async (filePath: string) => makeParsed(filePath));
    const result = await runIngestCommand(
      [dir],
      { glob: "**/*.md" },
      makeDeps({
        expandInputFilesFn: expandInputFiles,
        parseTranscriptFileFn,
      }),
    );

    expect(result.filesProcessed).toBe(2);
    expect(parseTranscriptFileFn).toHaveBeenCalledTimes(2);
    expect(parseTranscriptFileFn).toHaveBeenCalledWith(rootMd, { raw: false, verbose: false });
    expect(parseTranscriptFileFn).toHaveBeenCalledWith(nestedMd, { raw: false, verbose: false });
  });

  it("processes files in ascending size order", async () => {
    const dir = await makeTempDir();
    const small = path.join(dir, "small.txt");
    const large = path.join(dir, "large.txt");
    await fs.writeFile(small, "x", "utf8");
    await fs.writeFile(large, "x".repeat(1000), "utf8");

    const parseOrder: string[] = [];
    const parseTranscriptFileFn = vi.fn(async (filePath: string) => {
      parseOrder.push(path.basename(filePath));
      return makeParsed(filePath);
    });

    await runIngestCommand(
      [small, large],
      { concurrency: "1", workers: 1 },
      makeDeps({
        parseTranscriptFileFn,
      }),
    );

    expect(parseOrder).toEqual(["small.txt", "large.txt"]);
  });

  it("reports correct summary counts", async () => {
    const dir = await makeTempDir();
    const ok = path.join(dir, "ok.md");
    const skip = path.join(dir, "skip.md");
    const fail = path.join(dir, "fail.md");
    await fs.writeFile(ok, "ok", "utf8");
    await fs.writeFile(skip, "skip", "utf8");
    await fs.writeFile(fail, "fail", "utf8");

    const dbExecute = vi.fn(async (query: { sql?: string; args?: unknown[] }) => {
      if ((query?.sql ?? "").includes("FROM ingest_log")) {
        const args = query.args ?? [];
        if (args[0] === skip) {
          return { rows: [{ id: "skip" }] };
        }
      }
      return { rows: [] };
    });

    const extractKnowledgeFromChunksFn = vi.fn(
      async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
        if (params.file === fail) {
          throw new Error("extract failed");
        }
        await params.onChunkComplete?.({
          chunkIndex: 0,
          totalChunks: 1,
          entries: [makeEntry("one"), makeEntry("two"), makeEntry("three")],
          warnings: [],
        });
        return {
          entries: [],
          successfulChunks: 1,
          failedChunks: 0,
          warnings: [],
        };
      },
    );

    const deduplicateEntriesFn = vi.fn((entries: KnowledgeEntry[]) => entries.slice(0, 2));
    const storeEntriesFn = vi.fn(async () => ({
      added: 1,
      updated: 1,
      skipped: 0,
      superseded: 0,
      llm_dedup_calls: 0,
      relations_created: 0,
      total_entries: 2,
      duration_ms: 3,
    }));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await runIngestCommand(
      [dir],
      {},
      makeDeps({
        db: { execute: dbExecute },
        expandInputFilesFn: vi.fn(async () => [ok, skip, fail]),
        extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
        deduplicateEntriesFn,
        storeEntriesFn: storeEntriesFn as IngestCommandDeps["storeEntriesFn"],
      }),
    );

    expect(result.filesProcessed).toBe(1);
    expect(result.filesSkipped).toBe(1);
    expect(result.filesFailed).toBe(1);
    expect(result.totalEntriesExtracted).toBe(3);
    expect(result.totalEntriesStored).toBe(1);
    expect(result.dedupStats.entries_added).toBe(1);
    expect(result.dedupStats.entries_updated).toBe(0);
    expect(result.dedupStats.entries_reinforced).toBe(1);
    expect(result.dedupStats.entries_skipped).toBe(0);
    expect(result.dedupStats.entries_superseded).toBe(0);
    expect(result.dedupStats.dedup_llm_calls).toBe(0);
    expect(result.exitCode).toBe(1);
    const output = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Done: 1 succeeded, 0 succeeded on retry, 1 failed after retries");
    expect(output).toContain("1 skipped");
    expect(output).toContain("already ingested");
    expect(output).toContain("Retries:");
    expect(output).toContain("Retry round 1:");
    expect(output).toContain("Failed files (after retries):");
    expect(output).toContain("fail.md - extract failed");
  });

  it("prints verbose dedup output with stored/skipped/reinforced separated", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "a.md");
    await fs.writeFile(filePath, "hello", "utf8");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const extractKnowledgeFromChunksFn = vi.fn(
      async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
        await params.onChunkComplete?.({
          chunkIndex: 0,
          totalChunks: 1,
          entries: [makeEntry("one"), makeEntry("two"), makeEntry("three")],
          warnings: [],
        });
        return {
          entries: [],
          successfulChunks: 1,
          failedChunks: 0,
          warnings: [],
        };
      },
    );

    await runIngestCommand(
      [dir],
      { verbose: true },
      makeDeps({
        expandInputFilesFn: vi.fn(async () => [filePath]),
        deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
        extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
        storeEntriesFn: vi.fn(async () => ({
          added: 1,
          updated: 1,
          skipped: 2,
          superseded: 0,
          llm_dedup_calls: 0,
          relations_created: 0,
          total_entries: 1,
          duration_ms: 1,
        })) as IngestCommandDeps["storeEntriesFn"],
      }),
    );

    const output = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    const startIndex = output.indexOf("-- starting");
    const completeIndex = output.indexOf("3 extracted, 1 stored, 2 skipped (duplicate), 1 reinforced");
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(completeIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeLessThan(completeIndex);
    expect(output).toContain("3 extracted, 1 stored, 2 skipped (duplicate), 1 reinforced");
  });

  it("prints only success summary when all files succeed", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "a.md");
    await fs.writeFile(filePath, "hello", "utf8");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runIngestCommand(
      [filePath],
      {},
      makeDeps({
        expandInputFilesFn: vi.fn(async () => [filePath]),
        deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries.slice(0, 1)),
        storeEntriesFn: vi.fn(async () => ({
          added: 0,
          updated: 1,
          skipped: 1,
          superseded: 0,
          llm_dedup_calls: 0,
          relations_created: 0,
          total_entries: 1,
          duration_ms: 1,
        })) as IngestCommandDeps["storeEntriesFn"],
      }),
    );

    const output = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Done: 1 succeeded, 0 failed, 0 skipped (already ingested)");
    expect(output).not.toContain("Failed files (will auto-retry on next run):");
  });

  it("prints JSON output with result payload", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "a.md");
    await fs.writeFile(filePath, "hello", "utf8");

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const result = await runIngestCommand(
      [filePath],
      { json: true },
      makeDeps({
        expandInputFilesFn: vi.fn(async () => [filePath]),
      }),
    );

    expect(result.exitCode).toBe(0);
    const written = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    const parsed = JSON.parse(written) as { filesProcessed: number; results: unknown[] };
    expect(parsed.filesProcessed).toBe(1);
    expect(Array.isArray(parsed.results)).toBe(true);
  });

  it("uses injected dependencies", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "a.md");
    await fs.writeFile(filePath, "hello", "utf8");

    const readConfigFn = vi.fn(() => ({ db: { path: ":memory:" } }));
    const expandInputFilesFn = vi.fn(async () => [filePath]);
    const deps = makeDeps({
      readConfigFn,
      expandInputFilesFn,
    });

    await runIngestCommand([dir], {}, deps);

    expect(readConfigFn).toHaveBeenCalledTimes(1);
    expect(expandInputFilesFn).toHaveBeenCalled();
  });

  it("deduplicates across files during ingest by reinforcing existing entries", async () => {
    const dir = await makeTempDir();
    const fileA = path.join(dir, "a.md");
    const fileB = path.join(dir, "b.md");
    await fs.writeFile(fileA, "a", "utf8");
    await fs.writeFile(fileB, "b", "utf8");

    const db = createClient({ url: ":memory:" });
    const storeEntriesFn: IngestCommandDeps["storeEntriesFn"] = async (client, entries, apiKey, options) =>
      storeEntries(client, entries, apiKey, {
        ...options,
        embedFn: mockEmbed,
      });

    try {
      const extractKnowledgeFromChunksFn = vi.fn(
        async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
          const entry =
            params.file === fileA
              ? makeEntry("prefers NFM financing vec-base")
              : makeEntry("likes NFM financing option vec-mid");
          await params.onChunkComplete?.({
            chunkIndex: 0,
            totalChunks: 1,
            entries: [entry],
            warnings: [],
          });
          return {
            entries: [],
            successfulChunks: 1,
            failedChunks: 0,
            warnings: [],
          };
        },
      );

      const result = await runIngestCommand(
        [dir],
        {},
        makeDeps({
          getDbFn: vi.fn(() => db) as IngestCommandDeps["getDbFn"],
          initDbFn: vi.fn(async () => initDb(db)),
          closeDbFn: vi.fn(() => undefined),
          expandInputFilesFn: vi.fn(async () => [fileA, fileB]),
          createLlmClientFn: vi.fn(() => fakeLlmClient()) as IngestCommandDeps["createLlmClientFn"],
          extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
          deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
          resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
          storeEntriesFn,
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.dedupStats.entries_reinforced).toBe(1);
      expect(result.dedupStats.entries_added).toBe(1);

      const countRows = await db.execute("SELECT COUNT(*) AS count FROM entries");
      expect(Number(countRows.rows[0]?.count)).toBe(1);
      const confirmations = await db.execute("SELECT confirmations FROM entries LIMIT 1");
      expect(Number(confirmations.rows[0]?.confirmations)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("enables LLM online dedup band during ingest store path", async () => {
    const dir = await makeTempDir();
    const fileA = path.join(dir, "a.md");
    const fileB = path.join(dir, "b.md");
    await fs.writeFile(fileA, "a", "utf8");
    await fs.writeFile(fileB, "b", "utf8");

    const db = createClient({ url: ":memory:" });
    const onlineDedupFn = vi.fn(async () => ({
      action: "SKIP" as const,
      target_id: null,
      merged_content: null,
      reasoning: "LLM dedup enabled for ingest",
    }));
    const storeEntriesFn: IngestCommandDeps["storeEntriesFn"] = async (client, entries, apiKey, options) =>
      storeEntries(client, entries, apiKey, {
        ...options,
        embedFn: mockEmbed,
        llmClient: fakeLlmClient(),
        onlineDedupFn,
      });

    try {
      const extractKnowledgeFromChunksFn = vi.fn(
        async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
          const entry = params.file === fileA ? makeEntry("seed vec-base") : makeEntry("candidate vec-85");
          await params.onChunkComplete?.({
            chunkIndex: 0,
            totalChunks: 1,
            entries: [entry],
            warnings: [],
          });
          return {
            entries: [],
            successfulChunks: 1,
            failedChunks: 0,
            warnings: [],
          };
        },
      );

      const result = await runIngestCommand(
        [dir],
        {},
        makeDeps({
          getDbFn: vi.fn(() => db) as IngestCommandDeps["getDbFn"],
          initDbFn: vi.fn(async () => initDb(db)),
          closeDbFn: vi.fn(() => undefined),
          expandInputFilesFn: vi.fn(async () => [fileA, fileB]),
          createLlmClientFn: vi.fn(() => fakeLlmClient()) as IngestCommandDeps["createLlmClientFn"],
          extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
          deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
          resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
          storeEntriesFn,
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(onlineDedupFn).toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("syncs JSONL ingest byte offset into watch state", async () => {
    const dir = await makeTempDir();
    const configDir = path.join(dir, ".agenr");
    const filePath = path.join(dir, "session.jsonl");
    const rawContent = '{"role":"user","content":"hello"}\n';
    await fs.writeFile(filePath, rawContent, "utf8");

    const result = await runIngestCommand(
      [filePath],
      {},
      makeDeps({
        expandInputFilesFn: vi.fn(async () => [filePath]),
        loadWatchStateFn: vi.fn(() => loadWatchState(configDir)),
        saveWatchStateFn: vi.fn((state) => saveWatchState(state, configDir)),
      }),
    );

    expect(result.exitCode).toBe(0);
    const state = await loadWatchState(configDir);
    expect(state.files[path.resolve(filePath)]?.byteOffset).toBe(Buffer.byteLength(rawContent, "utf8"));
  });

  it("does not overwrite a higher existing watch offset when not forced", async () => {
    const dir = await makeTempDir();
    const configDir = path.join(dir, ".agenr");
    const filePath = path.join(dir, "session.jsonl");
    const rawContent = '{"role":"user","content":"hello"}\n';
    await fs.writeFile(filePath, rawContent, "utf8");

    const state = createEmptyWatchState();
    updateFileState(state, filePath, { byteOffset: 10_000 });
    await saveWatchState(state, configDir);

    const result = await runIngestCommand(
      [filePath],
      {},
      makeDeps({
        expandInputFilesFn: vi.fn(async () => [filePath]),
        loadWatchStateFn: vi.fn(() => loadWatchState(configDir)),
        saveWatchStateFn: vi.fn((next) => saveWatchState(next, configDir)),
      }),
    );

    expect(result.exitCode).toBe(0);
    const reloaded = await loadWatchState(configDir);
    expect(reloaded.files[path.resolve(filePath)]?.byteOffset).toBe(10_000);
  });

  it("resets watch offset to new ingest byte offset when forced", async () => {
    const dir = await makeTempDir();
    const configDir = path.join(dir, ".agenr");
    const filePath = path.join(dir, "session.jsonl");
    const rawContent = '{"role":"user","content":"hello"}\n';
    await fs.writeFile(filePath, rawContent, "utf8");

    const state = createEmptyWatchState();
    updateFileState(state, filePath, { byteOffset: 10_000 });
    await saveWatchState(state, configDir);

    const result = await runIngestCommand(
      [filePath],
      { force: true },
      makeDeps({
        expandInputFilesFn: vi.fn(async () => [filePath]),
        loadWatchStateFn: vi.fn(() => loadWatchState(configDir)),
        saveWatchStateFn: vi.fn((next) => saveWatchState(next, configDir)),
      }),
    );

    expect(result.exitCode).toBe(0);
    const reloaded = await loadWatchState(configDir);
    expect(reloaded.files[path.resolve(filePath)]?.byteOffset).toBe(Buffer.byteLength(rawContent, "utf8"));
  });

  it("does not sync watch state for non-JSONL files", async () => {
    const dir = await makeTempDir();
    const configDir = path.join(dir, ".agenr");
    const markdownPath = path.join(dir, "note.md");
    const textPath = path.join(dir, "notes.txt");
    await fs.writeFile(markdownPath, "# note\nhello\n", "utf8");
    await fs.writeFile(textPath, "plain text\n", "utf8");

    const result = await runIngestCommand(
      [markdownPath, textPath],
      {},
      makeDeps({
        expandInputFilesFn: vi.fn(async () => [markdownPath, textPath]),
        loadWatchStateFn: vi.fn(() => loadWatchState(configDir)),
        saveWatchStateFn: vi.fn((next) => saveWatchState(next, configDir)),
      }),
    );

    expect(result.exitCode).toBe(0);
    const state = await loadWatchState(configDir);
    expect(state.files[path.resolve(markdownPath)]).toBeUndefined();
    expect(state.files[path.resolve(textPath)]).toBeUndefined();
  });

  it("starts watch from ingest-synced offset instead of zero", async () => {
    const dir = await makeTempDir();
    const configDir = path.join(dir, ".agenr");
    const filePath = path.join(dir, "session.jsonl");
    const initialContent = '{"role":"user","content":"hello"}\n';
    const appendedContent = '{"role":"assistant","content":"new content"}\n';
    await fs.writeFile(filePath, initialContent, "utf8");

    const ingestResult = await runIngestCommand(
      [filePath],
      {},
      makeDeps({
        expandInputFilesFn: vi.fn(async () => [filePath]),
        loadWatchStateFn: vi.fn(() => loadWatchState(configDir)),
        saveWatchStateFn: vi.fn((next) => saveWatchState(next, configDir)),
      }),
    );
    expect(ingestResult.exitCode).toBe(0);

    await fs.appendFile(filePath, appendedContent, "utf8");
    const readOffsets: number[] = [];

    const watchResult = await runWatchCommand(
      filePath,
      { once: true, interval: "1", minChunk: "1" },
      {
        readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } })),
        resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
        parseTranscriptFileFn: vi.fn(async () => ({
          file: filePath,
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
        })),
        createLlmClientFn: vi.fn(() => ({ resolvedModel: { modelId: "test" }, credentials: { apiKey: "x" } } as any)),
        extractKnowledgeFromChunksFn: vi.fn(async (params: {
          onChunkComplete?: (result: {
            chunkIndex: number;
            totalChunks: number;
            entries: KnowledgeEntry[];
            warnings: string[];
          }) => Promise<void>;
        }) => {
          await params.onChunkComplete?.({
            chunkIndex: 0,
            totalChunks: 1,
            entries: [makeEntry("watch entry")],
            warnings: [],
          });
          return {
            entries: [],
            successfulChunks: 1,
            failedChunks: 0,
            warnings: [],
          };
        }),
        deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
        getDbFn: vi.fn(() => ({}) as any),
        initDbFn: vi.fn(async () => undefined),
        closeDbFn: vi.fn(() => undefined),
        storeEntriesFn: vi.fn(async () => ({
          added: 1,
          updated: 0,
          skipped: 0,
          superseded: 0,
          llm_dedup_calls: 0,
          relations_created: 0,
          total_entries: 1,
          duration_ms: 5,
        })) as any,
        loadWatchStateFn: vi.fn(() => loadWatchState(configDir)),
        saveWatchStateFn: vi.fn((next) => saveWatchState(next, configDir)),
        statFileFn: vi.fn((target: string) => fs.stat(target)) as any,
        readFileFn: vi.fn(async (target: string, offset: number) => {
          readOffsets.push(offset);
          return readFileFromOffset(target, offset);
        }),
        nowFn: vi.fn(() => new Date("2026-02-15T00:00:00.000Z")),
        writeWatcherPidFn: vi.fn(async () => undefined),
        deleteWatcherPidFn: vi.fn(async () => undefined),
      },
    );

    expect(watchResult.exitCode).toBe(0);
    expect(readOffsets[0]).toBe(Buffer.byteLength(initialContent, "utf8"));
  });
});
