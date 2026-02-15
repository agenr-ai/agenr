import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { runSimpleStream } from "../src/llm/stream.js";

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

function fakeContext(): Context {
  return {
    systemPrompt: "test",
    messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
  };
}

function fakeResultMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
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
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function fakeErrorMessage(errorMessage: string): AssistantMessage {
  return {
    ...fakeResultMessage(),
    stopReason: "error",
    errorMessage,
  };
}

function streamWithEvents(events: AssistantMessageEvent[]) {
  return (_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => ({
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    result: async () => fakeResultMessage(),
  });
}

describe("runSimpleStream", () => {
  it("routes text/thinking deltas to onStreamDelta and excludes them from onVerbose", async () => {
    const verboseLines: string[] = [];
    const deltas: Array<{ delta: string; kind: "text" | "thinking" }> = [];

    await runSimpleStream({
      model: fakeModel(),
      context: fakeContext(),
      options: { apiKey: "test-key" },
      verbose: true,
      streamSimpleImpl: streamWithEvents([
        { type: "thinking_start" } as AssistantMessageEvent,
        { type: "thinking_delta", delta: "reasoning " } as AssistantMessageEvent,
        { type: "text_delta", delta: "answer" } as AssistantMessageEvent,
        { type: "thinking_end" } as AssistantMessageEvent,
      ]),
      onVerbose: (line) => verboseLines.push(line),
      onStreamDelta: (delta, kind) => deltas.push({ delta, kind }),
    });

    expect(deltas).toEqual([
      { delta: "reasoning ", kind: "thinking" },
      { delta: "answer", kind: "text" },
    ]);
    expect(verboseLines).toEqual(["[thinking]", "[/thinking]"]);
  });

  it("keeps structural and error events on onVerbose", async () => {
    const verboseLines: string[] = [];
    const deltas: Array<{ delta: string; kind: "text" | "thinking" }> = [];

    await runSimpleStream({
      model: fakeModel(),
      context: fakeContext(),
      options: { apiKey: "test-key" },
      verbose: true,
      streamSimpleImpl: streamWithEvents([
        { type: "thinking_start" } as AssistantMessageEvent,
        { type: "thinking_end" } as AssistantMessageEvent,
        {
          type: "error",
          reason: "error",
          error: fakeErrorMessage("boom"),
        } as AssistantMessageEvent,
      ]),
      onVerbose: (line) => verboseLines.push(line),
      onStreamDelta: (delta, kind) => deltas.push({ delta, kind }),
    });

    expect(verboseLines).toEqual(["[thinking]", "[/thinking]", "[error:error] boom"]);
    expect(deltas).toEqual([]);
  });
});
