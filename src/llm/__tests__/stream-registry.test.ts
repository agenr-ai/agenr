import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { runSimpleStream } from "../stream.js";

function fakeModel(): Model<Api> {
  return {
    id: "gpt-4.1-mini",
    name: "GPT-4.1 mini",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

function fakeContext(): Context {
  return {
    systemPrompt: "test",
    messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
  };
}

function makeAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-4.1-mini",
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

describe("runSimpleStream registry wiring", () => {
  it("works with an injected streamSimpleImpl without manual provider registration", async () => {
    const expected = makeAssistantMessage("ok");
    const streamSimpleImpl = vi.fn(
      (_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => ({
        async *[Symbol.asyncIterator]() {
          // Intentionally empty stream - only final result is needed in this test.
        },
        result: async () => expected,
      }),
    );

    const result = await runSimpleStream({
      model: fakeModel(),
      context: fakeContext(),
      options: { apiKey: "test-key" },
      verbose: false,
      streamSimpleImpl,
    });

    expect(result).toEqual(expected);
  });

  it("uses the provided streamSimpleImpl when passed", async () => {
    const model = fakeModel();
    const context = fakeContext();
    const options = { apiKey: "test-key" };
    const expected = makeAssistantMessage("custom impl");
    const streamSimpleImpl = vi.fn(
      (_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => ({
        async *[Symbol.asyncIterator]() {
          // No-op event stream for this regression guard.
        },
        result: async () => expected,
      }),
    );

    const result = await runSimpleStream({
      model,
      context,
      options,
      verbose: false,
      streamSimpleImpl,
    });

    expect(result).toEqual(expected);
    expect(streamSimpleImpl).toHaveBeenCalledTimes(1);
    expect(streamSimpleImpl).toHaveBeenCalledWith(model, context, options);
  });
});
