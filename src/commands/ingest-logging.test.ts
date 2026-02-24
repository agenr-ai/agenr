import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing as extractorTesting, extractKnowledgeFromChunks } from "../extractor.js";
import { WriteQueue } from "../ingest/write-queue.js";
import type { StreamSimpleFn } from "../llm/stream.js";
import type {
  KnowledgeEntry,
  LlmClient,
  ParsedTranscript,
  TranscriptChunk,
} from "../types.js";
import { hashText } from "../db/store.js";
import { runIngestCommand } from "./ingest.js";
import type { IngestCommandDeps } from "./ingest.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
  vi.restoreAllMocks();
});

function fakeModel(): Model<Api> {
  return {
    id: "gpt-4.1-nano-test",
    name: "GPT 4.1 nano",
    api: "openai-chat",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

function fakeClient(): LlmClient {
  return {
    auth: "openai-api-key",
    resolvedModel: {
      provider: "openai",
      modelId: "gpt-4.1-nano-test",
      model: fakeModel(),
    },
    credentials: {
      apiKey: "test-api-key",
      source: "test",
    },
  };
}

function makeChunk(index: number): TranscriptChunk {
  return {
    chunk_index: index,
    message_start: index,
    message_end: index,
    text: `[m${String(index).padStart(5, "0")}][user] hello ${index}`,
    context_hint: `chunk ${index}`,
  };
}

function makeParsed(filePath: string): ParsedTranscript {
  return {
    file: filePath,
    messages: [],
    chunks: [makeChunk(0)],
    warnings: [],
  };
}

function assistantMessageWithToolEntries(
  entries: Array<Record<string, unknown>>,
  toolName = "submit_knowledge",
): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call_1",
        name: toolName,
        arguments: { entries },
      },
    ],
    api: "openai-chat",
    provider: "openai",
    model: "gpt-4.1-nano-test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function streamWithResult(
  result: Promise<AssistantMessage>,
  events: AssistantMessageEvent[] = [],
) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    result: () => result,
  };
}

function makeStreamSimple(message: AssistantMessage): StreamSimpleFn {
  return (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
    streamWithResult(Promise.resolve(message));
}

function makeIngestDeps(overrides: Partial<IngestCommandDeps> = {}): IngestCommandDeps {
  const db = { execute: vi.fn(async () => ({ rows: [] })) } as unknown as Client;
  return {
    readConfigFn:
      overrides.readConfigFn ??
      (vi.fn(() => ({ db: { path: ":memory:" } })) as IngestCommandDeps["readConfigFn"]),
    resolveEmbeddingApiKeyFn:
      overrides.resolveEmbeddingApiKeyFn ??
      (vi.fn(() => "sk-test") as IngestCommandDeps["resolveEmbeddingApiKeyFn"]),
    expandInputFilesFn:
      overrides.expandInputFilesFn ??
      (vi.fn(async (inputs: string[]) => inputs) as IngestCommandDeps["expandInputFilesFn"]),
    parseTranscriptFileFn:
      overrides.parseTranscriptFileFn ??
      (vi.fn(async (filePath: string) => makeParsed(filePath)) as IngestCommandDeps["parseTranscriptFileFn"]),
    createLlmClientFn:
      overrides.createLlmClientFn ??
      (vi.fn(() => fakeClient()) as IngestCommandDeps["createLlmClientFn"]),
    extractKnowledgeFromChunksFn:
      overrides.extractKnowledgeFromChunksFn ??
      (vi.fn(async (params) => {
        await params.onChunkComplete?.({
          chunkIndex: 0,
          totalChunks: 1,
          entries: [],
          warnings: [],
        });
        return { entries: [], successfulChunks: 1, failedChunks: 0, warnings: [] };
      }) as IngestCommandDeps["extractKnowledgeFromChunksFn"]),
    deduplicateEntriesFn:
      overrides.deduplicateEntriesFn ??
      (vi.fn((entries: KnowledgeEntry[]) => entries) as IngestCommandDeps["deduplicateEntriesFn"]),
    getDbFn:
      overrides.getDbFn ??
      (vi.fn(() => db) as IngestCommandDeps["getDbFn"]),
    initDbFn:
      overrides.initDbFn ??
      (vi.fn(async () => undefined) as IngestCommandDeps["initDbFn"]),
    closeDbFn:
      overrides.closeDbFn ??
      (vi.fn(() => undefined) as IngestCommandDeps["closeDbFn"]),
    storeEntriesFn:
      overrides.storeEntriesFn ??
      (vi.fn(async () => ({
        added: 0,
        updated: 0,
        skipped: 0,
        superseded: 0,
        llm_dedup_calls: 0,
        relations_created: 0,
        total_entries: 0,
        duration_ms: 0,
      })) as IngestCommandDeps["storeEntriesFn"]),
    hashTextFn: overrides.hashTextFn ?? hashText,
    loadWatchStateFn:
      overrides.loadWatchStateFn ??
      (vi.fn(async () => ({ version: 1 as const, files: {} })) as IngestCommandDeps["loadWatchStateFn"]),
    saveWatchStateFn:
      overrides.saveWatchStateFn ??
      (vi.fn(async () => undefined) as IngestCommandDeps["saveWatchStateFn"]),
    isWatcherRunningFn:
      overrides.isWatcherRunningFn ??
      (vi.fn(async () => false) as IngestCommandDeps["isWatcherRunningFn"]),
    readWatcherPidFn:
      overrides.readWatcherPidFn ??
      (vi.fn(async () => null) as IngestCommandDeps["readWatcherPidFn"]),
    resolveWatcherPidPathFn:
      overrides.resolveWatcherPidPathFn ??
      (vi.fn(() => "/tmp/agenr-test.pid") as IngestCommandDeps["resolveWatcherPidPathFn"]),
    nowFn: overrides.nowFn ?? (() => new Date("2026-02-25T10:00:00.000Z")),
    sleepFn:
      overrides.sleepFn ??
      (vi.fn(async () => undefined) as IngestCommandDeps["sleepFn"]),
    shouldShutdownFn:
      overrides.shouldShutdownFn ??
      (vi.fn(() => false) as IngestCommandDeps["shouldShutdownFn"]),
    createWriteQueueFn:
      overrides.createWriteQueueFn ??
      ((opts) => new WriteQueue(opts)),
    embedFn:
      overrides.embedFn ??
      (vi.fn(async () => [Array.from({ length: 1024 }, () => 0)]) as IngestCommandDeps["embedFn"]),
  };
}

describe("ingest debug logging", () => {
  it("writes input and output files when logDir is set", async () => {
    const dir = await makeTempDir("agenr-ingest-logging-");
    const logDir = path.join(dir, "logs");
    const result = await extractorTesting.extractChunkOnce({
      file: "/tmp/example/session.jsonl",
      chunk: makeChunk(0),
      model: fakeModel(),
      apiKey: "sk-test",
      systemPrompt: "System prompt for test",
      verbose: false,
      logDir,
      streamSimpleImpl: makeStreamSimple(
        assistantMessageWithToolEntries([
          {
            type: "fact",
            subject: "debug subject",
            content: "debug content with enough durable detail",
            importance: 7,
            expiry: "temporary",
            tags: ["ingest"],
            source_context: "ctx",
          },
        ]),
      ),
    });

    expect(result.entries).toHaveLength(1);
    const files = await fs.readdir(logDir);
    const inputFile = files.find((file) => /^ingest_.*_chunk0_input.txt$/.test(file));
    const outputFile = files.find((file) => /^ingest_.*_chunk0_output.txt$/.test(file));
    expect(inputFile).toBeDefined();
    expect(outputFile).toBeDefined();

    const inputBody = await fs.readFile(path.join(logDir, inputFile as string), "utf8");
    const outputBody = await fs.readFile(path.join(logDir, outputFile as string), "utf8");
    expect(inputBody).toContain("=== SYSTEM PROMPT ===");
    expect(inputBody).toContain("=== USER PROMPT ===");
    expect(inputBody).toContain("=== METADATA ===");
    expect(outputBody).toContain("=== RAW RESPONSE ===");
    expect(outputBody).toContain("=== EXTRACTED ENTRIES ===");
    expect(outputBody).toContain("=== WARNINGS ===");
    expect(outputBody).toContain("=== METADATA ===");
  });

  it("does not write files when logDir is not set", async () => {
    const mkdirSpy = vi.spyOn(fs, "mkdir");

    await extractorTesting.extractChunkOnce({
      file: "/tmp/example/no-log.jsonl",
      chunk: makeChunk(0),
      model: fakeModel(),
      apiKey: "sk-test",
      verbose: false,
      streamSimpleImpl: makeStreamSimple(
        assistantMessageWithToolEntries([
          {
            type: "fact",
            subject: "no log subject",
            content: "no log content with enough durable detail",
            importance: 7,
            expiry: "temporary",
            tags: ["ingest"],
            source_context: "ctx",
          },
        ]),
      ),
    });

    expect(mkdirSpy).not.toHaveBeenCalled();
  });

  it("respects sample rate in file processing", async () => {
    const dir = await makeTempDir("agenr-ingest-sample-rate-");
    const logDir = path.join(dir, "logs");
    const files = await Promise.all(
      ["a.txt", "b.txt", "c.txt", "d.txt"].map(async (name) => {
        const filePath = path.join(dir, name);
        await fs.writeFile(filePath, "x", "utf8");
        return filePath;
      }),
    );
    const seen: Array<{ file: string; logDir?: string }> = [];
    const extractKnowledgeFromChunksFn = vi.fn(async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
      seen.push({ file: params.file, logDir: params.logDir });
      await params.onChunkComplete?.({
        chunkIndex: 0,
        totalChunks: 1,
        entries: [],
        warnings: [],
      });
      return { entries: [], successfulChunks: 1, failedChunks: 0, warnings: [] };
    });

    const result = await runIngestCommand(
      [dir],
      { dryRun: true, workers: 1, logDir, sampleRate: 2 },
      makeIngestDeps({
        expandInputFilesFn: vi.fn(async () => files),
        extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(seen).toHaveLength(4);
    const loggedFiles = seen
      .filter((item) => item.logDir === logDir)
      .map((item) => path.basename(item.file));
    expect(loggedFiles).toEqual(["a.txt", "c.txt"]);
  });

  it("log-all sets sample rate to 1", async () => {
    const dir = await makeTempDir("agenr-ingest-log-all-");
    const logDir = path.join(dir, "logs");
    const files = await Promise.all(
      ["a.txt", "b.txt", "c.txt"].map(async (name) => {
        const filePath = path.join(dir, name);
        await fs.writeFile(filePath, "x", "utf8");
        return filePath;
      }),
    );
    const seen: Array<{ file: string; logDir?: string }> = [];
    const extractKnowledgeFromChunksFn = vi.fn(async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
      seen.push({ file: params.file, logDir: params.logDir });
      await params.onChunkComplete?.({
        chunkIndex: 0,
        totalChunks: 1,
        entries: [],
        warnings: [],
      });
      return { entries: [], successfulChunks: 1, failedChunks: 0, warnings: [] };
    });

    const result = await runIngestCommand(
      [dir],
      { dryRun: true, workers: 1, logDir, logAll: true, sampleRate: 50 },
      makeIngestDeps({
        expandInputFilesFn: vi.fn(async () => files),
        extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(seen).toHaveLength(3);
    expect(seen.every((item) => item.logDir === logDir)).toBe(true);
  });

  it("continues extraction when logDir is not writable", async () => {
    const dir = await makeTempDir("agenr-ingest-unwritable-");
    const blockedPath = path.join(dir, "blocked-path");
    await fs.writeFile(blockedPath, "not-a-directory", "utf8");

    const result = await extractorTesting.extractChunkOnce({
      file: "/tmp/example/unwritable.jsonl",
      chunk: makeChunk(0),
      model: fakeModel(),
      apiKey: "sk-test",
      verbose: false,
      logDir: blockedPath,
      streamSimpleImpl: makeStreamSimple(
        assistantMessageWithToolEntries([
          {
            type: "fact",
            subject: "blocked subject",
            content: "blocked content with enough durable detail",
            importance: 7,
            expiry: "temporary",
            tags: ["ingest"],
            source_context: "ctx",
          },
        ]),
      ),
    });

    expect(result.entries).toHaveLength(1);
  });

  it("writes dedup log after deduplication", async () => {
    const dir = await makeTempDir("agenr-ingest-dedup-log-");
    const logDir = path.join(dir, "logs");
    let extractCall = 0;
    const streamSimpleImpl: StreamSimpleFn = (_model: Model<Api>, context: Context) => {
      const prompt = String(context.messages[0]?.content ?? "");
      if (prompt.includes("Deduplicate these extracted knowledge entries.")) {
        return streamWithResult(
          Promise.resolve(
            assistantMessageWithToolEntries(
              [
                {
                  type: "fact",
                  subject: "merged subject",
                  content: "merged content with enough durable detail",
                  importance: 7,
                  expiry: "temporary",
                  tags: ["ingest"],
                  source_context: "dedup",
                },
              ],
              "submit_deduped_knowledge",
            ),
          ),
        );
      }

      extractCall += 1;
      return streamWithResult(
        Promise.resolve(
          assistantMessageWithToolEntries([
            {
              type: "fact",
              subject: "sample subject",
              content: `chunk content ${extractCall} with enough durable detail`,
              importance: 7,
              expiry: "temporary",
              tags: ["ingest"],
              source_context: `chunk ${extractCall}`,
            },
          ]),
        ),
      );
    };

    const result = await extractKnowledgeFromChunks({
      file: "/tmp/example/dedup.jsonl",
      chunks: [makeChunk(0), makeChunk(1)],
      client: fakeClient(),
      verbose: false,
      logDir,
      streamSimpleImpl,
      sleepImpl: async () => undefined,
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    const files = await fs.readdir(logDir);
    const dedupFile = files.find((file) => /^ingest_.*_dedup.txt$/.test(file));
    expect(dedupFile).toBeDefined();
    const dedupBody = await fs.readFile(path.join(logDir, dedupFile as string), "utf8");
    expect(dedupBody).toContain("=== PRE-DEDUP ENTRIES ===");
    expect(dedupBody).toContain("=== POST-DEDUP ENTRIES ===");
    expect(dedupBody).toContain("=== DEDUP METADATA ===");
  });
});
