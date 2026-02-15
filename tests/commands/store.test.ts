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
    relations_created: 0,
    total_entries: 1,
    duration_ms: 5,
  };
}

function makeEntry(): KnowledgeEntry {
  return {
    type: "fact",
    subject: "Jim",
    content: "Uses pnpm",
    confidence: "high",
    expiry: "permanent",
    tags: ["tooling"],
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
    await fs.writeFile(filePath, `${JSON.stringify([makeEntry()], null, 2)}\n`, "utf8");

    const storeEntriesSpy = vi.fn(async () => fakeStoreResult());

    const result = await runStoreCommand([filePath], {}, {
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
    expect(storeEntriesSpy.mock.calls[0]?.[1]).toHaveLength(1);
    expect(storeEntriesSpy.mock.calls[0]?.[1]?.[0]).toMatchObject({
      type: "fact",
      subject: "Jim",
      content: "Uses pnpm",
    });
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
    const storeEntriesSpy = vi.fn(async () => ({
      added: 0,
      updated: 0,
      skipped: 0,
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
    expect(storeEntriesSpy.mock.calls[0]?.[1]).toEqual([]);
    expect(resolveEmbeddingApiKeySpy).not.toHaveBeenCalled();
  });

  it("creates LLM client and passes classify options when classify=true", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-store-test-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "input.json");
    await fs.writeFile(filePath, `${JSON.stringify([makeEntry()], null, 2)}\n`, "utf8");

    const storeEntriesSpy = vi.fn(async () => fakeStoreResult());
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

    await runStoreCommand([filePath], { classify: true }, {
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
    expect(storeEntriesSpy.mock.calls[0]?.[3]).toMatchObject({
      classify: true,
      llmClient,
    });
  });
});
