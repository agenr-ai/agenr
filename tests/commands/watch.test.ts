import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWatchCommand } from "../../src/commands/watch.js";
import type { KnowledgeEntry } from "../../src/types.js";
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
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("watch command", () => {
  it("wires CLI options into runWatchCommand", async () => {
    const runWatchCommandMock = vi.fn(async (..._args: unknown[]) => ({ exitCode: 0 }));
    vi.doMock("../../src/commands/watch.js", () => ({
      runWatchCommand: runWatchCommandMock,
    }));
    const { createProgram } = await import("../../src/cli.js");
    const program = createProgram();

    await program.parseAsync([
      "node",
      "agenr",
      "watch",
      "/tmp/session.jsonl",
      "--interval",
      "7",
      "--min-chunk",
      "1500",
      "--db",
      "/tmp/db.sqlite",
      "--model",
      "gpt-4o",
      "--provider",
      "openai",
      "--classify",
      "--verbose",
      "--dry-run",
      "--once",
      "--json",
    ]);

    expect(runWatchCommandMock).toHaveBeenCalledTimes(1);
    const firstCall = (runWatchCommandMock.mock.calls as unknown[][])[0] as [string, Record<string, unknown>] | undefined;
    expect(firstCall?.[0]).toBe("/tmp/session.jsonl");
    expect(firstCall?.[1]).toMatchObject({
      interval: "7",
      minChunk: "1500",
      db: "/tmp/db.sqlite",
      model: "gpt-4o",
      provider: "openai",
      classify: true,
      verbose: true,
      dryRun: true,
      once: true,
      json: true,
    });
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
        extractKnowledgeFromChunksFn: vi.fn(async () => ({
          entries: [makeEntry()],
          successfulChunks: 1,
          failedChunks: 0,
          warnings: [],
        })),
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
});
