import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const piAiMocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  getEnvApiKey: vi.fn(),
  getModel: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: piAiMocks.completeSimple,
  getEnvApiKey: piAiMocks.getEnvApiKey,
  getModel: piAiMocks.getModel,
}));

import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";

import { createLlmClient, resolveLlmApiKey, resolveModel, stripCodeFence } from "../../src/adapters/llm.js";

function buildModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 400_000,
    maxTokens: 131_072,
    ...overrides,
  };
}

function buildAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4-mini",
    content: [{ type: "text", text }],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

describe("resolveModel", () => {
  it("returns the extraction override when set", () => {
    expect(
      resolveModel(
        {
          provider: "openai",
          model: "gpt-5.4",
          extractionModel: {
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
          },
        },
        "extraction",
      ),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
    });
  });

  it("returns the dedup override when set", () => {
    expect(
      resolveModel(
        {
          provider: "openai",
          model: "gpt-5.4",
          dedupModel: {
            provider: "google",
            model: "gemini-2.5-flash",
          },
        },
        "dedup",
      ),
    ).toEqual({
      provider: "google",
      modelId: "gemini-2.5-flash",
    });
  });

  it("falls back to the top-level config when stage overrides are absent", () => {
    expect(
      resolveModel(
        {
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
        },
        "extraction",
      ),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
    });
  });

  it("uses stage-specific defaults when no config is present", () => {
    expect(resolveModel(undefined, "extraction")).toEqual({
      provider: "openai",
      modelId: "gpt-5.4-mini",
    });
    expect(resolveModel(undefined, "dedup")).toEqual({
      provider: "openai",
      modelId: "gpt-5.4-nano",
    });
  });
});

describe("resolveLlmApiKey", () => {
  beforeEach(() => {
    piAiMocks.getEnvApiKey.mockReset();
  });

  it("prefers config.apiKey over provider environment lookup", () => {
    piAiMocks.getEnvApiKey.mockReturnValue("env-key");

    expect(resolveLlmApiKey({ apiKey: "config-key" }, "openai")).toBe("config-key");
  });

  it("falls back to the provider environment key", () => {
    piAiMocks.getEnvApiKey.mockReturnValue("env-key");

    expect(resolveLlmApiKey(undefined, "openai")).toBe("env-key");
  });

  it("throws when no API key is available", () => {
    piAiMocks.getEnvApiKey.mockReturnValue(undefined);

    expect(() => resolveLlmApiKey(undefined, "openai")).toThrow(/no api key found/i);
  });
});

describe("createLlmClient", () => {
  beforeEach(() => {
    piAiMocks.getModel.mockReset();
    piAiMocks.completeSimple.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a client with the expected metadata", async () => {
    const model = buildModel({
      contextWindow: 200_000,
      maxTokens: 8_192,
      reasoning: false,
    });
    piAiMocks.getModel.mockReturnValue(model);
    piAiMocks.completeSimple.mockResolvedValue(buildAssistantMessage("hello"));

    const client = createLlmClient("openai", "gpt-5.4-mini");

    expect(client.metadata).toEqual({
      model,
      contextWindowTokens: 200_000,
      maxOutputTokens: 8_192,
      supportsReasoning: false,
    });

    await expect(client.complete("system", "user")).resolves.toBe("hello");
  });
});

describe("stripCodeFence", () => {
  it("removes json code fences", () => {
    expect(stripCodeFence('```json\n{"entries":[]}\n```')).toBe('{"entries":[]}');
  });
});
