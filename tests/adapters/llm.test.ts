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
    usage: buildUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function buildUsage(
  overrides: Partial<AssistantMessage["usage"]> & {
    cost?: Partial<AssistantMessage["usage"]["cost"]>;
  } = {},
): AssistantMessage["usage"] {
  const defaultCost = {
    input: 0.001,
    output: 0.002,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0.003,
  };

  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    ...overrides,
    cost: {
      ...defaultCost,
      ...(overrides.cost ?? {}),
    },
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
      usage: {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        totalCost: 0,
      },
    });

    await expect(client.complete("system", "user")).resolves.toBe("hello");
  });

  it("initializes usage stats to zero", () => {
    piAiMocks.getModel.mockReturnValue(buildModel());

    const client = createLlmClient("openai", "gpt-5.4-mini");

    expect(client.metadata.usage).toEqual({
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      totalCost: 0,
    });
  });

  it("accumulates usage stats for completeJson calls", async () => {
    piAiMocks.getModel.mockReturnValue(buildModel());
    piAiMocks.completeSimple.mockResolvedValue({
      ...buildAssistantMessage('{"entries":["kept"]}'),
      usage: buildUsage({
        input: 12,
        output: 5,
        cacheRead: 3,
        cacheWrite: 2,
        totalTokens: 22,
        cost: {
          input: 0.002,
          output: 0.003,
          cacheRead: 0.0002,
          cacheWrite: 0.0001,
          total: 0.0053,
        },
      }),
    });

    const client = createLlmClient("openai", "gpt-5.4-mini");

    await expect(client.completeJson("system", "user")).resolves.toEqual({ entries: ["kept"] });

    expect(client.metadata.usage).toEqual({
      calls: 1,
      inputTokens: 12,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      totalTokens: 22,
      totalCost: 0.0053,
    });
  });

  it("accumulates usage stats after multiple completion calls", async () => {
    piAiMocks.getModel.mockReturnValue(buildModel());
    piAiMocks.completeSimple
      .mockResolvedValueOnce({
        ...buildAssistantMessage("hello"),
        usage: buildUsage({
          input: 10,
          output: 4,
          cacheRead: 2,
          cacheWrite: 1,
          totalTokens: 17,
          cost: {
            input: 0.002,
            output: 0.003,
            cacheRead: 0.0001,
            cacheWrite: 0.0002,
            total: 0.0053,
          },
        }),
      })
      .mockResolvedValueOnce({
        ...buildAssistantMessage('{"entries":[]}'),
        usage: buildUsage({
          input: 7,
          output: 3,
          cacheRead: 5,
          cacheWrite: 0,
          totalTokens: 15,
          cost: {
            input: 0.001,
            output: 0.002,
            cacheRead: 0.0004,
            cacheWrite: 0,
            total: 0.0034,
          },
        }),
      });

    const client = createLlmClient("openai", "gpt-5.4-mini");

    await expect(client.complete("system", "user")).resolves.toBe("hello");
    await expect(client.completeJson("system", "user")).resolves.toEqual({ entries: [] });

    expect(client.metadata.usage).toEqual({
      calls: 2,
      inputTokens: 17,
      outputTokens: 7,
      cacheReadTokens: 7,
      cacheWriteTokens: 1,
      totalTokens: 32,
      totalCost: 0.0087,
    });
  });

  it("accumulates total cost across multiple calls", async () => {
    piAiMocks.getModel.mockReturnValue(buildModel());
    piAiMocks.completeSimple
      .mockResolvedValueOnce({
        ...buildAssistantMessage("first"),
        usage: buildUsage({
          cost: {
            total: 0.0042,
          },
        }),
      })
      .mockResolvedValueOnce({
        ...buildAssistantMessage("second"),
        usage: buildUsage({
          cost: {
            total: 0.0095,
          },
        }),
      });

    const client = createLlmClient("openai", "gpt-5.4-mini");

    await client.complete("system", "user");
    await client.complete("system", "user");

    expect(client.metadata.usage.totalCost).toBeCloseTo(0.0137, 10);
  });
});

describe("stripCodeFence", () => {
  it("removes json code fences", () => {
    expect(stripCodeFence('```json\n{"entries":[]}\n```')).toBe('{"entries":[]}');
  });
});
