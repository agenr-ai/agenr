import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { extractKnowledgeFromChunks, validateEntry } from "../src/extractor.js";
import type { LlmClient, TranscriptChunk } from "../src/types.js";

function fakeModel(): Model<Api> {
  return {
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
  };
}

function fakeClient(): LlmClient {
  return {
    auth: "anthropic-api-key",
    resolvedModel: {
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      model: fakeModel(),
    },
    credentials: {
      apiKey: "test-key",
      source: "test",
    },
  };
}

function fakeChunk(): TranscriptChunk {
  return {
    chunk_index: 0,
    message_start: 0,
    message_end: 2,
    text: "[m00000][user] hello",
    context_hint: "m00000 hello",
  };
}

function fakeChunkAt(index: number): TranscriptChunk {
  return {
    chunk_index: index,
    message_start: index * 2,
    message_end: index * 2 + 1,
    text: `[m${String(index).padStart(5, "0")}][user] hello ${index}`,
    context_hint: `m${String(index).padStart(5, "0")} hello ${index}`,
  };
}

function assistantMessageWithContent(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-4-6",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function assistantMessage(text: string): AssistantMessage {
  return assistantMessageWithContent([{ type: "text", text }]);
}

function streamWithResult(result: Promise<AssistantMessage>, events: AssistantMessageEvent[] = []) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    result: () => result,
  };
}

describe("extractKnowledgeFromChunks", () => {
  it("extracts entries from submit_knowledge tool calls", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessageWithContent(
            [
              {
                type: "toolCall",
                id: "call_1",
                name: "submit_knowledge",
                arguments: {
                  entries: [
                    {
                      type: "fact",
                      content: "Jim prefers pnpm for JavaScript monorepo package management",
                      subject: "Jim",
                      importance: 8,
                      expiry: "permanent",
                      tags: ["tooling"],
                      source_context: "user discussed preferred package manager",
                    },
                  ],
                },
              },
            ],
            "toolUse",
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.type).toBe("fact");
    expect(result.entries[0]?.subject).toBe("Jim");
    expect(result.entries[0]?.importance).toBe(8);
    expect(result.entries[0]?.source.file).toBe("session.jsonl");
    expect(result.entries[0]?.source.context).toBe("user discussed preferred package manager");
  });

  it("falls back to text parsing when no tool calls are present", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Jim uses pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.successfulChunks).toBe(1);
    expect(result.failedChunks).toBe(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.content).toBe("Jim uses pnpm for JavaScript monorepo package management");
  });

  it("warns for unexpected tool names and still uses text fallback", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessageWithContent([
            {
              type: "toolCall",
              id: "call_2",
              name: "unexpected_tool",
              arguments: { entries: [] },
            },
            {
              type: "text",
              text: '[{"type":"fact","content":"Jim uses pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
            },
          ]),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes('unexpected tool call "unexpected_tool"'))).toBe(true);
  });

  it("warns when submit_knowledge tool call has no entries array", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessageWithContent([
            {
              type: "toolCall",
              id: "call_3",
              name: "submit_knowledge",
              arguments: {},
            },
            {
              type: "text",
              text: '[{"type":"fact","content":"Jim uses pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
            },
          ]),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("tool call had no entries array"))).toBe(true);
  });

  it("parses fenced JSON responses", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            "```json\n[{\"type\":\"fact\",\"content\":\"Jim prefers pnpm for JavaScript monorepo package management\",\"subject\":\"Jim\",\"importance\":8,\"expiry\":\"permanent\",\"tags\":[\"tooling\"],\"source\":{\"file\":\"ignored\",\"context\":\"m00001\"}}]\n```",
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.successfulChunks).toBe(1);
    expect(result.failedChunks).toBe(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.source.file).toBe("session.jsonl");
  });

  it("drops invalid entries but keeps valid ones", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            JSON.stringify([
              {
                type: "fact",
                content: "Agenr launched a major release with validated memory extraction quality improvements.",
                subject: "Agenr",
                importance: 8,
                expiry: "temporary",
                tags: ["launch"],
                source: { file: "ignored", context: "m00002" },
              },
              {
                type: "unsupported",
                content: "bad",
                subject: "bad",
                importance: 8,
                expiry: "permanent",
                tags: [],
                source: { file: "ignored", context: "x" },
              },
            ]),
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("invalid type"))).toBe(true);
  });

  it("retries after parse failure and succeeds", async () => {
    let callCount = 0;
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      callCount += 1;
      if (callCount === 1) {
        return streamWithResult(Promise.resolve(assistantMessage("not-json")));
      }
      return streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Jim uses pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"file":"x","context":"m"}}]',
          ),
        ),
      );
    };

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(callCount).toBe(2);
    expect(result.successfulChunks).toBe(1);
    expect(result.failedChunks).toBe(0);
    expect(result.entries).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("retrying"))).toBe(true);
  });

  it("marks chunk failed when all retries fail", async () => {
    let callCount = 0;
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      callCount += 1;
      return streamWithResult(Promise.reject(new Error("429 rate limit")));
    };

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(callCount).toBe(3);
    expect(result.successfulChunks).toBe(0);
    expect(result.failedChunks).toBe(1);
    expect(result.entries).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("extraction failed"))).toBe(true);
  });

  it("accepts source_context as a flat string", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source_context":"flat context"}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.source.context).toBe("flat context");
  });

  it("accepts source as a flat string", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":"source as string"}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.source.context).toBe("source as string");
  });

  it("accepts description instead of content", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","description":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.content).toBe("Jim prefers pnpm for JavaScript monorepo package management");
  });

  it("accepts text instead of content", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","text":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.content).toBe("Jim prefers pnpm for JavaScript monorepo package management");
  });

  it("accepts statement instead of content", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","statement":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.content).toBe("Jim prefers pnpm for JavaScript monorepo package management");
  });

  it("accepts plural type names (DECISIONS, PREFERENCES, EVENTS)", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"DECISIONS","content":"Chose an async queue architecture for background job processing","subject":"Architecture","importance":8,"expiry":"temporary","tags":["arch"],"source":{"context":"m"}},{"type":"PREFERENCES","content":"Prefers a keto diet for weekly meal planning","subject":"Jim","importance":8,"expiry":"permanent","tags":["diet"],"source":{"context":"m"}},{"type":"EVENTS","content":"Launched version one of the product to production","subject":"Agenr","importance":8,"expiry":"temporary","tags":["launch"],"source":{"context":"m"}}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]?.type).toBe("decision");
    expect(result.entries[1]?.type).toBe("preference");
    expect(result.entries[2]?.type).toBe("event");
  });

  it("accepts knowledge instead of content", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","knowledge":"Jim uses pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.content).toBe("Jim uses pnpm for JavaScript monorepo package management");
  });

  it("accepts name instead of subject", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Jim prefers pnpm for JavaScript monorepo package management","name":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.subject).toBe("Jim");
  });

  it("drops entries with no recognizable content field", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("empty content"))).toBe(true);
  });

  it("logs verbose raw sample and fallback field usage", async () => {
    const verboseLines: string[] = [];
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","description":"Jim prefers pnpm for JavaScript monorepo package management","name":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source_context":"flat context"}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: true,
      streamSimpleImpl,
      onVerbose: (line) => verboseLines.push(line),
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(verboseLines.some((line) => line.startsWith("[raw-sample]"))).toBe(true);
    expect(verboseLines).toContain('[field-fallback] used "description" for content');
    expect(verboseLines).toContain('[field-fallback] used "name" for subject');
    expect(verboseLines).toContain('[field-fallback] used "source_context" for source.context');
  });

  it("routes stream deltas to onStreamDelta and emits newline per completed chunk", async () => {
    const deltas: Array<{ delta: string; kind: "text" | "thinking" }> = [];
    const verboseLines: string[] = [];

    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
        [
          { type: "thinking_start" } as AssistantMessageEvent,
          { type: "thinking_delta", delta: "reasoning " } as AssistantMessageEvent,
          { type: "text_delta", delta: "answer" } as AssistantMessageEvent,
          { type: "thinking_end" } as AssistantMessageEvent,
        ],
      );

    await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1)],
      client: fakeClient(),
      verbose: true,
      noDedup: true,
      streamSimpleImpl,
      onVerbose: (line) => verboseLines.push(line),
      onStreamDelta: (delta, kind) => deltas.push({ delta, kind }),
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(deltas).toEqual([
      { delta: "reasoning ", kind: "thinking" },
      { delta: "answer", kind: "text" },
      { delta: "\n", kind: "text" },
      { delta: "reasoning ", kind: "thinking" },
      { delta: "answer", kind: "text" },
      { delta: "\n", kind: "text" },
    ]);
    expect(verboseLines).toEqual([
      "[chunk 1/2] attempt 1/3",
      "[thinking]",
      "[/thinking]",
      '[raw-sample] {"type":"fact","content":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}',
      "[chunk 2/2] attempt 1/3",
      "[thinking]",
      "[/thinking]",
      '[raw-sample] {"type":"fact","content":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}',
    ]);
  });

  it("onChunkComplete receives entries per chunk", async () => {
    let callCount = 0;
    const chunkCallbacks: Array<{ chunkIndex: number; totalChunks: number; contents: string[] }> = [];
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      const index = callCount;
      callCount += 1;
      return streamWithResult(
        Promise.resolve(
          assistantMessage(
            JSON.stringify([
              {
                type: "fact",
                content:
                  index === 0
                    ? "Entry zero contains durable planning context"
                    : "Entry one contains durable implementation context",
                subject: "Jim",
                importance: 8,
                expiry: "permanent",
                tags: ["tooling"],
                source: { context: "m" },
              },
            ]),
          ),
        ),
      );
    };

    await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1)],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
      onChunkComplete: async (chunkResult) => {
        chunkCallbacks.push({
          chunkIndex: chunkResult.chunkIndex,
          totalChunks: chunkResult.totalChunks,
          contents: chunkResult.entries.map((entry) => entry.content),
        });
      },
    });

    expect(chunkCallbacks).toEqual([
      { chunkIndex: 0, totalChunks: 2, contents: ["Entry zero contains durable planning context"] },
      { chunkIndex: 1, totalChunks: 2, contents: ["Entry one contains durable implementation context"] },
    ]);
  });

  it("onChunkComplete returns empty final entries array", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
      onChunkComplete: async () => {},
    });

    expect(result.successfulChunks).toBe(1);
    expect(result.failedChunks).toBe(0);
    expect(result.entries).toEqual([]);
  });

  it("without onChunkComplete accumulates entries as before", async () => {
    let callCount = 0;
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      const index = callCount;
      callCount += 1;
      return streamWithResult(
        Promise.resolve(
          assistantMessage(
            JSON.stringify([
              {
                type: "fact",
                content:
                  index === 0
                    ? "Entry zero contains durable planning context"
                    : "Entry one contains durable implementation context",
                subject: "Jim",
                importance: 8,
                expiry: "permanent",
                tags: ["tooling"],
                source: { context: "m" },
              },
            ]),
          ),
        ),
      );
    };

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1)],
      client: fakeClient(),
      verbose: false,
      noDedup: true,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries.map((entry) => entry.content)).toEqual(["Entry zero contains durable planning context", "Entry one contains durable implementation context"]);
  });

  it("onChunkComplete error in callback propagates", async () => {
    let callCount = 0;
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      callCount += 1;
      return streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
      );
    };

    await expect(
      extractKnowledgeFromChunks({
        file: "session.jsonl",
        chunks: [fakeChunkAt(0), fakeChunkAt(1)],
        client: fakeClient(),
        verbose: false,
        streamSimpleImpl,
        sleepImpl: async () => {},
        retryDelayMs: () => 0,
        onChunkComplete: async () => {
          throw new Error("callback failed");
        },
      }),
    ).rejects.toThrow("callback failed");

    expect(callCount).toBe(1);
  });

  it("runs post-extraction dedup and merges obvious duplicates", async () => {
    let callCount = 0;
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      callCount += 1;
      if (callCount === 1) {
        return streamWithResult(
          Promise.resolve(
            assistantMessage(
              '[{"type":"fact","content":"Agenr skill server uses port 7373 in local development environments","subject":"agenr skill server port","importance":6,"expiry":"temporary","tags":["agenr","server"],"source":{"context":"m0"}}]',
            ),
          ),
        );
      }
      if (callCount === 2) {
        return streamWithResult(
          Promise.resolve(
            assistantMessage(
              '[{"type":"fact","content":"Agenr server port configuration defaults to 7373 during local runs","subject":"agenr server port configuration","importance":7,"expiry":"temporary","tags":["agenr","config"],"source":{"context":"m1"}}]',
            ),
          ),
        );
      }

      return streamWithResult(
        Promise.resolve(
          assistantMessageWithContent(
            [
              {
                type: "toolCall",
                id: "dedup_1",
                name: "submit_deduped_knowledge",
                arguments: {
                  entries: [
                    {
                      type: "fact",
                      content: "Agenr local server defaults to port 7373 unless explicitly overridden",
                      subject: "agenr local server port",
                      importance: 7,
                      expiry: "temporary",
                      tags: ["agenr", "server", "config"],
                      source_context: "merged duplicate configuration notes",
                    },
                  ],
                },
              },
            ],
            "toolUse",
          ),
        ),
      );
    };

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1)],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(callCount).toBe(3);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.subject).toBe("agenr local server port");
  });

  it("preserves genuinely different entries during dedup", async () => {
    let callCount = 0;
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      callCount += 1;
      if (callCount === 1) {
        return streamWithResult(
          Promise.resolve(
            assistantMessage(
              '[{"type":"fact","content":"Agenr stores vectors in sqlite-vec for semantic similarity queries","subject":"agenr vector storage","importance":8,"expiry":"permanent","tags":["agenr","vectors"],"source":{"context":"m0"}}]',
            ),
          ),
        );
      }
      if (callCount === 2) {
        return streamWithResult(
          Promise.resolve(
            assistantMessage(
              '[{"type":"decision","content":"The project chose pnpm workspaces to manage monorepo dependencies","subject":"monorepo package manager","importance":8,"expiry":"temporary","tags":["pnpm","monorepo"],"source":{"context":"m1"}}]',
            ),
          ),
        );
      }

      return streamWithResult(
        Promise.resolve(
          assistantMessageWithContent(
            [
              {
                type: "toolCall",
                id: "dedup_2",
                name: "submit_deduped_knowledge",
                arguments: {
                  entries: [
                    {
                      type: "fact",
                      content: "Agenr stores vectors in sqlite-vec for semantic similarity queries",
                      subject: "agenr vector storage",
                      importance: 8,
                      expiry: "permanent",
                      tags: ["agenr", "vectors"],
                      source_context: "kept as independent fact",
                    },
                    {
                      type: "decision",
                      content: "The project chose pnpm workspaces to manage monorepo dependencies",
                      subject: "monorepo package manager",
                      importance: 8,
                      expiry: "temporary",
                      tags: ["pnpm", "monorepo"],
                      source_context: "kept as independent decision",
                    },
                  ],
                },
              },
            ],
            "toolUse",
          ),
        ),
      );
    };

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1)],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((entry) => entry.subject)).toEqual([
      "agenr vector storage",
      "monorepo package manager",
    ]);
  });

  it("preserves the highest importance when duplicates are merged", async () => {
    let callCount = 0;
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      callCount += 1;
      if (callCount === 1) {
        return streamWithResult(
          Promise.resolve(
            assistantMessage(
              '[{"type":"fact","content":"Agenr extraction pipeline retries model calls on transient provider errors","subject":"agenr extraction retries","importance":6,"expiry":"temporary","tags":["agenr","retries"],"source":{"context":"m0"}}]',
            ),
          ),
        );
      }
      if (callCount === 2) {
        return streamWithResult(
          Promise.resolve(
            assistantMessage(
              '[{"type":"fact","content":"Agenr extraction pipeline retries transient provider failures with exponential backoff","subject":"agenr extraction retries","importance":9,"expiry":"temporary","tags":["agenr","backoff"],"source":{"context":"m1"}}]',
            ),
          ),
        );
      }

      return streamWithResult(
        Promise.resolve(
          assistantMessageWithContent(
            [
              {
                type: "toolCall",
                id: "dedup_3",
                name: "submit_deduped_knowledge",
                arguments: {
                  entries: [
                    {
                      type: "fact",
                      content: "Agenr extraction retries transient provider failures with exponential backoff",
                      subject: "agenr extraction retries",
                      importance: 9,
                      expiry: "temporary",
                      tags: ["agenr", "retries", "backoff"],
                      source_context: "merged duplicate retry behavior notes",
                    },
                  ],
                },
              },
            ],
            "toolUse",
          ),
        ),
      );
    };

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1)],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.importance).toBe(9);
  });

  it("skips post-extraction dedup when noDedup is true", async () => {
    let callCount = 0;
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      callCount += 1;
      if (callCount === 1) {
        return streamWithResult(
          Promise.resolve(
            assistantMessage(
              '[{"type":"fact","content":"Agenr watch mode stores extracted entries incrementally per chunk","subject":"agenr watch mode behavior","importance":7,"expiry":"temporary","tags":["agenr","watch"],"source":{"context":"m0"}}]',
            ),
          ),
        );
      }
      if (callCount === 2) {
        return streamWithResult(
          Promise.resolve(
            assistantMessage(
              '[{"type":"fact","content":"Agenr watch mode persists chunk entries immediately after extraction","subject":"agenr watch mode behavior","importance":7,"expiry":"temporary","tags":["agenr","watch"],"source":{"context":"m1"}}]',
            ),
          ),
        );
      }
      throw new Error("dedup should not run");
    };

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1)],
      client: fakeClient(),
      verbose: false,
      noDedup: true,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(callCount).toBe(2);
    expect(result.entries).toHaveLength(2);
  });

  it("does not call dedup for empty or single-entry extraction results", async () => {
    const singleCallStream = vi.fn((_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Agenr uses TypeScript with ESM modules and Node.js 20 runtime","subject":"agenr runtime stack","importance":7,"expiry":"permanent","tags":["typescript","node"],"source":{"context":"m0"}}]',
          ),
        ),
      ),
    );

    const singleResult = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl: singleCallStream,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(singleResult.entries).toHaveLength(1);
    expect(singleCallStream).toHaveBeenCalledTimes(1);

    const emptyStream = vi.fn((_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(Promise.resolve(assistantMessage("[]"))),
    );

    const emptyResult = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl: emptyStream,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(emptyResult.entries).toHaveLength(0);
    expect(emptyStream).toHaveBeenCalledTimes(1);
  });
});

describe("validateEntry", () => {
  it("rejects blocked subjects", () => {
    const reason = validateEntry({
      type: "fact",
      subject: "assistant",
      content: "Assistant preferences should not be extracted as durable memory.",
      importance: 6,
      expiry: "temporary",
      tags: ["meta"],
      source: { file: "x", context: "ctx" },
    });

    expect(reason).toContain("blocked subject");
  });

  it("rejects meta-pattern narration", () => {
    const reason = validateEntry({
      type: "fact",
      subject: "deployment verification",
      content: "The assistant ran the deployment checks and reported success.",
      importance: 6,
      expiry: "temporary",
      tags: ["deployment"],
      source: { file: "x", context: "ctx" },
    });

    expect(reason).toContain("meta-pattern");
  });

  it("enforces content length and importance floor", () => {
    const shortReason = validateEntry({
      type: "fact",
      subject: "tooling preference",
      content: "Too short.",
      importance: 6,
      expiry: "temporary",
      tags: ["tooling"],
      source: { file: "x", context: "ctx" },
    });
    const lowImportanceReason = validateEntry({
      type: "fact",
      subject: "tooling preference",
      content: "Prefers pnpm for JavaScript monorepo package management across projects.",
      importance: 4,
      expiry: "temporary",
      tags: ["tooling"],
      source: { file: "x", context: "ctx" },
    });

    expect(shortReason).toBe("content too short");
    expect(lowImportanceReason).toBe("importance 4 < 5");
  });
});
