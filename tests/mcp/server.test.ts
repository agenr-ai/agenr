import { PassThrough } from "node:stream";
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../../src/mcp/server.js";
import type { McpServerDeps } from "../../src/mcp/server.js";
import type { KnowledgeEntry, LlmClient, RecallResult, StoreResult, TranscriptChunk } from "../../src/types.js";

function makeLlmClient(): LlmClient {
  return {
    auth: "openai-api-key",
    resolvedModel: {
      provider: "openai",
      modelId: "gpt-4o",
      model: {
        id: "gpt-4o",
        name: "GPT-4o",
        api: "openai-chat",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    },
    credentials: {
      apiKey: "sk-test",
      source: "test",
    },
  };
}

function makeRecallResult(overrides?: Partial<RecallResult>): RecallResult {
  return {
    score: 0.847,
    scores: {
      vector: 0.9,
      recency: 0.8,
      confidence: 0.8,
      recall: 0.3,
      fts: 0,
    },
    entry: {
      id: "entry-1",
      type: "preference",
      subject: "Jim",
      content: "Jim follows a keto diet and has lost 55 lbs over 6 months.",
      confidence: "high",
      expiry: "temporary",
      scope: "personal",
      tags: ["diet"],
      source: { file: "chat-1", context: "test" },
      created_at: "2026-02-14T10:00:00.000Z",
      updated_at: "2026-02-14T10:00:00.000Z",
      recall_count: 0,
      confirmations: 0,
      contradictions: 0,
    },
    ...overrides,
  };
}

interface TestHarness {
  deps: Partial<McpServerDeps>;
  readConfigFn: ReturnType<typeof vi.fn>;
  resolveEmbeddingApiKeyFn: ReturnType<typeof vi.fn>;
  getDbFn: ReturnType<typeof vi.fn>;
  initDbFn: ReturnType<typeof vi.fn>;
  closeDbFn: ReturnType<typeof vi.fn>;
  recallFn: ReturnType<typeof vi.fn>;
  storeEntriesFn: ReturnType<typeof vi.fn>;
  parseTranscriptFileFn: ReturnType<typeof vi.fn>;
  extractKnowledgeFromChunksFn: ReturnType<typeof vi.fn>;
  mkdtempFn: ReturnType<typeof vi.fn>;
  writeFileFn: ReturnType<typeof vi.fn>;
  rmFn: ReturnType<typeof vi.fn>;
}

function makeHarness(): TestHarness {
  const db = {
    execute: vi.fn(async () => ({ rows: [] })),
    close: vi.fn(() => undefined),
  } as unknown as Client;

  const getDbFn = vi.fn(() => db);
  const initDbFn = vi.fn(async () => undefined);
  const closeDbFn = vi.fn(() => undefined);

  const recallFn = vi.fn(async () => [makeRecallResult()]);
  const storeEntriesFn = vi.fn(async () => {
    const result: StoreResult = {
      added: 1,
      updated: 0,
      skipped: 0,
      relations_created: 0,
      total_entries: 1,
      duration_ms: 1,
    };
    return result;
  });

  const parseTranscriptFileFn = vi.fn(async (filePath: string) => {
    const chunks: TranscriptChunk[] = [
      {
        chunk_index: 0,
        message_start: 0,
        message_end: 0,
        text: "sample",
        context_hint: "chunk 1",
      },
    ];
    return {
      file: filePath,
      messages: [],
      chunks,
      warnings: [],
    };
  });

  const extractKnowledgeFromChunksFn = vi.fn(async () => {
    const entries: KnowledgeEntry[] = [
      {
        type: "fact",
        subject: "Jim",
        content: "Jim uses pnpm, not npm or yarn.",
        confidence: "high",
        expiry: "permanent",
        tags: ["tooling"],
        source: { file: "temp", context: "test" },
      },
    ];
    return {
      entries,
      successfulChunks: 1,
      failedChunks: 0,
      warnings: [],
    };
  });

  const mkdtempFn = vi.fn(async () => "/tmp/agenr-mcp-test");
  const writeFileFn = vi.fn(async () => undefined);
  const rmFn = vi.fn(async () => undefined);
  const readConfigFn = vi.fn(() => ({ db: { path: ":memory:" } }));
  const resolveEmbeddingApiKeyFn = vi.fn(() => "sk-embed");

  return {
    deps: {
      readConfigFn,
      resolveEmbeddingApiKeyFn,
      createLlmClientFn: vi.fn(() => makeLlmClient()),
      getDbFn: getDbFn as unknown as McpServerDeps["getDbFn"],
      initDbFn,
      closeDbFn,
      recallFn,
      storeEntriesFn,
      parseTranscriptFileFn,
      extractKnowledgeFromChunksFn,
      mkdtempFn,
      writeFileFn,
      rmFn,
      nowFn: () => new Date("2026-02-15T00:00:00.000Z"),
      tmpdirFn: () => "/tmp",
    },
    readConfigFn,
    resolveEmbeddingApiKeyFn,
    getDbFn,
    initDbFn,
    closeDbFn,
    recallFn,
    storeEntriesFn,
    parseTranscriptFileFn,
    extractKnowledgeFromChunksFn,
    mkdtempFn,
    writeFileFn,
    rmFn,
  };
}

async function runServer(
  lines: string[],
  deps: Partial<McpServerDeps>,
): Promise<Array<Record<string, unknown>>> {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();

  let rawOutput = "";
  output.on("data", (chunk: Buffer | string) => {
    rawOutput += chunk.toString();
  });

  const server = createMcpServer(
    {
      input,
      output,
      errorOutput,
      serverVersion: "9.9.9-test",
    },
    deps,
  );

  const running = server.startServer();
  for (const line of lines) {
    input.write(`${line}\n`);
  }
  input.end();
  await running;

  return rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mcp server", () => {
  it("handles initialize handshake", async () => {
    const harness = makeHarness();
    const responses = await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "0.1.0" },
          },
        }),
      ],
      harness.deps,
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "agenr", version: "9.9.9-test" },
      },
    });
    expect(harness.initDbFn).not.toHaveBeenCalled();
  });

  it("lists all MCP tools with JSON schemas", async () => {
    const harness = makeHarness();
    const responses = await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
        }),
      ],
      harness.deps,
    );

    const result = responses[0]?.result as { tools?: Array<{ name: string; inputSchema?: { type?: string } }> };
    const toolNames = (result.tools ?? []).map((tool) => tool.name).sort();

    expect(toolNames).toEqual(["agenr_extract", "agenr_recall", "agenr_store"]);
    expect(result.tools?.every((tool) => tool.inputSchema?.type === "object")).toBe(true);
  });

  it("calls agenr_recall and formats results", async () => {
    const harness = makeHarness();
    const responses = await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "agenr_recall",
            arguments: {
              query: "Jim's diet",
              limit: 5,
              types: "preference,fact",
              threshold: 0.5,
            },
          },
        }),
      ],
      harness.deps,
    );

    const result = responses[0]?.result as { content?: Array<{ text?: string }> };
    expect(result.content?.[0]?.text).toContain(`Found 1 results for "Jim's diet":`);
    expect(harness.getDbFn).toHaveBeenCalledTimes(1);
    expect(harness.initDbFn).toHaveBeenCalledTimes(1);
    expect(harness.recallFn).toHaveBeenCalledTimes(1);

    const recallQuery = harness.recallFn.mock.calls[0]?.[1] as { text?: string; types?: string[]; limit?: number };
    expect(recallQuery.text).toBe("Jim's diet");
    expect(recallQuery.limit).toBe(5);
    expect(recallQuery.types).toEqual(["preference", "fact"]);
  });

  it("supports session-start context without query", async () => {
    const harness = makeHarness();
    const responses = await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 31,
          method: "tools/call",
          params: {
            name: "agenr_recall",
            arguments: {
              context: "session-start",
              limit: 3,
            },
          },
        }),
      ],
      harness.deps,
    );

    const result = responses[0]?.result as { content?: Array<{ text?: string }> };
    expect(result.content?.[0]?.text).toContain('Found 1 results for "session-start":');
    expect(harness.recallFn).toHaveBeenCalledTimes(1);

    const recallQuery = harness.recallFn.mock.calls[0]?.[1] as { text?: string; context?: string; limit?: number };
    expect(recallQuery.text).toBeUndefined();
    expect(recallQuery.context).toBe("session-start");
    expect(recallQuery.limit).toBe(3);
  });

  it("rejects recall when both query and context are omitted", async () => {
    const harness = makeHarness();
    const responses = await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 32,
          method: "tools/call",
          params: {
            name: "agenr_recall",
            arguments: {},
          },
        }),
      ],
      harness.deps,
    );

    expect(responses[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 32,
      error: {
        code: -32602,
        message: "query is required unless context is session-start",
      },
    });
  });

  it("does not resolve embedding API key for session-start context", async () => {
    const harness = makeHarness();
    const server = createMcpServer(
      {
        serverVersion: "9.9.9-test",
      },
      harness.deps,
    );

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 33,
      method: "tools/call",
      params: {
        name: "agenr_recall",
        arguments: {
          context: "session-start",
        },
      },
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 33,
    });
    expect(harness.resolveEmbeddingApiKeyFn).not.toHaveBeenCalled();
    await server.stop();
  });

  it("calls agenr_store and returns storage summary", async () => {
    const harness = makeHarness();
    harness.storeEntriesFn.mockResolvedValueOnce({
      added: 1,
      updated: 1,
      skipped: 0,
      relations_created: 0,
      total_entries: 2,
      duration_ms: 5,
    } satisfies StoreResult);

    const responses = await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "agenr_store",
            arguments: {
              entries: [
                {
                  type: "fact",
                  content: "Jim tracks macros and avoids carbs.",
                  confidence: 0.9,
                  source: "chat-1",
                  tags: ["diet", "health"],
                },
                {
                  type: "decision",
                  content: "Decided to continue keto through March.",
                },
              ],
            },
          },
        }),
      ],
      harness.deps,
    );

    const result = responses[0]?.result as { content?: Array<{ text?: string }> };
    expect(result.content?.[0]?.text).toBe("Stored 2 entries (1 new, 1 updated, 0 duplicates skipped).");
    expect(harness.storeEntriesFn).toHaveBeenCalledTimes(1);

    const storedEntries = harness.storeEntriesFn.mock.calls[0]?.[1] as KnowledgeEntry[];
    expect(storedEntries).toHaveLength(2);
    expect(storedEntries[0]?.scope).toBe("personal");
    expect(storedEntries[0]?.source.file).toBe("chat-1");
  });

  it("calls agenr_extract and optionally stores extracted entries", async () => {
    const harness = makeHarness();
    harness.extractKnowledgeFromChunksFn.mockResolvedValueOnce({
      entries: [
        {
          type: "fact",
          subject: "Jim",
          content: "Jim uses pnpm, not npm or yarn.",
          confidence: "high",
          expiry: "permanent",
          tags: ["tooling"],
          source: { file: "tmp", context: "ctx" },
        },
        {
          type: "lesson",
          subject: "Jim",
          content: "Do competitive research before building, not after.",
          confidence: "medium",
          expiry: "permanent",
          tags: ["process"],
          source: { file: "tmp", context: "ctx" },
        },
      ],
      successfulChunks: 1,
      failedChunks: 0,
      warnings: [],
    });
    harness.storeEntriesFn.mockResolvedValueOnce({
      added: 1,
      updated: 0,
      skipped: 1,
      relations_created: 0,
      total_entries: 3,
      duration_ms: 2,
    } satisfies StoreResult);

    const responses = await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "agenr_extract",
            arguments: {
              text: "Jim uses pnpm and prefers robust solutions.",
              store: true,
              source: "transcript-42",
            },
          },
        }),
      ],
      harness.deps,
    );

    const result = responses[0]?.result as { content?: Array<{ text?: string }> };
    expect(result.content?.[0]?.text).toContain("Extracted 2 entries from text:");
    expect(result.content?.[0]?.text).toContain("Stored: 1 new, 0 updated, 1 duplicates skipped.");
    expect(harness.mkdtempFn).toHaveBeenCalledTimes(1);
    expect(harness.writeFileFn).toHaveBeenCalledTimes(1);
    expect(harness.parseTranscriptFileFn).toHaveBeenCalledTimes(1);
    expect(harness.extractKnowledgeFromChunksFn).toHaveBeenCalledTimes(1);
    expect(harness.storeEntriesFn).toHaveBeenCalledTimes(1);
    expect(harness.rmFn).toHaveBeenCalledTimes(1);

    const storedEntries = harness.storeEntriesFn.mock.calls[0]?.[1] as KnowledgeEntry[];
    expect(storedEntries[0]?.source.file).toBe("transcript-42");
  });

  it("handles parse errors, unknown methods, and invalid params", async () => {
    const harness = makeHarness();
    const responses = await runServer(
      [
        "not json",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 6,
          method: "unknown/method",
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "agenr_recall",
            arguments: {},
          },
        }),
      ],
      harness.deps,
    );

    expect(responses[0]).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700 },
    });
    expect(responses[1]).toMatchObject({
      jsonrpc: "2.0",
      id: 6,
      error: { code: -32601 },
    });
    expect(responses[2]).toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32602 },
    });
  });

  it("responds to ping with an empty object", async () => {
    const harness = makeHarness();
    const responses = await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 8,
          method: "ping",
        }),
      ],
      harness.deps,
    );

    expect(responses[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 8,
      result: {},
    });
  });

  it("handles multiple sequential requests and reuses lazy DB init", async () => {
    const harness = makeHarness();
    const responses = await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "0.1.0" },
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: {
            name: "agenr_recall",
            arguments: { query: "diet" },
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: {
            name: "agenr_store",
            arguments: {
              entries: [{ type: "fact", content: "Jim tracks macros." }],
            },
          },
        }),
      ],
      harness.deps,
    );

    expect(responses).toHaveLength(3);
    expect(responses[0]?.id).toBe(9);
    expect(responses[1]?.id).toBe(10);
    expect(responses[2]?.id).toBe(11);
    expect(harness.getDbFn).toHaveBeenCalledTimes(1);
    expect(harness.initDbFn).toHaveBeenCalledTimes(1);
    expect(harness.closeDbFn).toHaveBeenCalledTimes(1);
  });

  it("shuts down cleanly on stdin EOF", async () => {
    const harness = makeHarness();
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    let rawOutput = "";
    output.on("data", (chunk: Buffer | string) => {
      rawOutput += chunk.toString();
    });

    const server = createMcpServer(
      {
        input,
        output,
        errorOutput,
        serverVersion: "9.9.9-test",
      },
      harness.deps,
    );

    const running = server.startServer();
    input.end();
    await running;

    expect(rawOutput.trim()).toBe("");
    expect(harness.getDbFn).not.toHaveBeenCalled();
  });
});
