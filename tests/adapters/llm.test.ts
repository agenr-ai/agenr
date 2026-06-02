import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const piAiMocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  getEnvApiKey: vi.fn(),
  getModel: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  completeSimple: piAiMocks.completeSimple,
  getEnvApiKey: piAiMocks.getEnvApiKey,
  getModel: piAiMocks.getModel,
}));

import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

import { createLlmClient, probeLlmCredentials, resolveLlmApiKey, resolveModel, stripCodeFence } from "../../src/adapters/llm.js";

const tempDirs: string[] = [];
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
const originalCodexHome = process.env.CODEX_HOME;

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

  it("returns the episode override when set", () => {
    expect(
      resolveModel(
        {
          provider: "openai",
          model: "gpt-5.4",
          episodeModel: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
        },
        "episode",
      ),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
  });

  it("returns the claim extraction override when set", () => {
    expect(
      resolveModel(
        {
          provider: "openai",
          model: "gpt-5.4",
          extractionModel: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
          claimExtraction: {
            model: {
              provider: "openai",
              model: "gpt-5.4-nano",
            },
          },
        },
        "claim",
      ),
    ).toEqual({
      provider: "openai",
      modelId: "gpt-5.4-nano",
    });
  });

  it("falls back from claim extraction to the extraction override", () => {
    expect(
      resolveModel(
        {
          provider: "openai",
          model: "gpt-5.4",
          extractionModel: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
        },
        "claim",
      ),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
  });

  it("falls back to the top-level config when stage overrides are absent", () => {
    expect(
      resolveModel(
        {
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
        },
        "episode",
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
    expect(resolveModel(undefined, "episode")).toEqual({
      provider: "openai",
      modelId: "gpt-5.4-mini",
    });
    expect(resolveModel(undefined, "claim")).toEqual({
      provider: "openai",
      modelId: "gpt-5.4-mini",
    });
  });
});

describe("resolveLlmApiKey", () => {
  beforeEach(() => {
    piAiMocks.getEnvApiKey.mockReset();
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }

    if (originalAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
    }
  });

  it("prefers OPENAI_API_KEY over stored OpenAI credentials", () => {
    process.env.OPENAI_API_KEY = "env-key";

    expect(
      resolveLlmApiKey(
        {
          auth: "openai-api-key",
          provider: "openai",
          credentials: {
            openaiApiKey: "config-key",
          },
        },
        "openai",
      ),
    ).toBe("env-key");
  });

  it("falls back to the provider environment key", () => {
    process.env.OPENAI_API_KEY = "env-key";

    expect(resolveLlmApiKey(undefined, "openai")).toBe("env-key");
  });

  it("throws when no API key is available", () => {
    piAiMocks.getEnvApiKey.mockReturnValue(undefined);

    expect(() => resolveLlmApiKey(undefined, "openai")).toThrow(/no credential found/i);
  });

  it("uses stored Anthropic tokens for anthropic-token auth", () => {
    expect(
      resolveLlmApiKey(
        {
          auth: "anthropic-token",
          provider: "anthropic",
          credentials: {
            anthropicOauthToken: "anthropic-token-value",
          },
        },
        "anthropic",
      ),
    ).toBe("anthropic-token-value");
  });
});

describe("probeLlmCredentials", () => {
  beforeEach(() => {
    delete process.env.CODEX_HOME;
  });

  afterEach(async () => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }

    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
  });

  it("detects Codex CLI credentials from auth.json for openai subscriptions", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "agenr-codex-auth-"));
    tempDirs.push(codexHome);
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      path.join(codexHome, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: "subscription-token",
        },
      }),
    );
    process.env.CODEX_HOME = codexHome;

    const result = probeLlmCredentials({
      auth: "openai-subscription",
    });

    expect(result.available).toBe(true);
    expect(result.source).toContain("auth.json");
    expect(result.credentials).toMatchObject({
      apiKey: "subscription-token",
      auth: "openai-subscription",
    });
  });

  it("detects Codex CLI credentials under USERPROFILE-style home env", async () => {
    const profileHome = await mkdtemp(path.join(os.tmpdir(), "agenr-codex-profile-"));
    tempDirs.push(profileHome);
    const codexHome = path.join(profileHome, ".codex");
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      path.join(codexHome, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: "profile-subscription-token",
        },
      }),
    );

    const result = probeLlmCredentials({
      auth: "openai-subscription",
      env: {
        USERPROFILE: profileHome,
      } as NodeJS.ProcessEnv,
    });

    expect(result.available).toBe(true);
    expect(result.credentials).toMatchObject({
      apiKey: "profile-subscription-token",
      auth: "openai-subscription",
    });
  });

  it("detects Claude credentials under USERPROFILE-style home env", async () => {
    const profileHome = await mkdtemp(path.join(os.tmpdir(), "agenr-claude-profile-"));
    tempDirs.push(profileHome);
    const claudeHome = path.join(profileHome, ".claude");
    await mkdir(claudeHome, { recursive: true });
    await writeFile(
      path.join(claudeHome, "credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "profile-claude-token",
        },
      }),
    );

    const result = probeLlmCredentials({
      auth: "anthropic-oauth",
      env: {
        USERPROFILE: profileHome,
      } as NodeJS.ProcessEnv,
    });

    expect(result.available).toBe(true);
    expect(result.credentials).toMatchObject({
      apiKey: "profile-claude-token",
      auth: "anthropic-oauth",
    });
  });

  it("returns setup guidance when Anthropic token credentials are unavailable", () => {
    const result = probeLlmCredentials({
      auth: "anthropic-token",
      env: {
        HOME: path.join(os.tmpdir(), "agenr-missing-claude-home"),
      } as NodeJS.ProcessEnv,
    });

    expect(result.available).toBe(false);
    expect(result.guidance).toMatch(/anthropic long-lived token/i);
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
