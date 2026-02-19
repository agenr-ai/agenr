import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import * as clack from "@clack/prompts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWatchCommand, writeContextVariants } from "../../src/commands/watch.js";
import type { KnowledgeEntry } from "../../src/types.js";
import { initDb } from "../../src/db/client.js";
import { onShutdown, requestShutdown, resetShutdownForTests } from "../../src/shutdown.js";
import { loadWatchState, saveWatchState } from "../../src/watch/state.js";
import { readFileFromOffset } from "../../src/watch/watcher.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-watch-command-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeEntry(): KnowledgeEntry {
  return {
    type: "fact",
    subject: "Jim",
    content: "Uses watch mode",
    importance: 8,
    expiry: "temporary",
    tags: ["watch"],
    source: {
      file: "source.jsonl",
      context: "test",
    },
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

async function seedContextEntry(client: Client, params: {
  id: string;
  type: string;
  subject: string;
  content: string;
  importance: number;
  createdAt: string;
  updatedAt: string;
  recallCount?: number;
}): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO entries (
        id, type, subject, content, importance, expiry, scope, source_file, source_context, created_at, updated_at, recall_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      params.id,
      params.type,
      params.subject,
      params.content,
      params.importance,
      "permanent",
      "private",
      "watch.test.jsonl",
      "test",
      params.createdAt,
      params.updatedAt,
      params.recallCount ?? 0,
    ],
  });
}

async function makeHotContextFixture(): Promise<{ contextPath: string; now: Date }> {
  const dir = await makeTempDir();
  return {
    contextPath: path.join(dir, "CONTEXT.md"),
    now: new Date("2026-02-18T00:00:00.000Z"),
  };
}

describe("watch command", () => {
  it("wires CLI options into runWatchCommand", async () => {
    const { createProgram } = await import("../../src/cli-main.js");
    const program = createProgram();
    const watchCommand = program.commands.find((command) => command.name() === "watch");
    const runWatchCommandMock = vi.fn(async (..._args: unknown[]) => undefined);
    watchCommand?.action(runWatchCommandMock as any);

    await program.parseAsync([
      "node",
      "agenr",
      "watch",
      "/tmp/session.jsonl",
      "--interval",
      "7",
      "--min-chunk",
      "1500",
      "--context",
      "/tmp/CONTEXT.md",
      "--db",
      "/tmp/db.sqlite",
      "--model",
      "gpt-4o",
      "--provider",
      "openai",
      "--verbose",
      "--dry-run",
      "--once",
      "--json",
    ]);

    expect(runWatchCommandMock).toHaveBeenCalledTimes(1);
    const firstCall = (runWatchCommandMock.mock.calls as unknown[][])[0] as [string, Record<string, unknown>] | undefined;
    expect(firstCall?.[0]).toBe("/tmp/session.jsonl");
    expect(firstCall?.[1]).toMatchObject({
      interval: 7,
      minChunk: 1500,
      context: "/tmp/CONTEXT.md",
      db: "/tmp/db.sqlite",
      model: "gpt-4o",
      provider: "openai",
      verbose: true,
      dryRun: true,
      once: true,
      json: true,
    });
  });

  it("wires directory mode options into runWatchCommand", async () => {
    const { createProgram } = await import("../../src/cli-main.js");
    const program = createProgram();
    const watchCommand = program.commands.find((command) => command.name() === "watch");
    const runWatchCommandMock = vi.fn(async (..._args: unknown[]) => undefined);
    watchCommand?.action(runWatchCommandMock as any);

    await program.parseAsync([
      "node",
      "agenr",
      "watch",
      "--dir",
      "/tmp/sessions",
      "--platform",
      "codex",
      "--once",
    ]);

    expect(runWatchCommandMock).toHaveBeenCalledTimes(1);
    const firstCall = (runWatchCommandMock.mock.calls as unknown[][])[0] as [string | undefined, Record<string, unknown>] | undefined;
    expect(firstCall?.[0]).toBeUndefined();
    expect(firstCall?.[1]).toMatchObject({
      dir: "/tmp/sessions",
      platform: "codex",
      once: true,
    });
  });

  it("rejects when watch mode is ambiguous", async () => {
    await expect(
      runWatchCommand("/tmp/session.jsonl", { dir: "/tmp/sessions" }, {
        writeWatcherPidFn: vi.fn(async () => undefined),
        deleteWatcherPidFn: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow("Choose exactly one watch mode");
  });

  it("rejects when no watch mode is provided", async () => {
    await expect(
      runWatchCommand(undefined, {}, {
        writeWatcherPidFn: vi.fn(async () => undefined),
        deleteWatcherPidFn: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow("Choose exactly one watch mode");
  });

  it("validates --dir path existence", async () => {
    const statFileFn = vi.fn(async () => {
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });

    await expect(
      runWatchCommand(undefined, { dir: "/tmp/does-not-exist" }, {
        statFileFn: statFileFn as any,
        writeWatcherPidFn: vi.fn(async () => undefined),
        deleteWatcherPidFn: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow("Sessions directory not found");
  });

  it("writes watcher PID file before watch loop starts", async () => {
    const dir = await makeTempDir();
    const transcriptPath = path.join(dir, "session.txt");
    const configDir = path.join(dir, ".agenr");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(transcriptPath, "watch content\n", "utf8");

    const writeWatcherPidFn = vi.fn(async () => undefined);
    const deleteWatcherPidFn = vi.fn(async () => undefined);
    const readFileFn = vi.fn(async (filePath: string, offset: number) => readFileFromOffset(filePath, offset));

    const result = await runWatchCommand(
      transcriptPath,
      { once: true, interval: "1", minChunk: "1" },
      {
        readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } })),
        resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
        parseTranscriptFileFn: vi.fn(async () => ({
          file: transcriptPath,
          messages: [],
          chunks: [{ chunk_index: 0, message_start: 0, message_end: 0, text: "chunk", context_hint: "ctx" }],
          warnings: [],
        })),
        createLlmClientFn: vi.fn(() => ({ resolvedModel: { modelId: "test" }, credentials: { apiKey: "x" } } as any)),
        extractKnowledgeFromChunksFn: vi.fn(async (params: any) => {
          await params.onChunkComplete?.({ chunkIndex: 0, totalChunks: 1, entries: [makeEntry()], warnings: [] });
          return { entries: [], successfulChunks: 1, failedChunks: 0, warnings: [] };
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
          duration_ms: 1,
        })) as any,
        loadWatchStateFn: vi.fn(() => loadWatchState(configDir)),
        saveWatchStateFn: vi.fn((state) => saveWatchState(state, configDir)),
        statFileFn: vi.fn((filePath: string) => fs.stat(filePath)) as any,
        readFileFn: readFileFn as any,
        generateContextFileFn: vi.fn(async () => undefined) as any,
        writeWatcherPidFn,
        deleteWatcherPidFn,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(writeWatcherPidFn).toHaveBeenCalledTimes(1);
    const writeOrder = writeWatcherPidFn.mock.invocationCallOrder[0] ?? 0;
    const readOrder = readFileFn.mock.invocationCallOrder[0] ?? 0;
    expect(writeOrder).toBeGreaterThan(0);
    expect(readOrder).toBeGreaterThan(0);
    expect(writeOrder).toBeLessThan(readOrder);
  });

  it("deletes watcher PID file on normal exit and error exit", async () => {
    const dir = await makeTempDir();
    const transcriptPath = path.join(dir, "session.txt");
    const configDir = path.join(dir, ".agenr");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(transcriptPath, "watch content\n", "utf8");

    const deleteWatcherPidFn = vi.fn(async () => undefined);

    const successResult = await runWatchCommand(
      transcriptPath,
      { once: true, interval: "1", minChunk: "1" },
      {
        readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } })),
        resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
        parseTranscriptFileFn: vi.fn(async () => ({
          file: transcriptPath,
          messages: [],
          chunks: [{ chunk_index: 0, message_start: 0, message_end: 0, text: "chunk", context_hint: "ctx" }],
          warnings: [],
        })),
        createLlmClientFn: vi.fn(() => ({ resolvedModel: { modelId: "test" }, credentials: { apiKey: "x" } } as any)),
        extractKnowledgeFromChunksFn: vi.fn(async (params: any) => {
          await params.onChunkComplete?.({ chunkIndex: 0, totalChunks: 1, entries: [makeEntry()], warnings: [] });
          return { entries: [], successfulChunks: 1, failedChunks: 0, warnings: [] };
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
          duration_ms: 1,
        })) as any,
        loadWatchStateFn: vi.fn(() => loadWatchState(configDir)),
        saveWatchStateFn: vi.fn((state) => saveWatchState(state, configDir)),
        statFileFn: vi.fn((filePath: string) => fs.stat(filePath)) as any,
        readFileFn: vi.fn((filePath: string, offset: number) => readFileFromOffset(filePath, offset)),
        generateContextFileFn: vi.fn(async () => undefined) as any,
        writeWatcherPidFn: vi.fn(async () => undefined),
        deleteWatcherPidFn,
      },
    );

    expect(successResult.exitCode).toBe(0);

    const errorDeleteWatcherPidFn = vi.fn(async () => undefined);
    await expect(
      runWatchCommand(undefined, {}, {
        writeWatcherPidFn: vi.fn(async () => undefined),
        deleteWatcherPidFn: errorDeleteWatcherPidFn,
      }),
    ).rejects.toThrow("Choose exactly one watch mode");

    expect(deleteWatcherPidFn).toHaveBeenCalled();
    expect(errorDeleteWatcherPidFn).toHaveBeenCalled();
  });

  it("does not run shutdown handlers on clean --once exit", async () => {
    const dir = await makeTempDir();
    const transcriptPath = path.join(dir, "session.txt");
    const configDir = path.join(dir, ".agenr");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(transcriptPath, "watch content\n", "utf8");

    const deleteWatcherPidFn = vi.fn(async () => undefined);
    const shutdownHandlerSpy = vi.fn(async () => undefined);
    onShutdown(shutdownHandlerSpy);

    const result = await runWatchCommand(
      transcriptPath,
      { once: true, interval: "1", minChunk: "1", dryRun: true },
      {
        readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } })),
        resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
        parseTranscriptFileFn: vi.fn(async () => ({
          file: transcriptPath,
          messages: [],
          chunks: [{ chunk_index: 0, message_start: 0, message_end: 0, text: "chunk", context_hint: "ctx" }],
          warnings: [],
        })),
        createLlmClientFn: vi.fn(() => ({ resolvedModel: { modelId: "test" }, credentials: { apiKey: "x" } } as any)),
        extractKnowledgeFromChunksFn: vi.fn(async () => ({
          entries: [],
          successfulChunks: 1,
          failedChunks: 0,
          warnings: [],
        })),
        deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
        getDbFn: vi.fn(() => ({}) as any),
        initDbFn: vi.fn(async () => undefined),
        closeDbFn: vi.fn(() => undefined),
        storeEntriesFn: vi.fn(async () => ({
          added: 0,
          updated: 0,
          skipped: 0,
          superseded: 0,
          llm_dedup_calls: 0,
          relations_created: 0,
          total_entries: 0,
          duration_ms: 1,
        })) as any,
        loadWatchStateFn: vi.fn(() => loadWatchState(configDir)),
        saveWatchStateFn: vi.fn((state) => saveWatchState(state, configDir)),
        statFileFn: vi.fn((filePath: string) => fs.stat(filePath)) as any,
        readFileFn: vi.fn((filePath: string, offset: number) => readFileFromOffset(filePath, offset)),
        generateContextFileFn: vi.fn(async () => undefined) as any,
        writeWatcherPidFn: vi.fn(async () => undefined),
        deleteWatcherPidFn,
        exitProcessFn: vi.fn(),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(deleteWatcherPidFn).toHaveBeenCalledTimes(1);
    expect(shutdownHandlerSpy).toHaveBeenCalledTimes(0);
  });

  it("runs shutdown handlers on signal path", async () => {
    const dir = await makeTempDir();
    const transcriptPath = path.join(dir, "session.txt");
    const configDir = path.join(dir, ".agenr");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(transcriptPath, "watch content\n", "utf8");

    const deleteWatcherPidFn = vi.fn(async () => undefined);
    const shutdownHandlerSpy = vi.fn(async () => undefined);
    onShutdown(shutdownHandlerSpy);

    const result = await runWatchCommand(
      transcriptPath,
      { once: true, interval: "1", minChunk: "1", dryRun: true },
      {
        readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } })),
        resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
        parseTranscriptFileFn: vi.fn(async () => ({
          file: transcriptPath,
          messages: [],
          chunks: [{ chunk_index: 0, message_start: 0, message_end: 0, text: "chunk", context_hint: "ctx" }],
          warnings: [],
        })),
        createLlmClientFn: vi.fn(() => ({ resolvedModel: { modelId: "test" }, credentials: { apiKey: "x" } } as any)),
        extractKnowledgeFromChunksFn: vi.fn(async () => {
          requestShutdown();
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
          added: 0,
          updated: 0,
          skipped: 0,
          superseded: 0,
          llm_dedup_calls: 0,
          relations_created: 0,
          total_entries: 0,
          duration_ms: 1,
        })) as any,
        loadWatchStateFn: vi.fn(() => loadWatchState(configDir)),
        saveWatchStateFn: vi.fn((state) => saveWatchState(state, configDir)),
        statFileFn: vi.fn((filePath: string) => fs.stat(filePath)) as any,
        readFileFn: vi.fn((filePath: string, offset: number) => readFileFromOffset(filePath, offset)),
        generateContextFileFn: vi.fn(async () => undefined) as any,
        writeWatcherPidFn: vi.fn(async () => undefined),
        deleteWatcherPidFn,
        exitProcessFn: vi.fn(),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(deleteWatcherPidFn).toHaveBeenCalledTimes(1);
    expect(shutdownHandlerSpy).toHaveBeenCalledTimes(1);
  });

  it("runs one cycle and stores extracted entries", async () => {
    const dir = await makeTempDir();
    const transcriptPath = path.join(dir, "session.txt");
    const configDir = path.join(dir, ".agenr");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      transcriptPath,
      "user: here is enough content to trigger watch extraction cycle\nassistant: acknowledged\n",
      "utf8",
    );

    const storeEntriesSpy = vi.fn(async () => ({
      added: 1,
      updated: 0,
      skipped: 0,
      superseded: 0,
      llm_dedup_calls: 0,
      relations_created: 0,
      total_entries: 1,
      duration_ms: 5,
    }));

    const result = await runWatchCommand(
      transcriptPath,
      {
        once: true,
        interval: "1",
        minChunk: "10",
        context: path.join(dir, "CONTEXT.md"),
      },
      {
        readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } })),
        resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
        parseTranscriptFileFn: vi.fn(async () => ({
          file: transcriptPath,
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
        extractKnowledgeFromChunksFn: vi.fn(
          async (params: {
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
              entries: [makeEntry()],
              warnings: [],
            });
            return {
              entries: [],
              successfulChunks: 1,
              failedChunks: 0,
              warnings: [],
            };
          },
        ),
        deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
        getDbFn: vi.fn(() => ({}) as any),
        initDbFn: vi.fn(async () => undefined),
        closeDbFn: vi.fn(() => undefined),
        storeEntriesFn: storeEntriesSpy as any,
        loadWatchStateFn: vi.fn(() => loadWatchState(configDir)),
        saveWatchStateFn: vi.fn((state) => saveWatchState(state, configDir)),
        statFileFn: vi.fn((filePath: string) => fs.stat(filePath)) as any,
        readFileFn: vi.fn((filePath: string, offset: number) => readFileFromOffset(filePath, offset)),
        nowFn: vi.fn(() => new Date("2026-02-15T00:00:00.000Z")),
        generateContextFileFn: vi.fn(async () => undefined) as any,
        writeWatcherPidFn: vi.fn(async () => undefined),
        deleteWatcherPidFn: vi.fn(async () => undefined),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.cycles).toBe(1);
    expect(result.entriesStored).toBe(1);
    expect(storeEntriesSpy).toHaveBeenCalledTimes(1);

    const state = await loadWatchState(configDir);
    const saved = state.files[path.resolve(transcriptPath)];
    expect(saved?.byteOffset).toBeGreaterThan(0);
    expect(saved?.totalEntriesStored).toBe(1);
    expect(saved?.totalRunCount).toBe(1);
  });

  it("regenerates context only when entries were actually stored", async () => {
    const dir = await makeTempDir();
    const transcriptPath = path.join(dir, "session.txt");
    const configDir = path.join(dir, ".agenr");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(transcriptPath, "enough content for extraction\n", "utf8");

    const generateContextFileFn = vi.fn(async () => undefined);
    const storeEntriesSpy = vi.fn(async () => ({
      added: 0,
      updated: 0,
      skipped: 1,
      superseded: 0,
      llm_dedup_calls: 0,
      relations_created: 0,
      total_entries: 0,
      duration_ms: 5,
    }));

    const result = await runWatchCommand(
      transcriptPath,
      {
        once: true,
        interval: "1",
        minChunk: "1",
        context: path.join(dir, "CONTEXT.md"),
      },
      {
        readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } })),
        resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
        parseTranscriptFileFn: vi.fn(async () => ({
          file: transcriptPath,
          messages: [],
          chunks: [{ chunk_index: 0, message_start: 0, message_end: 0, text: "chunk", context_hint: "ctx" }],
          warnings: [],
        })),
        createLlmClientFn: vi.fn(() => ({ resolvedModel: { modelId: "test" }, credentials: { apiKey: "x" } } as any)),
        extractKnowledgeFromChunksFn: vi.fn(async (params: any) => {
          await params.onChunkComplete?.({ chunkIndex: 0, totalChunks: 1, entries: [makeEntry()], warnings: [] });
          return { entries: [], successfulChunks: 1, failedChunks: 0, warnings: [] };
        }),
        deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
        getDbFn: vi.fn(() => ({}) as any),
        initDbFn: vi.fn(async () => undefined),
        closeDbFn: vi.fn(() => undefined),
        storeEntriesFn: storeEntriesSpy as any,
        loadWatchStateFn: vi.fn(() => loadWatchState(configDir)),
        saveWatchStateFn: vi.fn((state) => saveWatchState(state, configDir)),
        statFileFn: vi.fn((filePath: string) => fs.stat(filePath)) as any,
        readFileFn: vi.fn((filePath: string, offset: number) => readFileFromOffset(filePath, offset)),
        nowFn: vi.fn(() => new Date("2026-02-15T00:00:00.000Z")),
        generateContextFileFn: generateContextFileFn as any,
        writeWatcherPidFn: vi.fn(async () => undefined),
        deleteWatcherPidFn: vi.fn(async () => undefined),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.entriesStored).toBe(0);
    expect(generateContextFileFn).not.toHaveBeenCalled();
  });

  it("context generation failure does not kill the watch loop", async () => {
    const dir = await makeTempDir();
    const transcriptPath = path.join(dir, "session.txt");
    const configDir = path.join(dir, ".agenr");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(transcriptPath, "enough content for extraction\n", "utf8");

    const generateContextFileFn = vi.fn(async () => {
      throw new Error("context failed");
    });

    const storeEntriesSpy = vi.fn(async () => ({
      added: 1,
      updated: 0,
      skipped: 0,
      superseded: 0,
      llm_dedup_calls: 0,
      relations_created: 0,
      total_entries: 1,
      duration_ms: 5,
    }));

    const result = await runWatchCommand(
      transcriptPath,
      {
        once: true,
        interval: "1",
        minChunk: "1",
        context: path.join(dir, "CONTEXT.md"),
        verbose: true,
      },
      {
        readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } })),
        resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
        parseTranscriptFileFn: vi.fn(async () => ({
          file: transcriptPath,
          messages: [],
          chunks: [{ chunk_index: 0, message_start: 0, message_end: 0, text: "chunk", context_hint: "ctx" }],
          warnings: [],
        })),
        createLlmClientFn: vi.fn(() => ({ resolvedModel: { modelId: "test" }, credentials: { apiKey: "x" } } as any)),
        extractKnowledgeFromChunksFn: vi.fn(async (params: any) => {
          await params.onChunkComplete?.({ chunkIndex: 0, totalChunks: 1, entries: [makeEntry()], warnings: [] });
          return { entries: [], successfulChunks: 1, failedChunks: 0, warnings: [] };
        }),
        deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
        getDbFn: vi.fn(() => ({}) as any),
        initDbFn: vi.fn(async () => undefined),
        closeDbFn: vi.fn(() => undefined),
        storeEntriesFn: storeEntriesSpy as any,
        loadWatchStateFn: vi.fn(() => loadWatchState(configDir)),
        saveWatchStateFn: vi.fn((state) => saveWatchState(state, configDir)),
        statFileFn: vi.fn((filePath: string) => fs.stat(filePath)) as any,
        readFileFn: vi.fn((filePath: string, offset: number) => readFileFromOffset(filePath, offset)),
        nowFn: vi.fn(() => new Date("2026-02-15T00:00:00.000Z")),
        generateContextFileFn: generateContextFileFn as any,
        writeWatcherPidFn: vi.fn(async () => undefined),
        deleteWatcherPidFn: vi.fn(async () => undefined),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.entriesStored).toBe(1);
    expect(generateContextFileFn).toHaveBeenCalledTimes(1);
  });

  it("emits onWarn when context write fails (regardless of verbose)", async () => {
    const dir = await makeTempDir();
    const transcriptPath = path.join(dir, "session.txt");
    const configDir = path.join(dir, ".agenr");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(transcriptPath, "enough content for extraction\n", "utf8");

    const generateContextFileFn = vi.fn(async () => {
      throw new Error("context failed");
    });
    const warnSpy = vi.spyOn(clack.log, "warn");

    await runWatchCommand(
      transcriptPath,
      {
        once: true,
        interval: "1",
        minChunk: "1",
        context: path.join(dir, "CONTEXT.md"),
        verbose: false,
      },
      {
        readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } })),
        resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
        parseTranscriptFileFn: vi.fn(async () => ({
          file: transcriptPath,
          messages: [],
          chunks: [{ chunk_index: 0, message_start: 0, message_end: 0, text: "chunk", context_hint: "ctx" }],
          warnings: [],
        })),
        createLlmClientFn: vi.fn(() => ({ resolvedModel: { modelId: "test" }, credentials: { apiKey: "x" } } as any)),
        extractKnowledgeFromChunksFn: vi.fn(async (params: any) => {
          await params.onChunkComplete?.({ chunkIndex: 0, totalChunks: 1, entries: [makeEntry()], warnings: [] });
          return { entries: [], successfulChunks: 1, failedChunks: 0, warnings: [] };
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
        saveWatchStateFn: vi.fn((state) => saveWatchState(state, configDir)),
        statFileFn: vi.fn((filePath: string) => fs.stat(filePath)) as any,
        readFileFn: vi.fn((filePath: string, offset: number) => readFileFromOffset(filePath, offset)),
        nowFn: vi.fn(() => new Date("2026-02-15T00:00:00.000Z")),
        generateContextFileFn: generateContextFileFn as any,
        writeWatcherPidFn: vi.fn(async () => undefined),
        deleteWatcherPidFn: vi.fn(async () => undefined),
      },
    );

    expect(
      warnSpy.mock.calls.some((call) => String(call[0]).includes("Context refresh failed")),
    ).toBe(true);
  });

  it("keeps DB open for context refresh and writes context variants", async () => {
    const dir = await makeTempDir();
    const transcriptPath = path.join(dir, "session.txt");
    const contextDir = path.join(dir, "context");
    const contextPath = path.join(contextDir, "CONTEXT.md");
    const configDir = path.join(dir, ".agenr");
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(contextDir, { recursive: true });
    await fs.writeFile(transcriptPath, "enough content for extraction\n", "utf8");

    const client = createClient({ url: ":memory:" });
    await initDb(client);
    await seedContextEntry(client, {
      id: "ctx-1",
      type: "fact",
      subject: "Seeded context",
      content: "Seeded context entry for variant generation",
      importance: 8,
      createdAt: "2026-02-18T00:08:00.000Z",
      updatedAt: "2026-02-18T00:09:00.000Z",
    });

    let sawOpenClient = false;
    const generateContextFileFn = vi.fn(async (db: Client) => {
      await db.execute({ sql: "SELECT 1", args: [] });
      sawOpenClient = true;
    });
    const closeDbFn = vi.fn((db: Client) => {
      db.close();
    });

    const result = await runWatchCommand(
      transcriptPath,
      {
        once: true,
        interval: "1",
        minChunk: "1",
        context: contextPath,
      },
      {
        readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } })),
        resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
        parseTranscriptFileFn: vi.fn(async () => ({
          file: transcriptPath,
          messages: [],
          chunks: [{ chunk_index: 0, message_start: 0, message_end: 0, text: "chunk", context_hint: "ctx" }],
          warnings: [],
        })),
        createLlmClientFn: vi.fn(() => ({ resolvedModel: { modelId: "test" }, credentials: { apiKey: "x" } } as any)),
        extractKnowledgeFromChunksFn: vi.fn(async (params: any) => {
          await params.onChunkComplete?.({ chunkIndex: 0, totalChunks: 1, entries: [makeEntry()], warnings: [] });
          return { entries: [], successfulChunks: 1, failedChunks: 0, warnings: [] };
        }),
        deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
        getDbFn: vi.fn(() => client) as any,
        initDbFn: vi.fn(async () => undefined),
        closeDbFn: closeDbFn as any,
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
        saveWatchStateFn: vi.fn((state) => saveWatchState(state, configDir)),
        statFileFn: vi.fn((filePath: string) => fs.stat(filePath)) as any,
        readFileFn: vi.fn((filePath: string, offset: number) => readFileFromOffset(filePath, offset)),
        nowFn: vi.fn(() => new Date("2026-02-18T00:10:00.000Z")),
        generateContextFileFn: generateContextFileFn as any,
        writeWatcherPidFn: vi.fn(async () => undefined),
        deleteWatcherPidFn: vi.fn(async () => undefined),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.entriesStored).toBe(1);
    expect(generateContextFileFn).toHaveBeenCalledTimes(1);
    expect(sawOpenClient).toBe(true);

    const miniPath = path.join(contextDir, "context-mini.md");
    const hotPath = path.join(contextDir, "context-hot.md");
    await expect(fs.stat(miniPath)).resolves.toBeDefined();
    await expect(fs.stat(hotPath)).resolves.toBeDefined();
    expect(closeDbFn).toHaveBeenCalledTimes(1);
  });

  it("writes context-mini.md with at most 20 entries", async () => {
    const dir = await makeTempDir();
    const contextPath = path.join(dir, "CONTEXT.md");
    const client = createClient({ url: ":memory:" });
    await initDb(client);

    try {
      for (let i = 0; i < 30; i += 1) {
        await seedContextEntry(client, {
          id: `mini-${i}`,
          type: "fact",
          subject: `Subject ${i}`,
          content: `Content ${i} ${"x ".repeat(20)}`.trim(),
          importance: 6,
          createdAt: "2026-02-10T00:00:00.000Z",
          updatedAt: "2026-02-18T00:00:00.000Z",
          recallCount: i % 7,
        });
      }

      await writeContextVariants(client as any, contextPath, new Date("2026-02-18T00:00:00.000Z"));
      const miniPath = path.join(dir, "context-mini.md");
      const content = await fs.readFile(miniPath, "utf8");
      const entries = content
        .split("\n")
        .filter((line) => line.startsWith("- ["));

      expect(entries.length).toBeLessThanOrEqual(20);
    } finally {
      client.close();
    }
  });

  it("writes context-hot.md with eligible entries only", async () => {
    const { contextPath, now } = await makeHotContextFixture();

    const client = createClient({ url: ":memory:" });
    await initDb(client);
    try {
      await seedContextEntry(client, {
        id: "hot-1",
        type: "fact",
        subject: "Hot eligible",
        content: "eligible",
        importance: 8,
        createdAt: "2026-02-17T23:50:00.000Z",
        updatedAt: "2026-02-17T23:55:00.000Z",
        recallCount: 1,
      });
      await seedContextEntry(client, {
        id: "hot-2",
        type: "fact",
        subject: "Too old",
        content: "too old",
        importance: 8,
        createdAt: "2026-02-17T22:00:00.000Z",
        updatedAt: "2026-02-17T23:40:00.000Z",
        recallCount: 1,
      });
      await seedContextEntry(client, {
        id: "hot-3",
        type: "fact",
        subject: "Low importance",
        content: "low importance",
        importance: 6,
        createdAt: "2026-02-17T23:55:00.000Z",
        updatedAt: "2026-02-17T23:56:00.000Z",
        recallCount: 1,
      });

      await writeContextVariants(client as any, contextPath, now);
      const hotPath = path.join(path.dirname(contextPath), "context-hot.md");
      const hot = await fs.readFile(hotPath, "utf8");
      expect(hot).toContain("Hot eligible");
      expect(hot).not.toContain("Too old");
      expect(hot).not.toContain("Low importance");
    } finally {
      client.close();
    }
  });

  it("writes empty context-hot.md when no entries qualify", async () => {
    const { contextPath, now } = await makeHotContextFixture();

    const client = createClient({ url: ":memory:" });
    await initDb(client);
    try {
      await writeContextVariants(client as any, contextPath, now);
      const hotPath = path.join(path.dirname(contextPath), "context-hot.md");
      const hot = await fs.readFile(hotPath, "utf8");
      expect(hot).toBe("");
    } finally {
      client.close();
    }
  });
});
