import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runIngestCommand } from "../../src/commands/ingest.js";
import { hashText } from "../../src/db/store.js";
import { expandInputFiles } from "../../src/parser.js";
import type { IngestCommandDeps } from "../../src/commands/ingest.js";
import type { KnowledgeEntry, ParsedTranscript } from "../../src/types.js";

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
      (vi.fn(async () => ({
        entries: [makeEntry("one"), makeEntry("two")],
        successfulChunks: 1,
        failedChunks: 0,
        warnings: [],
      })) as IngestCommandDeps["extractKnowledgeFromChunksFn"]),
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
        relations_created: 0,
        total_entries: entries.length,
        duration_ms: 5,
      })) as IngestCommandDeps["storeEntriesFn"]),
    batchClassifyFn: overrides?.batchClassifyFn ?? (vi.fn(async () => undefined) as IngestCommandDeps["batchClassifyFn"]),
    hashTextFn: overrides?.hashTextFn ?? hashText,
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
    ingestCommand?.action(runIngestCommandMock as (...args: unknown[]) => unknown);

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
      "--classify",
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
      classify: true,
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

  it("streams extraction chunks through callback and stores each chunk incrementally", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "a.txt");
    await fs.writeFile(filePath, "hello", "utf8");

    const deduplicateEntriesFn = vi.fn((entries: KnowledgeEntry[]) => entries.slice(0, 1));
    const storeEntriesFn = vi.fn(async (_db: unknown, entries: KnowledgeEntry[]) => ({
      added: entries.length,
      updated: 0,
      skipped: 0,
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
      {},
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

  it("runs post-file batch classification when classify mode is enabled", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "a.txt");
    await fs.writeFile(filePath, "hello", "utf8");

    const storeEntriesFn = vi.fn(async (_db: unknown, entries: KnowledgeEntry[], _apiKey: string, options?: any) => {
      options?.onDecision?.({
        entry: entries[0],
        action: "added",
        reason: "new entry",
        similarity: 0.85,
        matchedEntryId: "old-1",
        newEntryId: "new-1",
        sameSubject: true,
        matchedEntry: {
          id: "old-1",
          type: "fact",
          subject: entries[0]?.subject ?? "Jim",
          content: "existing",
          importance: 8,
          expiry: "temporary",
          tags: [],
          source: { file: "source", context: "ctx" },
          created_at: "2026-02-15T00:00:00.000Z",
          updated_at: "2026-02-15T00:00:00.000Z",
          recall_count: 0,
          confirmations: 0,
          contradictions: 0,
        },
      });
      return {
        added: entries.length,
        updated: 0,
        skipped: 0,
        relations_created: 0,
        total_entries: entries.length,
        duration_ms: 5,
      };
    });
    const batchClassifyFn = vi.fn(async (..._args: unknown[]) => undefined);

    await runIngestCommand(
      [dir],
      { classify: true },
      makeDeps({
        expandInputFilesFn: vi.fn(async () => [filePath]),
        deduplicateEntriesFn: vi.fn((entries: KnowledgeEntry[]) => entries.slice(0, 1)),
        storeEntriesFn: storeEntriesFn as IngestCommandDeps["storeEntriesFn"],
        batchClassifyFn: batchClassifyFn as IngestCommandDeps["batchClassifyFn"],
      }),
    );

    expect(batchClassifyFn).toHaveBeenCalledTimes(1);
    const candidates = ((batchClassifyFn.mock.calls as unknown[][])[0]?.[2] ?? []) as Array<{
      similarity: number;
      newEntry?: { id?: string };
      matchEntry?: { id?: string };
    }>;
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates[0]?.similarity).toBe(0.85);
    expect(candidates[0]?.newEntry?.id).toBe("new-1");
    expect(candidates[0]?.matchEntry?.id).toBe("old-1");
  });

  it("handles missing files gracefully", async () => {
    const missing = path.join("/tmp", "agenr-ingest-missing-file.txt");
    const deps = makeDeps();

    const result = await runIngestCommand([missing], {}, deps);

    expect(result.exitCode).toBe(1);
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

    const extractKnowledgeFromChunksFn = vi.fn(async ({ file }: { file: string }) => {
      if (file === badFile) {
        throw new Error("timeout");
      }
      return {
        entries: [makeEntry("ok")],
        successfulChunks: 1,
        failedChunks: 0,
        warnings: [],
      };
    });

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

    const extractKnowledgeFromChunksFn = vi.fn(async ({ file }: { file: string }) => {
      if (file === fail) {
        throw new Error("extract failed");
      }
      return {
        entries: [makeEntry("one"), makeEntry("two"), makeEntry("three")],
        successfulChunks: 1,
        failedChunks: 0,
        warnings: [],
      };
    });

    const deduplicateEntriesFn = vi.fn((entries: KnowledgeEntry[]) => entries.slice(0, 2));
    const storeEntriesFn = vi.fn(async () => ({
      added: 1,
      updated: 1,
      skipped: 0,
      relations_created: 0,
      total_entries: 2,
      duration_ms: 3,
    }));

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
    expect(result.totalEntriesStored).toBe(2);
    expect(result.exitCode).toBe(1);
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
});
