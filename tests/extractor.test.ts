import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { extractKnowledgeFromChunks } from "../src/extractor.js";
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
                      content: "Jim prefers pnpm",
                      subject: "Jim",
                      confidence: "high",
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
    expect(result.entries[0]?.source.file).toBe("session.jsonl");
    expect(result.entries[0]?.source.context).toBe("user discussed preferred package manager");
  });

  it("falls back to text parsing when no tool calls are present", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Jim uses pnpm","subject":"Jim","confidence":"high","expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
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
    expect(result.entries[0]?.content).toBe("Jim uses pnpm");
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
              text: '[{"type":"fact","content":"Jim uses pnpm","subject":"Jim","confidence":"high","expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
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
              text: '[{"type":"fact","content":"Jim uses pnpm","subject":"Jim","confidence":"high","expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
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
            "```json\n[{\"type\":\"fact\",\"content\":\"Jim prefers pnpm\",\"subject\":\"Jim\",\"confidence\":\"high\",\"expiry\":\"permanent\",\"tags\":[\"tooling\"],\"source\":{\"file\":\"ignored\",\"context\":\"m00001\"}}]\n```",
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
                content: "Agenr launched.",
                subject: "Agenr",
                confidence: "high",
                expiry: "temporary",
                tags: ["launch"],
                source: { file: "ignored", context: "m00002" },
              },
              {
                type: "unsupported",
                content: "bad",
                subject: "bad",
                confidence: "high",
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
            '[{"type":"fact","content":"Jim uses pnpm","subject":"Jim","confidence":"high","expiry":"permanent","tags":["tooling"],"source":{"file":"x","context":"m"}}]',
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
            '[{"type":"fact","content":"Jim prefers pnpm","subject":"Jim","confidence":"high","expiry":"permanent","tags":["tooling"],"source_context":"flat context"}]',
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
            '[{"type":"fact","content":"Jim prefers pnpm","subject":"Jim","confidence":"high","expiry":"permanent","tags":["tooling"],"source":"source as string"}]',
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
            '[{"type":"fact","description":"Jim prefers pnpm","subject":"Jim","confidence":"high","expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
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
    expect(result.entries[0]?.content).toBe("Jim prefers pnpm");
  });

  it("accepts text instead of content", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","text":"Jim prefers pnpm","subject":"Jim","confidence":"high","expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
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
    expect(result.entries[0]?.content).toBe("Jim prefers pnpm");
  });

  it("accepts statement instead of content", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","statement":"Jim prefers pnpm","subject":"Jim","confidence":"high","expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
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
    expect(result.entries[0]?.content).toBe("Jim prefers pnpm");
  });

  it("accepts plural type names (DECISIONS, PREFERENCES, EVENTS)", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"DECISIONS","content":"Chose async queue","subject":"Architecture","confidence":"high","expiry":"temporary","tags":["arch"],"source":{"context":"m"}},{"type":"PREFERENCES","content":"Prefers keto","subject":"Jim","confidence":"high","expiry":"permanent","tags":["diet"],"source":{"context":"m"}},{"type":"EVENTS","content":"Launched v1","subject":"Agenr","confidence":"high","expiry":"temporary","tags":["launch"],"source":{"context":"m"}}]',
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
            '[{"type":"fact","knowledge":"Jim uses pnpm","subject":"Jim","confidence":"high","expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
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
    expect(result.entries[0]?.content).toBe("Jim uses pnpm");
  });

  it("accepts name instead of subject", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Jim prefers pnpm","name":"Jim","confidence":"high","expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
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
            '[{"type":"fact","subject":"Jim","confidence":"high","expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
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
            '[{"type":"fact","description":"Jim prefers pnpm","name":"Jim","confidence":"high","expiry":"permanent","tags":["tooling"],"source_context":"flat context"}]',
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
            '[{"type":"fact","content":"Jim prefers pnpm","subject":"Jim","confidence":"high","expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
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
      '[raw-sample] {"type":"fact","content":"Jim prefers pnpm","subject":"Jim","confidence":"high","expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}',
      "[chunk 2/2] attempt 1/3",
      "[thinking]",
      "[/thinking]",
      '[raw-sample] {"type":"fact","content":"Jim prefers pnpm","subject":"Jim","confidence":"high","expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}',
    ]);
  });
});
