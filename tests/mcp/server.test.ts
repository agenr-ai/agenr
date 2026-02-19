import { PassThrough } from "node:stream";
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initDb } from "../../src/db/client.js";
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
      importance: 0.8,
      recall: 0.3,
      freshness: 1,
      todoPenalty: 1,
      fts: 0,
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
  updateRecallMetadataFn: ReturnType<typeof vi.fn>;
  storeEntriesFn: ReturnType<typeof vi.fn>;
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
  const storeEntriesFn = vi.fn(async () => {
    const result: StoreResult = {
      added: 1,
      updated: 0,
      skipped: 0,
      superseded: 0,
      llm_dedup_calls: 0,
      relations_created: 0,
      total_entries: 1,
      duration_ms: 1,
    };
    return result;
  });
  const retireEntriesFn = vi.fn(async () => ({ count: 1 }));

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
      storeEntriesFn,
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
    storeEntriesFn,
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

async function seedTodo(client: Client, params: { id: string; subject: string; content: string; importance?: number }): Promise<void> {
  const now = "2026-02-14T00:00:00.000Z";
  await client.execute({
    sql: `
      INSERT INTO entries (
        id, type, subject, content, importance, expiry, scope, source_file, source_context, created_at, updated_at
      )
      VALUES (?, 'todo', ?, ?, ?, 'temporary', 'private', 'seed.jsonl', 'test', ?, ?)
    `,
    args: [params.id, params.subject, params.content, params.importance ?? 5, now, now],
  });
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

    expect(toolNames).toEqual(["agenr_extract", "agenr_recall", "agenr_retire", "agenr_store"]);
    expect(result.tools?.every((tool) => tool.inputSchema?.type === "object")).toBe(true);
  });

  it("agenr_done with confirm=true marks matching todo as done", async () => {
    const harness = makeHarness();
    const client = createClient({ url: ":memory:" });
    await initDb(client);
    await seedTodo(client, { id: "todo-1", subject: "fix client test", content: "Fix flaky test", importance: 9 });

    harness.deps.getDbFn = vi.fn(() => client) as unknown as McpServerDeps["getDbFn"];
    harness.deps.initDbFn = vi.fn(async () => undefined);
    harness.deps.closeDbFn = vi.fn(() => undefined);

    const server = createMcpServer({ serverVersion: "9.9.9-test" }, harness.deps);
    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 200,
      method: "tools/call",
      params: {
        name: "agenr_done",
        arguments: {
          subject: "fix client test",
          confirm: true,
        },
      },
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 200,
      result: {
        content: [{ type: "text", text: "Marked done: fix client test" }],
      },
    });

    const row = await client.execute({
      sql: "SELECT superseded_by FROM entries WHERE id = ?",
      args: ["todo-1"],
    });
    expect(String(row.rows[0]?.superseded_by)).toBe("todo-1");

    await server.stop();
    client.close();
  });

  it("agenr_done with confirm=false and multiple matches returns candidates without mutation", async () => {
    const harness = makeHarness();
    const client = createClient({ url: ":memory:" });
    await initDb(client);
    await seedTodo(client, { id: "todo-1", subject: "fix client test", content: "Fix flaky test", importance: 9 });
    await seedTodo(client, { id: "todo-2", subject: "fix client auth", content: "Fix auth flow", importance: 8 });

    harness.deps.getDbFn = vi.fn(() => client) as unknown as McpServerDeps["getDbFn"];
    harness.deps.initDbFn = vi.fn(async () => undefined);
    harness.deps.closeDbFn = vi.fn(() => undefined);

    const server = createMcpServer({ serverVersion: "9.9.9-test" }, harness.deps);
    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 201,
      method: "tools/call",
      params: {
        name: "agenr_done",
        arguments: {
          subject: "client",
        },
      },
    });

    const result = (response as { result?: { content?: Array<{ text?: string }> } }).result;
    const text = result?.content?.[0]?.text ?? "";
    expect(text).toContain('Multiple active todos match "client":');
    expect(text).toContain("fix client test");
    expect(text).toContain("fix client auth");

    const rows = await client.execute({
      sql: "SELECT id, superseded_by FROM entries WHERE id IN ('todo-1', 'todo-2') ORDER BY id ASC",
      args: [],
    });
    expect(rows.rows[0]?.superseded_by).toBeNull();
    expect(rows.rows[1]?.superseded_by).toBeNull();

    await server.stop();
    client.close();
  });

  it("agenr_done with no match returns tool error payload", async () => {
    const harness = makeHarness();
    const client = createClient({ url: ":memory:" });
    await initDb(client);
    await seedTodo(client, { id: "todo-1", subject: "fix client test", content: "Fix flaky test" });

    harness.deps.getDbFn = vi.fn(() => client) as unknown as McpServerDeps["getDbFn"];
    harness.deps.initDbFn = vi.fn(async () => undefined);
    harness.deps.closeDbFn = vi.fn(() => undefined);

    const server = createMcpServer({ serverVersion: "9.9.9-test" }, harness.deps);
    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 202,
      method: "tools/call",
      params: {
        name: "agenr_done",
        arguments: {
          subject: "nonexistent",
        },
      },
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 202,
      result: {
        content: [{ type: "text", text: "No active todo matching: nonexistent" }],
        isError: true,
      },
    });

    await server.stop();
    client.close();
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
      superseded: 0,
      llm_dedup_calls: 2,
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
                  importance: 9,
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
    const storeOptions = harness.storeEntriesFn.mock.calls[0]?.[3] as { onlineDedup?: boolean; llmClient?: unknown } | undefined;
    expect(storeOptions?.onlineDedup).toBe(true);
    expect(storeOptions?.llmClient).toBeTruthy();

    const storedEntries = harness.storeEntriesFn.mock.calls[0]?.[1] as KnowledgeEntry[];
    expect(storedEntries).toHaveLength(2);
    expect(storedEntries[0]?.scope).toBe("personal");
    expect(storedEntries[0]?.source.file).toBe("chat-1");
  });

  it("agenr_store tags entries with platform when provided", async () => {
    const harness = makeHarness();
    harness.storeEntriesFn.mockResolvedValueOnce({
      added: 1,
      updated: 0,
      skipped: 0,
      superseded: 0,
      llm_dedup_calls: 0,
      relations_created: 0,
      total_entries: 1,
      duration_ms: 1,
    } satisfies StoreResult);

    await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "tools/call",
          params: {
            name: "agenr_store",
            arguments: {
              platform: "codex",
              entries: [
                {
                  type: "fact",
                  content: "Tagged entry.",
                },
              ],
            },
          },
        }),
      ],
      harness.deps,
    );

    const storedEntries = harness.storeEntriesFn.mock.calls[0]?.[1] as KnowledgeEntry[];
    expect(storedEntries).toHaveLength(1);
    expect(storedEntries[0]?.platform).toBe("codex");
  });

  it("agenr_store tags entries with project when provided", async () => {
    const harness = makeHarness();
    harness.storeEntriesFn.mockResolvedValueOnce({
      added: 1,
      updated: 0,
      skipped: 0,
      superseded: 0,
      llm_dedup_calls: 0,
      relations_created: 0,
      total_entries: 1,
      duration_ms: 1,
    } satisfies StoreResult);

    await runServer(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 100,
          method: "tools/call",
          params: {
            name: "agenr_store",
            arguments: {
              project: "Agenr",
              entries: [
                {
                  type: "fact",
                  content: "Tagged project entry.",
                },
              ],
            },
          },
        }),
      ],
      harness.deps,
    );

    const storedEntries = harness.storeEntriesFn.mock.calls[0]?.[1] as KnowledgeEntry[];
    expect(storedEntries).toHaveLength(1);
    expect(storedEntries[0]?.project).toBe("agenr");
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

  it("retired entries remain findable via agenr_recall", async () => {
    const harness = makeHarness();
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
    expect(recallResult.content?.[0]?.text).toContain('Found 1 results for "Jim":');
    expect(recallResult.content?.[0]?.text).toContain("[id=entry-1]");
  });

  it("calls agenr_extract and optionally stores extracted entries", async () => {
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
    harness.storeEntriesFn.mockResolvedValueOnce({
      added: 1,
      updated: 0,
      skipped: 1,
      superseded: 0,
      llm_dedup_calls: 1,
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
    expect(result.content?.[0]?.text).toContain("Stored: 1 new, 0 updated, 1 duplicates skipped, 0 superseded.");
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
