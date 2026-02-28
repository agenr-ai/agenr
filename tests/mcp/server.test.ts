import { PassThrough } from "node:stream";
import fs from "node:fs/promises";
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../../src/mcp/server.js";
import type { McpServerDeps } from "../../src/mcp/server.js";
import type {
  KnowledgeEntry,
  LlmClient,
  ParsedTranscript,
  RecallResult,
  TranscriptChunk,
} from "../../src/types.js";
import { parseSince, parseSinceToIso } from "../../src/utils/time.js";
import { createScopedProjectConfig } from "../helpers/scoped-config.js";

const tempDirs: string[] = [];

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
  const recentIso = new Date(Date.now() - 60_000).toISOString();
  return {
    score: 0.847,
    scores: {
      vector: 0.9,
      recency: 0.8,
      importance: 0.8,
      recall: 0.3,
      freshness: 1,
      todoPenalty: 1,
      fts: 0,
      spacing: 1,
      quality: 0.5,
    },
    entry: {
      id: "entry-1",
      type: "preference",
      subject: "Jim",
      content: "Jim follows a keto diet and has lost 55 lbs over 6 months.",
      importance: 8,
      expiry: "temporary",
      scope: "personal",
      tags: ["diet"],
      source: { file: "chat-1", context: "test" },
      created_at: recentIso,
      updated_at: recentIso,
      recall_count: 0,
      confirmations: 0,
      contradictions: 0,
      quality_score: 0.5,
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
  updateRecallMetadataFn: ReturnType<typeof vi.fn>;
  retireEntriesFn: ReturnType<typeof vi.fn>;
  parseTranscriptFileFn: ReturnType<typeof vi.fn>;
  extractKnowledgeFromChunksFn: ReturnType<typeof vi.fn>;
  mkdtempFn: ReturnType<typeof vi.fn>;
  writeFileFn: ReturnType<typeof vi.fn>;
  rmFn: ReturnType<typeof vi.fn>;
  dbExecute: ReturnType<typeof vi.fn>;
}

function makeHarness(): TestHarness {
  const dbExecute = vi.fn(async (statement: string | { sql?: string; args?: unknown[] }) => {
    const sql = typeof statement === "string" ? statement : statement.sql ?? "";
    const args = typeof statement === "string" ? [] : Array.isArray(statement.args) ? statement.args : [];
    if (sql.includes("FROM entries") && args[0] === "entry-1") {
      return { rows: [{ id: "entry-1", subject: "Jim", type: "preference", importance: 8 }] };
    }
    return { rows: [] };
  });

  const db = {
    execute: dbExecute,
    close: vi.fn(() => undefined),
  } as unknown as Client;

  const getDbFn = vi.fn(() => db);
  const initDbFn = vi.fn(async () => undefined);
  const closeDbFn = vi.fn(() => undefined);

  const recallFn = vi.fn(async () => [makeRecallResult()]);
  const updateRecallMetadataFn = vi.fn(async () => undefined);
  const retireEntriesFn = vi.fn(async () => ({ count: 1 }));

  const parseTranscriptFileFn = vi.fn(async (filePath: string): Promise<ParsedTranscript> => {
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
      messages: [
        {
          index: 0,
          role: "user",
          text: "sample",
        },
      ],
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
        importance: 8,
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
      updateRecallMetadataFn,
      retireEntriesFn,
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
    updateRecallMetadataFn,
    retireEntriesFn,
    parseTranscriptFileFn,
    extractKnowledgeFromChunksFn,
    mkdtempFn,
    writeFileFn,
    rmFn,
    dbExecute,
  };
}

async function runServer(
  lines: string[],
  deps: Partial<McpServerDeps>,
  options?: { env?: NodeJS.ProcessEnv },
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
      env: options?.env ?? { ...process.env, AGENR_PROJECT_DIR: "" },
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

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("mcp server", () => {
  it("uses the shared since parser implementation", () => {
    const now = new Date("2026-02-15T00:00:00.000Z");
    const inputs = ["1h", "7d", "1m", "1y", "2026-02-01T00:00:00.000Z"];

    for (const input of inputs) {
      const parsed = parseSince(input, now);
      expect(parsed).toBeTruthy();
      expect(parseSinceToIso(input, now)).toBe(parsed?.toISOString());
    }

    expect(() => parseSinceToIso("not-a-duration", now)).toThrow("Invalid date value");
  });

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

    expect(toolNames).toEqual(["agenr_extract", "agenr_recall", "agenr_retire"]);
    expect(result.tools?.every((tool) => tool.inputSchema?.type === "object")).toBe(true);
  });

  it("does not expose since_seq in agenr_recall tool schema", async () => {
    const harness = makeHarness();
    const responses = await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 201,
          method: "tools/list",
        }),
      ],
      harness.deps,
    );

    const result = responses[0]?.result as {
      tools?: Array<{
        name: string;
        inputSchema?: {
          properties?: Record<string, unknown>;
        };
      }>;
    };
    const recallTool = (result.tools ?? []).find((tool) => tool.name === "agenr_recall");
    expect(recallTool?.inputSchema?.properties).not.toHaveProperty("since_seq");
    const contextProperty = recallTool?.inputSchema?.properties?.context as { enum?: string[] } | undefined;
    expect(contextProperty?.enum).toContain("browse");
    const extractTool = (result.tools ?? []).find((tool) => tool.name === "agenr_extract");
    expect(extractTool?.inputSchema?.properties).not.toHaveProperty("store");
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
              platform: "openclaw",
            },
          },
        }),
      ],
      harness.deps,
    );

    const result = responses[0]?.result as { content?: Array<{ text?: string }> };
    expect(result.content?.[0]?.text).toContain(`Found 1 results for "Jim's diet":`);
    expect(result.content?.[0]?.text).toContain("[id=entry-1]");
    expect(harness.getDbFn).toHaveBeenCalledTimes(1);
    expect(harness.initDbFn).toHaveBeenCalledTimes(1);
    expect(harness.recallFn).toHaveBeenCalledTimes(1);

    const recallQuery = harness.recallFn.mock.calls[0]?.[1] as {
      text?: string;
      types?: string[];
      limit?: number;
      platform?: string;
    };
    expect(recallQuery.text).toBe("Jim's diet");
    expect(recallQuery.limit).toBe(5);
    expect(recallQuery.types).toEqual(["preference", "fact"]);
    expect(recallQuery.platform).toBe("openclaw");
  });

  it("forwards until to recall queries", async () => {
    const harness = makeHarness();
    await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 203,
          method: "tools/call",
          params: {
            name: "agenr_recall",
            arguments: {
              query: "Jim's diet",
              until: "7d",
            },
          },
        }),
      ],
      harness.deps,
    );

    expect(harness.recallFn).toHaveBeenCalledTimes(1);
    const recallQuery = harness.recallFn.mock.calls[0]?.[1] as { until?: string };
    const expectedIso = new Date("2026-02-08T00:00:00.000Z").getTime();
    const actualIso = new Date(String(recallQuery.until)).getTime();
    expect(Math.abs(actualIso - expectedIso)).toBeLessThanOrEqual(1000);
  });

  it("passes around to recall query when provided", async () => {
    const harness = makeHarness();
    await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 204,
          method: "tools/call",
          params: {
            name: "agenr_recall",
            arguments: {
              query: "Jim's diet",
              around: "7d",
            },
          },
        }),
      ],
      harness.deps,
    );

    expect(harness.recallFn).toHaveBeenCalledTimes(1);
    const recallQuery = harness.recallFn.mock.calls[0]?.[1] as { around?: string };
    const expectedIso = new Date("2026-02-08T00:00:00.000Z").getTime();
    const actualIso = new Date(String(recallQuery.around)).getTime();
    expect(Math.abs(actualIso - expectedIso)).toBeLessThanOrEqual(1000);
  });

  it("passes aroundRadius to recall query when provided", async () => {
    const harness = makeHarness();
    await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 205,
          method: "tools/call",
          params: {
            name: "agenr_recall",
            arguments: {
              query: "Jim's diet",
              aroundRadius: 21,
            },
          },
        }),
      ],
      harness.deps,
    );

    expect(harness.recallFn).toHaveBeenCalledTimes(1);
    const recallQuery = harness.recallFn.mock.calls[0]?.[1] as { aroundRadius?: number };
    expect(recallQuery.aroundRadius).toBe(21);
  });

  it("throws RpcError for invalid around value", async () => {
    const harness = makeHarness();
    const responses = await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 206,
          method: "tools/call",
          params: {
            name: "agenr_recall",
            arguments: {
              query: "Jim's diet",
              around: "not-a-date",
            },
          },
        }),
      ],
      harness.deps,
    );

    expect(responses[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 206,
      error: {
        code: -32602,
        message: "Invalid around value",
      },
    });
  });

  it("ignores since_seq parameter without error", async () => {
    const harness = makeHarness();
    const responses = await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 202,
          method: "tools/call",
          params: {
            name: "agenr_recall",
            arguments: {
              query: "test",
              since_seq: 0,
              limit: 5,
            },
          },
        }),
      ],
      harness.deps,
    );

    expect(responses[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 202,
      result: expect.any(Object),
    });
    expect(responses[0]).not.toHaveProperty("error");
  });

  it("passes project filter through agenr_recall when provided", async () => {
    const harness = makeHarness();
    await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 34,
          method: "tools/call",
          params: {
            name: "agenr_recall",
            arguments: {
              query: "Jim's diet",
              project: "agenr,openclaw",
            },
          },
        }),
      ],
      harness.deps,
    );

    expect(harness.recallFn).toHaveBeenCalledTimes(1);
    const recallQuery = harness.recallFn.mock.calls[0]?.[1] as { project?: string[] };
    expect(recallQuery.project).toEqual(["agenr", "openclaw"]);
  });

  it("uses two-pass session-start recall and returns grouped ordering", async () => {
    const harness = makeHarness();
    harness.recallFn.mockImplementation(async (_db: unknown, query: { expiry?: string | string[] }) => {
      if (query.expiry === "core") {
        return [
          makeRecallResult({
            score: 0.95,
            entry: {
              ...makeRecallResult().entry,
              id: "core-1",
              content: "Core profile",
              expiry: "core",
              type: "fact",
            },
          }),
        ];
      }

      if (Array.isArray(query.expiry)) {
        return [
          makeRecallResult({
            score: 0.5,
            entry: {
              ...makeRecallResult().entry,
              id: "pref-1",
              type: "preference",
              content: "Preference note",
              expiry: "permanent",
            },
          }),
          makeRecallResult({
            score: 0.99,
            entry: {
              ...makeRecallResult().entry,
              id: "recent-1",
              type: "event",
              content: "Recent event",
              expiry: "temporary",
            },
          }),
          makeRecallResult({
            score: 0.4,
            entry: {
              ...makeRecallResult().entry,
              id: "todo-1",
              type: "todo",
              content: "Active todo",
              expiry: "temporary",
            },
          }),
        ];
      }

      return [];
    });

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
              limit: 10,
            },
          },
        }),
      ],
      harness.deps,
    );

    const result = responses[0]?.result as { content?: Array<{ text?: string }> };
    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain('Found 4 results for "session-start":');
    expect(harness.recallFn).toHaveBeenCalledTimes(2);

    const firstCallQuery = harness.recallFn.mock.calls[0]?.[1] as { expiry?: string; limit?: number; noUpdate?: boolean };
    expect(firstCallQuery.expiry).toBe("core");
    expect(firstCallQuery.limit).toBe(5000);
    expect(firstCallQuery.noUpdate).toBe(true);

    const secondCallQuery = harness.recallFn.mock.calls[1]?.[1] as { expiry?: string | string[]; limit?: number; noUpdate?: boolean };
    expect(Array.isArray(secondCallQuery.expiry)).toBe(true);
    expect((secondCallQuery.expiry as string[]).sort().join(",")).toBe("permanent,temporary");
    expect(secondCallQuery.limit).toBe(500);
    expect(secondCallQuery.noUpdate).toBe(true);

    const activePos = text.indexOf("Active todo");
    const preferencePos = text.indexOf("Preference note");
    const recentPos = text.indexOf("Recent event");
    expect(activePos).toBeGreaterThan(-1);
    expect(preferencePos).toBeGreaterThan(activePos);
    expect(recentPos).toBeGreaterThan(preferencePos);
  });

  it("updates recall metadata only for returned session-start results", async () => {
    const harness = makeHarness();
    harness.recallFn.mockImplementation(async (_db: unknown, query: { expiry?: string | string[] }) => {
      if (query.expiry === "core") {
        return [
          makeRecallResult({
            score: 0.9,
            entry: {
              ...makeRecallResult().entry,
              id: "core-1",
              content: "Core profile",
              expiry: "core",
              type: "fact",
            },
          }),
        ];
      }

      if (Array.isArray(query.expiry)) {
        return [
          makeRecallResult({
            score: 0.8,
            entry: {
              ...makeRecallResult().entry,
              id: "todo-1",
              type: "todo",
              content: "Selected todo",
            },
          }),
          makeRecallResult({
            score: 0.79,
            entry: {
              ...makeRecallResult().entry,
              id: "todo-2",
              type: "todo",
              content: "Non-selected todo",
            },
          }),
          makeRecallResult({
            score: 0.78,
            entry: {
              ...makeRecallResult().entry,
              id: "recent-1",
              type: "event",
              content: "Non-selected recent",
            },
          }),
        ];
      }

      return [];
    });

    await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 311,
          method: "tools/call",
          params: {
            name: "agenr_recall",
            arguments: {
              context: "session-start",
              limit: 1,
            },
          },
        }),
      ],
      harness.deps,
    );

    expect(harness.updateRecallMetadataFn).toHaveBeenCalledTimes(1);
    const updatedIds = harness.updateRecallMetadataFn.mock.calls[0]?.[1] as string[] | undefined;
    expect(updatedIds).toEqual(["core-1", "todo-1"]);
    expect(updatedIds).not.toContain("todo-2");
    expect(updatedIds).not.toContain("recent-1");
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
        message: "query is required unless context is session-start or browse",
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

  it("supports context=browse without query", async () => {
    const harness = makeHarness();
    const responses = await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3301,
          method: "tools/call",
          params: {
            name: "agenr_recall",
            arguments: {
              context: "browse",
            },
          },
        }),
      ],
      harness.deps,
    );

    const result = responses[0]?.result as { content?: Array<{ text?: string }> };
    expect(result.content?.[0]?.text).toContain("browse mode");
    expect(result.content?.[0]?.text).toMatch(/Found \d+ entries/);
  });

  it("passes since filter through context=browse recall", async () => {
    const harness = makeHarness();
    await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3302,
          method: "tools/call",
          params: {
            name: "agenr_recall",
            arguments: {
              context: "browse",
              since: "1d",
            },
          },
        }),
      ],
      harness.deps,
    );

    expect(harness.recallFn).toHaveBeenCalledTimes(1);
    const recallQuery = harness.recallFn.mock.calls[0]?.[1] as { browse?: boolean; since?: string };
    expect(recallQuery.browse).toBe(true);
    expect(recallQuery.since).toBe("2026-02-14T00:00:00.000Z");
  });

  it("does not resolve embedding API key for context=browse", async () => {
    const harness = makeHarness();
    harness.resolveEmbeddingApiKeyFn.mockImplementation(() => {
      throw new Error("should not be called");
    });

    const server = createMcpServer(
      {
        serverVersion: "9.9.9-test",
      },
      harness.deps,
    );

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 3303,
      method: "tools/call",
      params: {
        name: "agenr_recall",
        arguments: {
          context: "browse",
        },
      },
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 3303,
    });
    expect(harness.resolveEmbeddingApiKeyFn).not.toHaveBeenCalled();
    await server.stop();
  });

  it("does not update recall metadata for context=browse", async () => {
    const harness = makeHarness();
    await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3304,
          method: "tools/call",
          params: {
            name: "agenr_recall",
            arguments: {
              context: "browse",
            },
          },
        }),
      ],
      harness.deps,
    );

    expect(harness.updateRecallMetadataFn).not.toHaveBeenCalled();
  });

  it("keeps default-context query requirement for backward compatibility", async () => {
    const harness = makeHarness();
    const responses = await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3305,
          method: "tools/call",
          params: {
            name: "agenr_recall",
            arguments: {
              context: "default",
            },
          },
        }),
      ],
      harness.deps,
    );

    expect(responses[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 3305,
      error: {
        code: -32602,
        message: "query is required unless context is session-start or browse",
      },
    });
  });

  it("agenr_recall uses project scope from AGENR_PROJECT_DIR when project is omitted", async () => {
    const harness = makeHarness();
    const scopedDir = await createScopedProjectConfig({ project: "frontend" }, { tempDirs, prefix: "agenr-mcp-scope-" });

    await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 35,
          method: "tools/call",
          params: {
            name: "agenr_recall",
            arguments: {
              query: "Jim's diet",
            },
          },
        }),
      ],
      harness.deps,
      { env: { ...process.env, AGENR_PROJECT_DIR: scopedDir } },
    );

    const recallQuery = harness.recallFn.mock.calls[0]?.[1] as { project?: string[]; projectStrict?: boolean };
    expect(recallQuery.project).toEqual(["frontend"]);
    expect(recallQuery.projectStrict).toBe(true);
  });

  it("agenr_recall includes dependency projects from scoped config", async () => {
    const harness = makeHarness();
    const scopedDir = await createScopedProjectConfig(
      {
        project: "frontend",
        dependencies: ["api-service", "shared-lib"],
      },
      { tempDirs, prefix: "agenr-mcp-scope-" },
    );

    await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 36,
          method: "tools/call",
          params: {
            name: "agenr_recall",
            arguments: {
              query: "contracts",
            },
          },
        }),
      ],
      harness.deps,
      { env: { ...process.env, AGENR_PROJECT_DIR: scopedDir } },
    );

    const recallQuery = harness.recallFn.mock.calls[0]?.[1] as { project?: string[]; projectStrict?: boolean };
    expect(recallQuery.project).toEqual(["frontend", "api-service", "shared-lib"]);
    expect(recallQuery.projectStrict).toBe(true);
  });

  it("agenr_recall project='*' bypasses scoped project filtering", async () => {
    const harness = makeHarness();
    const scopedDir = await createScopedProjectConfig(
      {
        project: "frontend",
        dependencies: ["api-service"],
      },
      { tempDirs, prefix: "agenr-mcp-scope-" },
    );

    await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 37,
          method: "tools/call",
          params: {
            name: "agenr_recall",
            arguments: {
              query: "anything",
              project: "*",
            },
          },
        }),
      ],
      harness.deps,
      { env: { ...process.env, AGENR_PROJECT_DIR: scopedDir } },
    );

    const recallQuery = harness.recallFn.mock.calls[0]?.[1] as { project?: string[]; projectStrict?: boolean };
    expect(recallQuery.project).toBeUndefined();
    expect(recallQuery.projectStrict).toBeUndefined();
  });

  it("agenr_recall explicit project ignores configured dependencies", async () => {
    const harness = makeHarness();
    const scopedDir = await createScopedProjectConfig(
      {
        project: "frontend",
        dependencies: ["api-service", "shared-lib"],
      },
      { tempDirs, prefix: "agenr-mcp-scope-" },
    );

    await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 38,
          method: "tools/call",
          params: {
            name: "agenr_recall",
            arguments: {
              query: "contracts",
              project: "analytics",
            },
          },
        }),
      ],
      harness.deps,
      { env: { ...process.env, AGENR_PROJECT_DIR: scopedDir } },
    );

    const recallQuery = harness.recallFn.mock.calls[0]?.[1] as { project?: string[]; projectStrict?: boolean };
    expect(recallQuery.project).toEqual(["analytics"]);
    expect(recallQuery.projectStrict).toBe(true);
  });

  it("agenr_recall remains global when AGENR_PROJECT_DIR is not set", async () => {
    const harness = makeHarness();

    await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 40,
          method: "tools/call",
          params: {
            name: "agenr_recall",
            arguments: {
              query: "Jim",
            },
          },
        }),
      ],
      harness.deps,
      { env: { ...process.env, AGENR_PROJECT_DIR: "" } },
    );

    const recallQuery = harness.recallFn.mock.calls[0]?.[1] as { project?: string[]; projectStrict?: boolean };
    expect(recallQuery.project).toBeUndefined();
    expect(recallQuery.projectStrict).toBeUndefined();
  });

  it("logs warning when AGENR_PROJECT_DIR is not set", async () => {
    const harness = makeHarness();
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    let rawError = "";
    errorOutput.on("data", (chunk: Buffer | string) => {
      rawError += chunk.toString();
    });

    const server = createMcpServer(
      {
        input,
        output,
        errorOutput,
        serverVersion: "9.9.9-test",
        env: { ...process.env, AGENR_PROJECT_DIR: "" },
      },
      harness.deps,
    );

    const running = server.startServer();
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 41,
        method: "tools/call",
        params: {
          name: "agenr_recall",
          arguments: {
            query: "Jim",
          },
        },
      })}\n`,
    );
    input.end();
    await running;

    expect(rawError).toContain(
      "warn: AGENR_PROJECT_DIR not set -- recall will return global (unscoped) results. Run agenr init to configure project scoping.",
    );
  });

  it("keeps stdout JSON-RPC clean when diagnostics are written to stderr", async () => {
    const harness = makeHarness();
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    let rawOutput = "";
    output.on("data", (chunk: Buffer | string) => {
      rawOutput += chunk.toString();
    });

    harness.extractKnowledgeFromChunksFn.mockImplementationOnce(async () => {
      console.error("[contradiction] diagnostic test line");
      return {
        entries: [],
        successfulChunks: 1,
        failedChunks: 0,
        warnings: [],
      };
    });

    const server = createMcpServer(
      {
        input,
        output,
        errorOutput,
        serverVersion: "9.9.9-test",
        env: { ...process.env, AGENR_PROJECT_DIR: "" },
      },
      harness.deps,
    );

    const running = server.startServer();
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: {
          name: "agenr_extract",
          arguments: {
            text: "diagnostic text",
          },
        },
      })}\n`,
    );
    input.end();
    await running;

    const lines = rawOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("agenr_retire with valid entry_id retires entry and returns success message", async () => {
    const harness = makeHarness();
    const responses = await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1001,
          method: "tools/call",
          params: {
            name: "agenr_retire",
            arguments: {
              entry_id: "entry-1",
              reason: "stale",
            },
          },
        }),
      ],
      harness.deps,
    );

    const result = responses[0]?.result as { content?: Array<{ text?: string }>; isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect(result.content?.[0]?.text).toContain("Retired: Jim (type: preference).");
    expect(harness.retireEntriesFn).toHaveBeenCalledTimes(1);
    expect(harness.retireEntriesFn.mock.calls[0]?.[0]).toMatchObject({
      entryId: "entry-1",
      reason: "stale",
      writeLedger: false,
    });
  });

  it("agenr_retire with persist=true includes re-ingest note", async () => {
    const harness = makeHarness();
    const responses = await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1002,
          method: "tools/call",
          params: {
            name: "agenr_retire",
            arguments: {
              entry_id: "entry-1",
              reason: "obsolete project",
              persist: true,
            },
          },
        }),
      ],
      harness.deps,
    );

    const result = responses[0]?.result as { content?: Array<{ text?: string }>; isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect(result.content?.[0]?.text).toContain("Retirement will survive database re-ingest.");
    expect(harness.retireEntriesFn.mock.calls[0]?.[0]).toMatchObject({
      entryId: "entry-1",
      writeLedger: true,
    });
  });

  it("agenr_retire with invalid entry_id returns a JSON-RPC error", async () => {
    const harness = makeHarness();
    const responses = await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1003,
          method: "tools/call",
          params: {
            name: "agenr_retire",
            arguments: {
              entry_id: "missing-id",
            },
          },
        }),
      ],
      harness.deps,
    );

    expect(responses[0]).toMatchObject({
      error: {
        code: -32602,
        message: "No active entry found with id: missing-id",
      },
    });
    expect(harness.retireEntriesFn).not.toHaveBeenCalled();
  });

  it("retired entries are excluded from agenr_recall", async () => {
    const harness = makeHarness();
    harness.recallFn.mockResolvedValueOnce([]);
    const responses = await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1004,
          method: "tools/call",
          params: {
            name: "agenr_retire",
            arguments: {
              entry_id: "entry-1",
            },
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1005,
          method: "tools/call",
          params: {
            name: "agenr_recall",
            arguments: {
              query: "Jim",
            },
          },
        }),
      ],
      harness.deps,
    );

    const retireResult = responses[0]?.result as { isError?: boolean };
    expect(retireResult.isError).not.toBe(true);

    const recallResult = responses[1]?.result as { content?: Array<{ text?: string }> };
    expect(recallResult.content?.[0]?.text).toContain('Found 0 results for "Jim".');
  });

  it("calls agenr_extract and returns extracted entries", async () => {
    const harness = makeHarness();
    harness.extractKnowledgeFromChunksFn.mockResolvedValueOnce({
      entries: [
        {
          type: "fact",
          subject: "Jim",
          content: "Jim uses pnpm, not npm or yarn.",
          importance: 8,
          expiry: "permanent",
          tags: ["tooling"],
          source: { file: "tmp", context: "ctx" },
        },
        {
          type: "lesson",
          subject: "Jim",
          content: "Do competitive research before building, not after.",
          importance: 6,
          expiry: "permanent",
          tags: ["process"],
          source: { file: "tmp", context: "ctx" },
        },
      ],
      successfulChunks: 1,
      failedChunks: 0,
      warnings: [],
    });

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
              source: "transcript-42",
            },
          },
        }),
      ],
      harness.deps,
    );

    const result = responses[0]?.result as { content?: Array<{ text?: string }> };
    expect(result.content?.[0]?.text).toContain("Extracted 2 entries from text:");
    expect(harness.mkdtempFn).toHaveBeenCalledTimes(1);
    expect(harness.writeFileFn).toHaveBeenCalledTimes(1);
    expect(harness.parseTranscriptFileFn).toHaveBeenCalledTimes(1);
    expect(harness.extractKnowledgeFromChunksFn).toHaveBeenCalledTimes(1);
    expect(harness.extractKnowledgeFromChunksFn.mock.calls[0]?.[0]?.messages).toHaveLength(1);
    expect(harness.rmFn).toHaveBeenCalledTimes(1);
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
            name: "agenr_retire",
            arguments: {
              entry_id: "entry-1",
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
