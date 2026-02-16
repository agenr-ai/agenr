import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeConfig } from "../src/config.js";
import { runExtractCommand } from "../src/cli.js";
import type { CliDeps } from "../src/cli.js";
import type { LlmClient, ParsedTranscript } from "../src/types.js";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

async function setupConfigEnv(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-cli-config-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "config.json");
  process.env.AGENR_CONFIG_PATH = configPath;
  writeConfig(
    {
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-5.2-codex",
    },
    process.env,
  );
  process.env.OPENAI_API_KEY = "sk-test-openai";
}

function fakeClient(): LlmClient {
  return {
    auth: "anthropic-api-key",
    resolvedModel: {
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      model: {
        id: "claude-opus-4-6",
        name: "Claude Opus",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    },
    credentials: { apiKey: "test", source: "test" },
  };
}

function parsedTranscript(file: string): ParsedTranscript {
  return {
    file,
    messages: [{ index: 0, role: "user", text: "hi" }],
    chunks: [
      {
        chunk_index: 0,
        message_start: 0,
        message_end: 0,
        text: "[m00000][user] hi",
        context_hint: "hi",
      },
    ],
    warnings: [],
  };
}

describe("runExtractCommand", () => {
  it("fails when provider/model are missing", async () => {
    const deps: Partial<CliDeps> = {
      expandInputFilesFn: vi.fn().mockResolvedValue(["/tmp/a.jsonl"]),
      assertReadableFileFn: vi.fn().mockResolvedValue(undefined),
      createLlmClientFn: vi.fn(() => {
        throw new Error("Not configured. Run `agenr setup`.");
      }) as unknown as CliDeps["createLlmClientFn"],
    };

    await expect(
      runExtractCommand(["/tmp/a.jsonl"], { format: "json" }, deps),
    ).rejects.toThrow("Not configured. Run `agenr setup`.");
  });

  it("keeps file outputs isolated (no cross-file dedup)", async () => {
    let capturedReport: unknown;

    const deps: Partial<CliDeps> = {
      expandInputFilesFn: vi.fn().mockResolvedValue(["/tmp/a.jsonl", "/tmp/b.jsonl"]),
      assertReadableFileFn: vi.fn().mockResolvedValue(undefined),
      createLlmClientFn: vi.fn().mockReturnValue(fakeClient()) as unknown as CliDeps["createLlmClientFn"],
      parseTranscriptFileFn: vi.fn((file: string) => Promise.resolve(parsedTranscript(file))) as unknown as CliDeps["parseTranscriptFileFn"],
      extractKnowledgeFromChunksFn: vi.fn((_params) =>
        Promise.resolve({
          entries: [
            {
              type: "fact",
              content: "Jim prefers pnpm",
              subject: "Jim",
              importance: 8,
              expiry: "permanent",
              tags: ["tooling"],
              source: { file: "x", context: "m" },
            },
          ],
          successfulChunks: 1,
          failedChunks: 0,
          warnings: [],
        }),
      ) as unknown as CliDeps["extractKnowledgeFromChunksFn"],
      writeOutputFn: vi.fn(({ report }) => {
        capturedReport = report;
        return Promise.resolve([]);
      }) as unknown as CliDeps["writeOutputFn"],
    };

    const result = await runExtractCommand(
      ["/tmp/a.jsonl", "/tmp/b.jsonl"],
      {
        format: "json",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      deps,
    );

    expect(result.exitCode).toBe(0);
    expect((capturedReport as { summary: { deduped_entries: number } }).summary.deduped_entries).toBe(2);
    expect(Object.keys((capturedReport as { files: Record<string, unknown> }).files)).toHaveLength(2);
  });

  it("returns exit 1 when all chunks fail", async () => {
    const deps: Partial<CliDeps> = {
      expandInputFilesFn: vi.fn().mockResolvedValue(["/tmp/a.jsonl"]),
      assertReadableFileFn: vi.fn().mockResolvedValue(undefined),
      createLlmClientFn: vi.fn().mockReturnValue(fakeClient()) as unknown as CliDeps["createLlmClientFn"],
      parseTranscriptFileFn: vi.fn((file: string) => Promise.resolve(parsedTranscript(file))) as unknown as CliDeps["parseTranscriptFileFn"],
      extractKnowledgeFromChunksFn: vi.fn((_params) =>
        Promise.resolve({
          entries: [],
          successfulChunks: 0,
          failedChunks: 1,
          warnings: ["chunk failed"],
        }),
      ) as unknown as CliDeps["extractKnowledgeFromChunksFn"],
      writeOutputFn: vi.fn(() => Promise.resolve([])) as unknown as CliDeps["writeOutputFn"],
    };

    const result = await runExtractCommand(
      ["/tmp/a.jsonl"],
      {
        format: "json",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      deps,
    );

    expect(result.exitCode).toBe(1);
  });

  it("enforces split mode output directory requirement", async () => {
    const deps: Partial<CliDeps> = {
      expandInputFilesFn: vi.fn().mockResolvedValue(["/tmp/a.jsonl"]),
      assertReadableFileFn: vi.fn().mockResolvedValue(undefined),
      createLlmClientFn: vi.fn().mockReturnValue(fakeClient()) as unknown as CliDeps["createLlmClientFn"],
      parseTranscriptFileFn: vi.fn((file: string) => Promise.resolve(parsedTranscript(file))) as unknown as CliDeps["parseTranscriptFileFn"],
      extractKnowledgeFromChunksFn: vi.fn((_params) =>
        Promise.resolve({
          entries: [],
          successfulChunks: 1,
          failedChunks: 0,
          warnings: [],
        }),
      ) as unknown as CliDeps["extractKnowledgeFromChunksFn"],
    };

    await expect(
      runExtractCommand(
        ["/tmp/a.jsonl"],
        {
          format: "json",
          provider: "anthropic",
          model: "claude-opus-4-6",
          split: true,
        },
        deps,
      ),
    ).rejects.toThrow("--split requires --output");
  });

  it("reads provider/model from config when flags are omitted", async () => {
    await setupConfigEnv();
    let capturedReport: unknown;

    const deps: Partial<CliDeps> = {
      expandInputFilesFn: vi.fn().mockResolvedValue(["/tmp/a.jsonl"]),
      assertReadableFileFn: vi.fn().mockResolvedValue(undefined),
      parseTranscriptFileFn: vi.fn((file: string) => Promise.resolve(parsedTranscript(file))) as unknown as CliDeps["parseTranscriptFileFn"],
      extractKnowledgeFromChunksFn: vi.fn((_params) =>
        Promise.resolve({
          entries: [],
          successfulChunks: 1,
          failedChunks: 0,
          warnings: [],
        }),
      ) as unknown as CliDeps["extractKnowledgeFromChunksFn"],
      writeOutputFn: vi.fn(({ report }) => {
        capturedReport = report;
        return Promise.resolve([]);
      }) as unknown as CliDeps["writeOutputFn"],
    };

    const result = await runExtractCommand(["/tmp/a.jsonl"], { format: "json" }, deps);
    expect(result.exitCode).toBe(0);
    expect((capturedReport as { provider: string }).provider).toBe("openai");
    expect((capturedReport as { model: string }).model).toBe("gpt-5.2-codex");
  });

  it("lets CLI flags override config model", async () => {
    await setupConfigEnv();
    let capturedReport: unknown;

    const deps: Partial<CliDeps> = {
      expandInputFilesFn: vi.fn().mockResolvedValue(["/tmp/a.jsonl"]),
      assertReadableFileFn: vi.fn().mockResolvedValue(undefined),
      parseTranscriptFileFn: vi.fn((file: string) => Promise.resolve(parsedTranscript(file))) as unknown as CliDeps["parseTranscriptFileFn"],
      extractKnowledgeFromChunksFn: vi.fn((_params) =>
        Promise.resolve({
          entries: [],
          successfulChunks: 1,
          failedChunks: 0,
          warnings: [],
        }),
      ) as unknown as CliDeps["extractKnowledgeFromChunksFn"],
      writeOutputFn: vi.fn(({ report }) => {
        capturedReport = report;
        return Promise.resolve([]);
      }) as unknown as CliDeps["writeOutputFn"],
    };

    const result = await runExtractCommand(
      ["/tmp/a.jsonl"],
      {
        format: "json",
        provider: "openai",
        model: "gpt-4o",
      },
      deps,
    );

    expect(result.exitCode).toBe(0);
    expect((capturedReport as { model: string }).model).toBe("gpt-4o");
  });

  it("wires verbose extraction callbacks in verbose mode", async () => {
    const extractSpy = vi.fn((_params) =>
      Promise.resolve({
        entries: [],
        successfulChunks: 1,
        failedChunks: 0,
        warnings: [],
      }),
    );

    const deps: Partial<CliDeps> = {
      expandInputFilesFn: vi.fn().mockResolvedValue(["/tmp/a.jsonl"]),
      assertReadableFileFn: vi.fn().mockResolvedValue(undefined),
      createLlmClientFn: vi.fn().mockReturnValue(fakeClient()) as unknown as CliDeps["createLlmClientFn"],
      parseTranscriptFileFn: vi.fn((file: string) => Promise.resolve(parsedTranscript(file))) as unknown as CliDeps["parseTranscriptFileFn"],
      extractKnowledgeFromChunksFn: extractSpy as unknown as CliDeps["extractKnowledgeFromChunksFn"],
      writeOutputFn: vi.fn(() => Promise.resolve([])) as unknown as CliDeps["writeOutputFn"],
    };

    await runExtractCommand(
      ["/tmp/a.jsonl"],
      {
        format: "json",
        provider: "anthropic",
        model: "claude-opus-4-6",
        verbose: true,
      },
      deps,
    );

    expect(extractSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        verbose: true,
        onVerbose: expect.any(Function),
        onStreamDelta: expect.any(Function),
      }),
    );
  });

  it("skips stream callbacks in non-verbose mode", async () => {
    const extractSpy = vi.fn((_params) =>
      Promise.resolve({
        entries: [],
        successfulChunks: 1,
        failedChunks: 0,
        warnings: [],
      }),
    );

    const deps: Partial<CliDeps> = {
      expandInputFilesFn: vi.fn().mockResolvedValue(["/tmp/a.jsonl"]),
      assertReadableFileFn: vi.fn().mockResolvedValue(undefined),
      createLlmClientFn: vi.fn().mockReturnValue(fakeClient()) as unknown as CliDeps["createLlmClientFn"],
      parseTranscriptFileFn: vi.fn((file: string) => Promise.resolve(parsedTranscript(file))) as unknown as CliDeps["parseTranscriptFileFn"],
      extractKnowledgeFromChunksFn: extractSpy as unknown as CliDeps["extractKnowledgeFromChunksFn"],
      writeOutputFn: vi.fn(() => Promise.resolve([])) as unknown as CliDeps["writeOutputFn"],
    };

    await runExtractCommand(
      ["/tmp/a.jsonl"],
      {
        format: "json",
        provider: "anthropic",
        model: "claude-opus-4-6",
        verbose: false,
      },
      deps,
    );

    expect(extractSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        verbose: false,
      }),
    );
    expect(extractSpy.mock.calls[0]?.[0]?.onVerbose).toBeUndefined();
    expect(extractSpy.mock.calls[0]?.[0]?.onStreamDelta).toBeUndefined();
  });

  it("passes noDedup through to extractor params", async () => {
    const extractSpy = vi.fn((_params) =>
      Promise.resolve({
        entries: [],
        successfulChunks: 1,
        failedChunks: 0,
        warnings: [],
      }),
    );

    const deps: Partial<CliDeps> = {
      expandInputFilesFn: vi.fn().mockResolvedValue(["/tmp/a.jsonl"]),
      assertReadableFileFn: vi.fn().mockResolvedValue(undefined),
      createLlmClientFn: vi.fn().mockReturnValue(fakeClient()) as unknown as CliDeps["createLlmClientFn"],
      parseTranscriptFileFn: vi.fn((file: string) => Promise.resolve(parsedTranscript(file))) as unknown as CliDeps["parseTranscriptFileFn"],
      extractKnowledgeFromChunksFn: extractSpy as unknown as CliDeps["extractKnowledgeFromChunksFn"],
      writeOutputFn: vi.fn(() => Promise.resolve([])) as unknown as CliDeps["writeOutputFn"],
    };

    await runExtractCommand(
      ["/tmp/a.jsonl"],
      {
        format: "json",
        provider: "anthropic",
        model: "claude-opus-4-6",
        noDedup: true,
      },
      deps,
    );

    expect(extractSpy.mock.calls[0]?.[0]?.noDedup).toBe(true);
  });
});

describe("cli entrypoint", () => {
  it("uses pathToFileURL for direct-run detection", async () => {
    const source = await fs.readFile(path.resolve("src/cli.ts"), "utf8");
    expect(source).toContain('import { pathToFileURL } from "node:url";');
    expect(source).toContain("import.meta.url === pathToFileURL(process.argv[1]).href");
  });
});
