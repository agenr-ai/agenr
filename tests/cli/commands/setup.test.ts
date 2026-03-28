import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../../src/cli/main.js";
import { buildStageAuthOptions, filterSetupModelsForAuth, registerSetupCommand, runSetupCore, type SetupRuntime } from "../../../src/cli/commands/setup.js";
import { FakePrompts } from "../../cli/fake-prompts.js";

function createSetupRuntime(overrides: Partial<SetupRuntime> = {}): SetupRuntime {
  return {
    resolveConfigPath: () => "/tmp/.agenr/config.json",
    resolveDbPath: () => "/tmp/.agenr/knowledge.db",
    writeConfig: vi.fn(),
    getModelsForProvider: (provider) =>
      provider === "openai"
        ? [
            { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
            { id: "gpt-5.4", name: "GPT-5.4" },
            { id: "gpt-5.4-nano", name: "GPT-5.4 Nano" },
          ]
        : provider === "openai-codex"
          ? [
              { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
              { id: "gpt-5.4", name: "GPT-5.4" },
            ]
          : [
              { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
              { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
              { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
            ],
    probeCredentials: vi.fn(() => ({
      available: false,
      guidance: "Credentials unavailable.",
    })),
    testLlmConnection: vi.fn(async () => ({ ok: true })),
    testEmbeddingConnection: vi.fn(async () => ({ ok: true })),
    getSetupReadiness: vi.fn((config) => {
      const hasOpenAiKey = Boolean(config.credentials?.openaiApiKey?.trim());
      const hasAnthropicApiKey = Boolean(config.credentials?.anthropicApiKey?.trim());
      const hasAnthropicToken = Boolean(config.credentials?.anthropicOauthToken?.trim());
      const needsAnthropicOverride = config.extractionModel?.provider === "anthropic" || config.dedupModel?.provider === "anthropic";

      if (!config.provider || !config.model) {
        return { ready: false, guidance: "Provider and model must both be configured." };
      }

      switch (config.auth) {
        case "openai-api-key":
          if (!hasOpenAiKey || needsAnthropicOverride) {
            return { ready: false, guidance: "Additional credentials are still required before agenr can run." };
          }
          return { ready: true };
        case "anthropic-api-key":
          return hasAnthropicApiKey && hasOpenAiKey
            ? { ready: true }
            : { ready: false, guidance: "Additional credentials are still required before agenr can run." };
        case "anthropic-token":
          return hasAnthropicToken && hasOpenAiKey
            ? { ready: true }
            : { ready: false, guidance: "Additional credentials are still required before agenr can run." };
        case "anthropic-oauth":
        case "openai-subscription":
          return { ready: false, guidance: "External credentials unavailable." };
        default:
          return { ready: false, guidance: "Provider and model must both be configured." };
      }
    }),
    ...overrides,
  };
}

describe("registerSetupCommand", () => {
  it("registers the setup command on the program", () => {
    const program = createProgram();

    expect(program.commands.some((command) => command.name() === "setup")).toBe(true);
  });

  it("can be registered on a standalone commander program", () => {
    const program = new Command();
    registerSetupCommand(program);

    expect(program.commands.filter((command) => command.name() === "setup")).toHaveLength(1);
  });
});

describe("runSetupCore", () => {
  it("writes an OpenAI API-key config that reuses the primary key for embeddings", async () => {
    const prompts = new FakePrompts(["openai-api-key", "sk-openai", "gpt-5.4-mini", false, "/tmp/custom-knowledge.db"]);
    const runtime = createSetupRuntime();

    const result = await runSetupCore({
      prompts,
      runtime,
    });

    expect(result).toEqual({
      config: {
        auth: "openai-api-key",
        provider: "openai",
        model: "gpt-5.4-mini",
        credentials: {
          openaiApiKey: "sk-openai",
        },
        dbPath: "/tmp/custom-knowledge.db",
      },
      configPath: "/tmp/.agenr/config.json",
      dbPath: "/tmp/custom-knowledge.db",
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-5.4-mini",
      embeddingUsesPrimaryKey: true,
      ready: true,
    });
    expect(runtime.testLlmConnection).toHaveBeenCalledWith("openai", "gpt-5.4-mini", "sk-openai");
    expect(runtime.testEmbeddingConnection).toHaveBeenCalledWith("sk-openai", "text-embedding-3-small");
    expect(runtime.writeConfig).toHaveBeenCalledWith({
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-5.4-mini",
      credentials: {
        openaiApiKey: "sk-openai",
      },
      dbPath: "/tmp/custom-knowledge.db",
    });
    expect(prompts.notes.at(-1)?.title).toBe("Configuration saved");
  });

  it("prompts for a separate embedding key when Anthropic API-key auth is selected", async () => {
    const prompts = new FakePrompts(["anthropic-api-key", "anthropic-key", "claude-sonnet-4-6", "openai-embedding-key", false, "/tmp/anthropic.db"]);
    const runtime = createSetupRuntime();

    const result = await runSetupCore({
      prompts,
      runtime,
    });

    expect(result?.embeddingUsesPrimaryKey).toBe(false);
    expect(runtime.writeConfig).toHaveBeenCalledWith({
      auth: "anthropic-api-key",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      credentials: {
        anthropicApiKey: "anthropic-key",
        openaiApiKey: "openai-embedding-key",
      },
      dbPath: "/tmp/anthropic.db",
    });
    expect(runtime.testEmbeddingConnection).toHaveBeenCalledWith("openai-embedding-key", "text-embedding-3-small");
  });

  it("allows skipping the provider connection test after a failure", async () => {
    const prompts = new FakePrompts(["openai-api-key", "bad-key", "skip", "gpt-5.4-mini", false, "/tmp/retry.db"]);
    const runtime = createSetupRuntime({
      testLlmConnection: vi.fn(async () => ({ ok: false, error: "401 invalid api key" })),
    });

    const result = await runSetupCore({
      prompts,
      runtime,
    });

    expect(result?.config.credentials?.openaiApiKey).toBe("bad-key");
    expect(prompts.log.warnMessages).toContain("Skipping the provider connection test. You can verify it later by running a recall or ingest command.");
    expect(runtime.writeConfig).toHaveBeenCalledWith({
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-5.4-mini",
      credentials: {
        openaiApiKey: "bad-key",
      },
      dbPath: "/tmp/retry.db",
    });
  });

  it("supports OpenAI subscription auth without persisting the detected subscription token", async () => {
    const prompts = new FakePrompts(["advanced-options", "openai-subscription", "gpt-5.4-mini", "openai-embedding-key", false, "/tmp/subscription.db"]);
    const runtime = createSetupRuntime({
      probeCredentials: vi.fn(() => ({
        available: true,
        source: "file:/tmp/.codex/auth.json",
        guidance: "Credentials available.",
        credentials: {
          apiKey: "subscription-token",
          source: "file:/tmp/.codex/auth.json",
          auth: "openai-subscription",
        },
      })),
      getSetupReadiness: vi.fn(() => ({ ready: true })),
    });

    const result = await runSetupCore({
      prompts,
      runtime,
    });

    expect(result).toEqual({
      config: {
        auth: "openai-subscription",
        provider: "openai-codex",
        model: "gpt-5.4-mini",
        credentials: {
          openaiApiKey: "openai-embedding-key",
        },
        dbPath: "/tmp/subscription.db",
      },
      configPath: "/tmp/.agenr/config.json",
      dbPath: "/tmp/subscription.db",
      auth: "openai-subscription",
      provider: "openai-codex",
      model: "gpt-5.4-mini",
      embeddingUsesPrimaryKey: false,
      ready: true,
    });
    expect(runtime.testLlmConnection).toHaveBeenCalledWith("openai-codex", "gpt-5.4-mini", "subscription-token");
    expect(runtime.writeConfig).toHaveBeenCalledWith({
      auth: "openai-subscription",
      provider: "openai-codex",
      model: "gpt-5.4-mini",
      credentials: {
        openaiApiKey: "openai-embedding-key",
      },
      dbPath: "/tmp/subscription.db",
    });
  });

  it("shows guidance and continues when OAuth credentials are unavailable", async () => {
    const prompts = new FakePrompts(["advanced-options", "anthropic-oauth", "claude-sonnet-4-6", "openai-embedding-key", false, "/tmp/oauth.db"]);
    const runtime = createSetupRuntime({
      probeCredentials: vi.fn(() => ({
        available: false,
        guidance: "Claude Code credentials not found. Install Claude Code CLI and sign in with `claude`.",
      })),
    });

    const result = await runSetupCore({
      prompts,
      runtime,
    });

    expect(result?.config).toEqual({
      auth: "anthropic-oauth",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      credentials: {
        openaiApiKey: "openai-embedding-key",
      },
      dbPath: "/tmp/oauth.db",
    });
    expect(result?.ready).toBe(false);
    expect(prompts.log.warnMessages).toContain("Claude Code credentials not found. Install Claude Code CLI and sign in with `claude`.");
    expect(runtime.testLlmConnection).not.toHaveBeenCalled();
    expect(prompts.notes.at(-1)?.message).toContain("Status: Needs additional credentials before use");
  });

  it("does not repeat an unchanged dedup override in the saved summary", async () => {
    const prompts = new FakePrompts(["openai-api-key", true, "gpt-5.4-mini", false, "/tmp/custom-knowledge.db"]);
    const runtime = createSetupRuntime();

    const result = await runSetupCore({
      prompts,
      runtime,
      existingConfig: {
        auth: "openai-api-key",
        provider: "openai",
        model: "gpt-5.4-mini",
        credentials: {
          openaiApiKey: "sk-openai",
        },
        dedupModel: {
          provider: "openai",
          model: "gpt-5.4",
        },
        dbPath: "/tmp/custom-knowledge.db",
      },
    });

    expect(result?.config.dedupModel).toEqual({
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(prompts.notes.at(-1)?.message).not.toContain("Dedup override");
  });

  it("marks configs with unavailable override credentials as not ready", async () => {
    const prompts = new FakePrompts(["openai-api-key", true, "gpt-5.4-mini", false, "/tmp/custom-knowledge.db"]);
    const runtime = createSetupRuntime();

    const result = await runSetupCore({
      prompts,
      runtime,
      existingConfig: {
        auth: "openai-api-key",
        provider: "openai",
        model: "gpt-5.4-mini",
        credentials: {
          openaiApiKey: "sk-openai",
        },
        dedupModel: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
        dbPath: "/tmp/custom-knowledge.db",
      },
    });

    expect(result?.ready).toBe(false);
    expect(prompts.notes.at(-1)?.message).toContain("Status: Needs additional credentials before use");
  });
});

describe("buildStageAuthOptions", () => {
  it("only includes alternate auth profiles when their credentials are already available", () => {
    const runtime = createSetupRuntime({
      probeCredentials: vi.fn((auth) => ({
        available: auth === "openai-api-key",
        guidance: auth === "anthropic-api-key" ? "No Anthropic API key found." : "Credentials available.",
      })),
    });

    const authOptions = buildStageAuthOptions(runtime, "openai-api-key", {
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-5.4-mini",
      credentials: {
        openaiApiKey: "sk-openai",
      },
    });

    expect(authOptions).toEqual([
      {
        value: "openai-api-key",
        label: "OpenAI API key",
        hint: "current default",
      },
    ]);
    expect(runtime.probeCredentials).toHaveBeenCalledWith("anthropic-api-key", expect.anything());
  });
});

describe("filterSetupModelsForAuth", () => {
  it("excludes gpt-5.4-nano for OpenAI subscription auth", () => {
    expect(filterSetupModelsForAuth("openai-subscription", [{ id: "gpt-5.4-mini" }, { id: "gpt-5.4" }, { id: "gpt-5.4-nano" }])).toEqual([
      { id: "gpt-5.4-mini" },
      { id: "gpt-5.4" },
    ]);
  });
});
