import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import { createEmptyWatchState, loadWatchState, saveWatchState, updateFileState } from "../../src/watch/state.js";
import { readFileFromOffset } from "../../src/watch/watcher.js";

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
    nowFn: overrides?.nowFn ?? (() => new Date("2026-02-15T00:00:00.000Z")),
  };
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
  vi.restoreAllMocks();
});

describe("ingest command", () => {
  it("wires CLI options into runIngestCommand", async () => {
    const { createProgram } = await import("../../src/cli.js");
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
      "--skip-ingested",
      "--force",
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
      concurrency: "3",
      skipIngested: true,
      force: true,
    });
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
        {},
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
    const extractKnowledgeFromChunksFn = vi.fn(
      async (params: Parameters<IngestCommandDeps["extractKnowledgeFromChunksFn"]>[0]) => {
        await params.onChunkComplete?.({
          chunkIndex: 0,
          totalChunks: 1,
          entries: [makeEntry("first"), makeEntry("force-embed-fail")],
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

    const failStoreEntriesFn: IngestCommandDeps["storeEntriesFn"] = async (client, entries, apiKey, options) =>
      storeEntries(client, entries, apiKey, {
        ...options,
        embedFn: async (texts: string[]) => {
          if (texts.some((text) => text.includes("force-embed-fail"))) {
            throw new Error("OpenAI embeddings request failed (500)");
          }
          return texts.map(() => to1024([1, 0, 0]));
        },
      });
    const successStoreEntriesFn: IngestCommandDeps["storeEntriesFn"] = async (client, entries, apiKey, options) =>
      storeEntries(client, entries, apiKey, {
        ...options,
        embedFn: async (texts: string[]) => texts.map(() => to1024([1, 0, 0])),
      });

    try {
      const sharedDeps = {
        getDbFn: vi.fn(() => db) as IngestCommandDeps["getDbFn"],
        initDbFn: vi.fn(async () => initDb(db)),
        closeDbFn: vi.fn(() => undefined),
        createLlmClientFn: vi.fn(() => fakeLlmClient()) as IngestCommandDeps["createLlmClientFn"],
        expandInputFilesFn: vi.fn(async () => [filePath]),
        extractKnowledgeFromChunksFn: extractKnowledgeFromChunksFn as IngestCommandDeps["extractKnowledgeFromChunksFn"],
        deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries),
        resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
      };

      const firstRun = await runIngestCommand(
        [filePath],
        {},
        makeDeps({
          ...sharedDeps,
          storeEntriesFn: failStoreEntriesFn,
        }),
      );

      expect(firstRun.exitCode).toBe(2);
      expect(firstRun.filesProcessed).toBe(0);
      expect(firstRun.filesSkipped).toBe(0);
      expect(firstRun.filesFailed).toBe(1);

      const secondRun = await runIngestCommand(
        [filePath],
        {},
        makeDeps({
          ...sharedDeps,
          storeEntriesFn: successStoreEntriesFn,
        }),
      );

      expect(secondRun.exitCode).toBe(0);
      expect(secondRun.filesProcessed).toBe(1);
      expect(secondRun.filesSkipped).toBe(0);
      expect(secondRun.filesFailed).toBe(0);

      const ingestRows = await db.execute({
        sql: "SELECT COUNT(*) AS count FROM ingest_log WHERE file_path = ?",
        args: [filePath],
      });
      expect(Number(ingestRows.rows[0]?.count)).toBe(1);
      expect(extractKnowledgeFromChunksFn).toHaveBeenCalledTimes(2);
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
    expect(parseTranscriptFileFn).toHaveBeenCalledWith(md);
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
    expect(parseTranscriptFileFn).toHaveBeenCalledWith(rootMd);
    expect(parseTranscriptFileFn).toHaveBeenCalledWith(rootTxt);
    expect(parseTranscriptFileFn).toHaveBeenCalledWith(nestedMd);
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
    expect(parseTranscriptFileFn).toHaveBeenCalledWith(rootMd);
    expect(parseTranscriptFileFn).toHaveBeenCalledWith(nestedMd);
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
      { concurrency: "1" },
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
    expect(output).toContain("Done: 1 succeeded, 1 failed, 1 skipped (already ingested)");
    expect(output).toContain("Failed files (will auto-retry on next run):");
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
      },
    );

    expect(watchResult.exitCode).toBe(0);
    expect(readOffsets[0]).toBe(Buffer.byteLength(initialContent, "utf8"));
  });
});
