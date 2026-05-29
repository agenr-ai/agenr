import os from "node:os";
import path from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const piAiMocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  getModel: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  completeSimple: piAiMocks.completeSimple,
  getModel: piAiMocks.getModel,
}));

import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

import { createOpenClawLlmClient } from "../../../../src/adapters/openclaw/llm/openclaw-llm-client.js";
import type { AgenrOpenClawHost } from "../../../../src/adapters/openclaw/types.js";

describe("createOpenClawLlmClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    piAiMocks.completeSimple.mockReset();
    piAiMocks.getModel.mockReset();
  });

  it("uses OpenClaw provider auth and reuses the resolved credential across completions", async () => {
    const resolveApiKeyForProvider = vi.fn(async () => ({
      apiKey: "openclaw-test-key",
      source: "profile:default",
      mode: "api-key" as const,
    }));
    piAiMocks.getModel.mockReturnValue(buildModel());
    piAiMocks.completeSimple.mockResolvedValue(buildAssistantMessage('{"entity":"jim","attribute":"timezone","confidence":0.95}'));

    const client = await createOpenClawLlmClient(
      createOpenClawHost({
        model: "openai/gpt-5.4-mini",
        resolveApiKeyForProvider,
      }),
    );

    await expect(client.complete("system", "first")).resolves.toBe('{"entity":"jim","attribute":"timezone","confidence":0.95}');
    await expect(client.complete("system", "second")).resolves.toBe('{"entity":"jim","attribute":"timezone","confidence":0.95}');

    expect(piAiMocks.getModel).toHaveBeenCalledWith("openai", "gpt-5.4-mini");
    expect(resolveApiKeyForProvider).toHaveBeenCalledTimes(1);
    expect(piAiMocks.completeSimple).toHaveBeenCalledTimes(2);
    expect(piAiMocks.completeSimple.mock.calls[0]?.[2]).toMatchObject({
      apiKey: "openclaw-test-key",
    });
  });

  it("uses the plugin model override when provided", async () => {
    const resolveApiKeyForProvider = vi.fn(async () => ({
      apiKey: "override-key",
      source: "profile:anthropic",
      mode: "api-key" as const,
    }));
    piAiMocks.getModel.mockReturnValue(
      buildModel({
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        provider: "anthropic",
        api: "anthropic-messages",
      }),
    );
    piAiMocks.completeSimple.mockResolvedValue(buildAssistantMessage('{"ok":true}'));

    const client = await createOpenClawLlmClient(
      createOpenClawHost({
        model: "openai/gpt-5.4-mini",
        resolveApiKeyForProvider,
      }),
      "anthropic/claude-haiku-4-5",
    );

    await client.complete("system", "override");

    expect(piAiMocks.getModel).toHaveBeenCalledWith("anthropic", "claude-haiku-4-5");
    expect(resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "anthropic",
      cfg: expect.any(Object),
    });
  });

  it("parses JSON responses and strips one outer code fence", async () => {
    piAiMocks.getModel.mockReturnValue(buildModel());
    piAiMocks.completeSimple.mockResolvedValue(buildAssistantMessage('```json\n{"entity":"foo","attribute":"bar","confidence":0.9}\n```'));

    const client = await createOpenClawLlmClient(createOpenClawHost());

    await expect(client.completeJson<{ entity: string; attribute: string; confidence: number }>("system", "json")).resolves.toEqual({
      entity: "foo",
      attribute: "bar",
      confidence: 0.9,
    });
  });

  it("uses the caller label when reporting invalid model overrides", async () => {
    await expect(createOpenClawLlmClient(createOpenClawHost(), "/model", "episode model override")).rejects.toThrow("Invalid episode model override: /model");
  });
});

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

function createOpenClawHost(
  options: {
    model?: string;
    resolveApiKeyForProvider?: AgenrOpenClawHost["runtime"]["modelAuth"]["resolveApiKeyForProvider"];
  } = {},
): AgenrOpenClawHost {
  const workspaceDir = path.join(os.tmpdir(), "agenr-openclaw-llm-client-workspace");
  const agentDir = path.join(os.tmpdir(), "agenr-openclaw-llm-client-agent");
  const config = {
    defaultAgent: "main",
    agents: {
      list: [
        {
          id: "main",
          workspace: workspaceDir,
          agentDir,
          model: options.model ?? "openai/gpt-5.4-mini",
        },
      ],
    },
  } as unknown as OpenClawConfig;

  return {
    config,
    runtime: {
      agent: {
        resolveAgentDir: () => agentDir,
        resolveAgentWorkspaceDir: () => workspaceDir,
        runEmbeddedPiAgent: async () => {
          throw new Error("Embedded agent unavailable.");
        },
      },
      modelAuth: {
        resolveApiKeyForProvider:
          options.resolveApiKeyForProvider ??
          (async () => ({
            apiKey: "openclaw-test-key",
            source: "profile:default",
            mode: "api-key",
          })),
      },
      state: {
        resolveStateDir: () => path.join(os.tmpdir(), ".openclaw"),
      },
    },
  };
}
