import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../../src/cli/main.js";
import {
  buildStageAuthOptions,
  filterSetupModelsForAuth,
  formatExistingConfig,
  getSetupReadiness,
  registerSetupCommand,
  runSetupCore,
  type SetupRuntime,
} from "../../../src/cli/commands/setup.js";
import {
  appendSetupStageSummaryLines,
  applySetupStageOverrides,
  collectSetupStageProviders,
  readSetupStageOverrides,
  SETUP_MODEL_STAGES,
} from "../../../src/cli/commands/setup/stages.js";
import { FakePrompts } from "../../cli/fake-prompts.js";
import { resolveTestPath } from "../../helpers/temp-paths.js";

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
      const needsAnthropicOverride =
        config.extractionModel?.provider === "anthropic" ||
        config.dedupModel?.provider === "anthropic" ||
        config.episodeModel?.provider === "anthropic" ||
        config.claimExtraction?.model?.provider === "anthropic" ||
        config.dreaming?.model?.provider === "anthropic";

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

describe("setup stage helpers", () => {
  it("keeps every CLI-context model stage registered in prompt order", () => {
    expect(SETUP_MODEL_STAGES).toHaveLength(5);
    expect(SETUP_MODEL_STAGES.map((stage) => stage.id)).toEqual(["extraction", "dedup", "episode", "claim", "dreaming"]);
  });

  it("returns all stage keys when no config exists", () => {
    expect(readSetupStageOverrides(undefined)).toEqual({
      extraction: undefined,
      dedup: undefined,
      episode: undefined,
      claim: undefined,
      dreaming: undefined,
    });
  });

  it("reads the claim override from nested claim-extraction config", () => {
    expect(
      readSetupStageOverrides({
        claimExtraction: {
          model: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
        },
      }),
    ).toEqual({
      extraction: undefined,
      dedup: undefined,
      episode: undefined,
      claim: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
      dreaming: undefined,
    });
  });

  it("persists a claim override into claimExtraction.model", () => {
    const config = applySetupStageOverrides({}, readSetupStageOverrides(undefined));
    const nextConfig = applySetupStageOverrides(config, {
      ...readSetupStageOverrides(undefined),
      claim: {
        provider: "openai",
        model: "gpt-5.4",
      },
    });

    expect(nextConfig.claimExtraction).toEqual({
      model: {
        provider: "openai",
        model: "gpt-5.4",
      },
    });
  });

  it("preserves sibling claim-extraction fields when setting a claim override", () => {
    const nextConfig = applySetupStageOverrides(
      {
        claimExtraction: {
          enabled: true,
          confidenceThreshold: 0.9,
          concurrency: 12,
        },
      },
      {
        ...readSetupStageOverrides(undefined),
        claim: {
          provider: "openai",
          model: "gpt-5.4-mini",
        },
      },
    );

    expect(nextConfig.claimExtraction).toEqual({
      enabled: true,
      confidenceThreshold: 0.9,
      concurrency: 12,
      model: {
        provider: "openai",
        model: "gpt-5.4-mini",
      },
    });
  });

  it("drops an empty claim-extraction config when the claim override is cleared", () => {
    const nextConfig = applySetupStageOverrides(
      {
        claimExtraction: {
          model: {
            provider: "openai",
            model: "gpt-5.4",
          },
        },
      },
      readSetupStageOverrides(undefined),
    );

    expect(nextConfig.claimExtraction).toBeUndefined();
  });

  it("adds a claim extraction summary line when a claim override is configured", () => {
    const lines: string[] = [];
    appendSetupStageSummaryLines(lines, {
      claimExtraction: {
        model: {
          provider: "openai",
          model: "gpt-5.4",
        },
      },
    });

    expect(lines).toEqual(expect.arrayContaining([expect.stringContaining("Claim extraction override")]));
    expect(lines).toEqual(expect.arrayContaining([expect.stringContaining("openai/gpt-5.4")]));
  });

  it("collects providers from the claim override", () => {
    expect(
      collectSetupStageProviders({
        claimExtraction: {
          model: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
        },
      }),
    ).toContain("anthropic");
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

    expect(result).toMatchObject({
      config: {
        auth: "openai-api-key",
        provider: "openai",
        model: "gpt-5.4-mini",
        credentials: {
          openaiApiKey: "sk-openai",
        },
        dbPath: resolveTestPath("/tmp/custom-knowledge.db"),
      },
      configPath: "/tmp/.agenr/config.json",
      dbPath: resolveTestPath("/tmp/custom-knowledge.db"),
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-5.4-mini",
      embeddingUsesPrimaryKey: true,
      ready: true,
    });
    expect(runtime.testLlmConnection).toHaveBeenCalledWith("openai", "gpt-5.4-mini", "sk-openai");
    expect(runtime.testEmbeddingConnection).toHaveBeenCalledWith("sk-openai", "text-embedding-3-small");
    expect(runtime.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: "openai-api-key",
        provider: "openai",
        model: "gpt-5.4-mini",
        credentials: {
          openaiApiKey: "sk-openai",
        },
        dbPath: resolveTestPath("/tmp/custom-knowledge.db"),
      }),
    );
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
    expect(runtime.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: "anthropic-api-key",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        credentials: {
          anthropicApiKey: "anthropic-key",
          openaiApiKey: "openai-embedding-key",
        },
        dbPath: resolveTestPath("/tmp/anthropic.db"),
      }),
    );
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
    expect(runtime.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: "openai-api-key",
        provider: "openai",
        model: "gpt-5.4-mini",
        credentials: {
          openaiApiKey: "bad-key",
        },
        dbPath: resolveTestPath("/tmp/retry.db"),
      }),
    );
  });

  it("supports OpenAI subscription auth without persisting the detected subscription token", async () => {
    const prompts = new FakePrompts(["advanced-options", "openai-subscription", "gpt-5.4-mini", "openai-embedding-key", false, "/tmp/subscription.db"]);
    const runtime = createSetupRuntime({
      probeCredentials: vi.fn<SetupRuntime["probeCredentials"]>(() => ({
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

    expect(result).toMatchObject({
      config: {
        auth: "openai-subscription",
        provider: "openai-codex",
        model: "gpt-5.4-mini",
        credentials: {
          openaiApiKey: "openai-embedding-key",
        },
        dbPath: resolveTestPath("/tmp/subscription.db"),
      },
      configPath: "/tmp/.agenr/config.json",
      dbPath: resolveTestPath("/tmp/subscription.db"),
      auth: "openai-subscription",
      provider: "openai-codex",
      model: "gpt-5.4-mini",
      embeddingUsesPrimaryKey: false,
      ready: true,
    });
    expect(runtime.testLlmConnection).toHaveBeenCalledWith("openai-codex", "gpt-5.4-mini", "subscription-token");
    expect(runtime.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: "openai-subscription",
        provider: "openai-codex",
        model: "gpt-5.4-mini",
        credentials: {
          openaiApiKey: "openai-embedding-key",
        },
        dbPath: resolveTestPath("/tmp/subscription.db"),
      }),
    );
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

    expect(result?.config).toMatchObject({
      auth: "anthropic-oauth",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      credentials: {
        openaiApiKey: "openai-embedding-key",
      },
      dbPath: resolveTestPath("/tmp/oauth.db"),
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
        dbPath: resolveTestPath("/tmp/custom-knowledge.db"),
      },
    });

    expect(result?.config.dedupModel).toEqual({
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(prompts.notes.at(-1)?.message).not.toContain("Dedup override");
  });

  it("writes a dreaming override from the advanced task-specific model flow", async () => {
    const prompts = new FakePrompts([
      "openai-api-key",
      "sk-openai",
      "gpt-5.4-mini",
      true,
      "default",
      "default",
      "default",
      "default",
      "custom",
      "gpt-5.4",
      "/tmp/surgeon.db",
    ]);
    const runtime = createSetupRuntime();

    const result = await runSetupCore({
      prompts,
      runtime,
    });

    expect(result?.config.dreaming?.model).toEqual({
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(runtime.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: "openai-api-key",
        provider: "openai",
        model: "gpt-5.4-mini",
        credentials: {
          openaiApiKey: "sk-openai",
        },
        dreaming: {
          model: {
            provider: "openai",
            model: "gpt-5.4",
          },
        },
        dbPath: resolveTestPath("/tmp/surgeon.db"),
      }),
    );
    expect(prompts.confirmCalls.some((call) => call.message === "Customize task-specific models? (Advanced)")).toBe(true);
    expect(prompts.notes.at(-1)?.message).toContain("Dreaming override");
  });

  it("writes an episode override from the advanced task-specific model flow", async () => {
    const prompts = new FakePrompts([
      "openai-api-key",
      "sk-openai",
      "gpt-5.4-mini",
      true,
      "default",
      "default",
      "custom",
      "gpt-5.4",
      "default",
      "default",
      "/tmp/episode.db",
    ]);
    const runtime = createSetupRuntime();

    const result = await runSetupCore({
      prompts,
      runtime,
    });

    expect(result?.config.episodeModel).toEqual({
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(runtime.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: "openai-api-key",
        provider: "openai",
        model: "gpt-5.4-mini",
        credentials: {
          openaiApiKey: "sk-openai",
        },
        episodeModel: {
          provider: "openai",
          model: "gpt-5.4",
        },
        dbPath: resolveTestPath("/tmp/episode.db"),
      }),
    );
    expect(prompts.notes.at(-1)?.message).toContain("Episode override");
  });

  it("preserves an existing dreaming override when customization is skipped", async () => {
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
        dreaming: {
          model: {
            provider: "openai",
            model: "gpt-5.4",
          },
        },
        dbPath: resolveTestPath("/tmp/custom-knowledge.db"),
      },
    });

    expect(result?.config.dreaming?.model).toEqual({
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(runtime.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: "openai-api-key",
        provider: "openai",
        model: "gpt-5.4-mini",
        credentials: {
          openaiApiKey: "sk-openai",
        },
        dreaming: {
          model: {
            provider: "openai",
            model: "gpt-5.4",
          },
        },
        dbPath: resolveTestPath("/tmp/custom-knowledge.db"),
      }),
    );
    expect(prompts.notes.at(-1)?.message).not.toContain("Dreaming override");
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
        dbPath: resolveTestPath("/tmp/custom-knowledge.db"),
      },
    });

    expect(result?.ready).toBe(false);
    expect(prompts.notes.at(-1)?.message).toContain("Status: Needs additional credentials before use");
  });
});

describe("formatExistingConfig", () => {
  it("shows the dreaming override when configured", () => {
    const summary = formatExistingConfig(
      {
        auth: "openai-api-key",
        provider: "openai",
        model: "gpt-5.4-mini",
        credentials: {
          openaiApiKey: "sk-openai",
        },
        dreaming: {
          model: {
            provider: "openai",
            model: "gpt-5.4",
          },
        },
      },
      "/tmp/.agenr/config.json",
      "/tmp/.agenr/knowledge.db",
    );

    expect(summary).toContain("Dreaming override");
    expect(summary).toContain("openai/gpt-5.4");
  });

  it("shows the episode override when configured", () => {
    const summary = formatExistingConfig(
      {
        auth: "openai-api-key",
        provider: "openai",
        model: "gpt-5.4-mini",
        credentials: {
          openaiApiKey: "sk-openai",
        },
        episodeModel: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
      },
      "/tmp/.agenr/config.json",
      "/tmp/.agenr/knowledge.db",
    );

    expect(summary).toContain("Episode override");
    expect(summary).toContain("anthropic/claude-sonnet-4-6");
  });
});

describe("getSetupReadiness", () => {
  it("requires credentials for the episode override provider", () => {
    expect(
      getSetupReadiness(
        {
          auth: "openai-api-key",
          provider: "openai",
          model: "gpt-5.4-mini",
          credentials: {
            openaiApiKey: "sk-openai",
          },
          episodeModel: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
        },
        {},
      ),
    ).toEqual({
      ready: false,
      guidance: 'No credential found for provider "anthropic". Set the appropriate auth method in config or provide ANTHROPIC_API_KEY.',
    });
  });

  it("requires credentials for the dreaming override provider", () => {
    expect(
      getSetupReadiness(
        {
          auth: "openai-api-key",
          provider: "openai",
          model: "gpt-5.4-mini",
          credentials: {
            openaiApiKey: "sk-openai",
          },
          dreaming: {
            model: {
              provider: "anthropic",
              model: "claude-sonnet-4-6",
            },
          },
        },
        {},
      ),
    ).toEqual({
      ready: false,
      guidance: 'No credential found for provider "anthropic". Set the appropriate auth method in config or provide ANTHROPIC_API_KEY.',
    });
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
