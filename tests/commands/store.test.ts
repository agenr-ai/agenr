import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runStoreCommand } from "../../src/commands/store.js";
import type { AgenrConfig, KnowledgeEntry, LlmClient, StoreResult } from "../../src/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
  vi.restoreAllMocks();
});

function fakeStoreResult(): StoreResult {
  return {
    added: 1,
    updated: 0,
    skipped: 0,
    superseded: 0,
    llm_dedup_calls: 0,
    relations_created: 0,
    total_entries: 1,
    duration_ms: 5,
  };
}

function makeEntry(createdAt?: string): KnowledgeEntry {
  return {
    type: "fact",
    subject: "Jim",
    content: "Uses pnpm",
    importance: 8,
    expiry: "permanent",
    tags: ["tooling"],
    created_at: createdAt,
    source: {
      file: "fixture.json",
      context: "test",
    },
  };
}

describe("store command", () => {
  it("parses JSON input file and forwards entries to store pipeline", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-store-test-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "input.json");
    await fs.writeFile(filePath, `${JSON.stringify([makeEntry("2026-02-01T10:00:00.000Z")], null, 2)}\n`, "utf8");

    const storeEntriesSpy = vi.fn(async (..._args: unknown[]) => fakeStoreResult());

    const result = await runStoreCommand([filePath], { onlineDedup: false }, {
      expandInputFilesFn: vi.fn(async (inputs: string[]) => inputs),
      readFileFn: vi.fn((target: string) => fs.readFile(target, "utf8")),
      readStdinFn: vi.fn(async () => ""),
      readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } } satisfies AgenrConfig)),
      resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
      getDbFn: vi.fn(() => ({}) as any),
      initDbFn: vi.fn(async () => undefined),
      closeDbFn: vi.fn(() => undefined),
      storeEntriesFn: storeEntriesSpy as any,
    });

    expect(result.exitCode).toBe(0);
    expect(storeEntriesSpy).toHaveBeenCalledTimes(1);
    const firstCall = (storeEntriesSpy.mock.calls as unknown[][])[0] as [unknown, KnowledgeEntry[]] | undefined;
    expect(firstCall?.[1]).toHaveLength(1);
    expect(firstCall?.[1]?.[0]).toMatchObject({
      type: "fact",
      subject: "Jim",
      content: "Uses pnpm",
      created_at: "2026-02-01T10:00:00.000Z",
    });
  });

  it("tags stored entries with --platform when provided", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-store-test-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "input.json");
    await fs.writeFile(filePath, `${JSON.stringify([makeEntry()], null, 2)}\n`, "utf8");

    const storeEntriesSpy = vi.fn(async (..._args: unknown[]) => fakeStoreResult());

    await runStoreCommand([filePath], { onlineDedup: false, platform: "openclaw" }, {
      expandInputFilesFn: vi.fn(async (inputs: string[]) => inputs),
      readFileFn: vi.fn((target: string) => fs.readFile(target, "utf8")),
      readStdinFn: vi.fn(async () => ""),
      readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } } satisfies AgenrConfig)),
      resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
      getDbFn: vi.fn(() => ({}) as any),
      initDbFn: vi.fn(async () => undefined),
      closeDbFn: vi.fn(() => undefined),
      storeEntriesFn: storeEntriesSpy as any,
    });

    const firstCall = (storeEntriesSpy.mock.calls as unknown[][])[0] as [unknown, KnowledgeEntry[]] | undefined;
    expect(firstCall?.[1]?.[0]?.platform).toBe("openclaw");
  });

  it("handles missing file with a clear error", async () => {
    await expect(
      runStoreCommand(["/tmp/does-not-exist.json"], {}, {
        expandInputFilesFn: vi.fn(async (inputs: string[]) => inputs),
        readFileFn: vi.fn(async () => {
          throw new Error("ENOENT: no such file or directory");
        }),
        readStdinFn: vi.fn(async () => ""),
      }),
    ).rejects.toThrow("Failed to read input file");
  });

  it("handles empty input arrays gracefully", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-store-test-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "empty.json");
    await fs.writeFile(filePath, "[]\n", "utf8");

    const resolveEmbeddingApiKeySpy = vi.fn(() => "sk-test");
    const storeEntriesSpy = vi.fn(async (..._args: unknown[]) => ({
      added: 0,
      updated: 0,
      skipped: 0,
      superseded: 0,
      llm_dedup_calls: 0,
      relations_created: 0,
      total_entries: 0,
      duration_ms: 1,
    }));

    const result = await runStoreCommand([filePath], {}, {
      expandInputFilesFn: vi.fn(async (inputs: string[]) => inputs),
      readFileFn: vi.fn((target: string) => fs.readFile(target, "utf8")),
      readStdinFn: vi.fn(async () => ""),
      readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } } satisfies AgenrConfig)),
      resolveEmbeddingApiKeyFn: resolveEmbeddingApiKeySpy,
      getDbFn: vi.fn(() => ({}) as any),
      initDbFn: vi.fn(async () => undefined),
      closeDbFn: vi.fn(() => undefined),
      storeEntriesFn: storeEntriesSpy as any,
    });

    expect(result.exitCode).toBe(0);
    expect(storeEntriesSpy).toHaveBeenCalledTimes(1);
    const emptyCall = (storeEntriesSpy.mock.calls as unknown[][])[0] as [unknown, KnowledgeEntry[]] | undefined;
    expect(emptyCall?.[1]).toEqual([]);
    expect(resolveEmbeddingApiKeySpy).not.toHaveBeenCalled();
  });

  it("creates LLM client and passes onlineDedup options when enabled", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-store-test-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "input.json");
    await fs.writeFile(filePath, `${JSON.stringify([makeEntry()], null, 2)}\n`, "utf8");

    const storeEntriesSpy = vi.fn(async (..._args: unknown[]) => fakeStoreResult());
    const llmClient: LlmClient = {
      auth: "openai-api-key",
      resolvedModel: {
        provider: "openai",
        modelId: "gpt-4o",
        model: {} as any,
      },
      credentials: { apiKey: "x", source: "test" },
    };
    const createLlmClientFn = vi.fn(() => llmClient);

    await runStoreCommand([filePath], { onlineDedup: true, dedupThreshold: 0.75 }, {
      expandInputFilesFn: vi.fn(async (inputs: string[]) => inputs),
      readFileFn: vi.fn((target: string) => fs.readFile(target, "utf8")),
      readStdinFn: vi.fn(async () => ""),
      readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } } satisfies AgenrConfig)),
      resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
      createLlmClientFn,
      getDbFn: vi.fn(() => ({}) as any),
      initDbFn: vi.fn(async () => undefined),
      closeDbFn: vi.fn(() => undefined),
      storeEntriesFn: storeEntriesSpy as any,
    });

    expect(createLlmClientFn).toHaveBeenCalledTimes(1);
    expect(storeEntriesSpy).toHaveBeenCalledTimes(1);
    const dedupCall = (storeEntriesSpy.mock.calls as unknown[][])[0] as
      | [unknown, unknown, unknown, Record<string, unknown>]
      | undefined;
    expect(dedupCall?.[3]).toMatchObject({
      onlineDedup: true,
      dedupThreshold: 0.75,
      llmClient,
    });
  });
});
