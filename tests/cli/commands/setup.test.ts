import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../../src/cli/main.js";
import { registerSetupCommand, runSetupCore, type SetupRuntime } from "../../../src/cli/commands/setup.js";
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
          ]
        : [
            { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
            { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
          ],
    testLlmConnection: vi.fn(async () => ({ ok: true })),
    testEmbeddingConnection: vi.fn(async () => ({ ok: true })),
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
  it("writes an OpenAI config that reuses the primary key for embeddings", async () => {
    const prompts = new FakePrompts(["openai", "sk-openai", "gpt-5.4-mini", false, "/tmp/custom-knowledge.db"]);
    const runtime = createSetupRuntime();

    const result = await runSetupCore({
      prompts,
      runtime,
    });

    expect(result).toEqual({
      config: {
        provider: "openai",
        model: "gpt-5.4-mini",
        apiKey: "sk-openai",
        dbPath: "/tmp/custom-knowledge.db",
      },
      configPath: "/tmp/.agenr/config.json",
      dbPath: "/tmp/custom-knowledge.db",
      provider: "openai",
      model: "gpt-5.4-mini",
      embeddingUsesPrimaryKey: true,
    });
    expect(runtime.testLlmConnection).toHaveBeenCalledWith("openai", "gpt-5.4-mini", "sk-openai");
    expect(runtime.testEmbeddingConnection).toHaveBeenCalledWith("sk-openai", "text-embedding-3-small");
    expect(runtime.writeConfig).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-5.4-mini",
      apiKey: "sk-openai",
      dbPath: "/tmp/custom-knowledge.db",
    });
    expect(prompts.notes.at(-1)?.title).toBe("Configuration saved");
  });

  it("prompts for a separate embedding key when Anthropic is selected", async () => {
    const prompts = new FakePrompts(["anthropic", "anthropic-key", "claude-sonnet-4-20250514", "openai-embedding-key", false, "/tmp/anthropic.db"]);
    const runtime = createSetupRuntime();

    const result = await runSetupCore({
      prompts,
      runtime,
    });

    expect(result?.embeddingUsesPrimaryKey).toBe(false);
    expect(runtime.writeConfig).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKey: "anthropic-key",
      embeddingApiKey: "openai-embedding-key",
      dbPath: "/tmp/anthropic.db",
    });
    expect(runtime.testEmbeddingConnection).toHaveBeenCalledWith("openai-embedding-key", "text-embedding-3-small");
  });

  it("allows skipping the provider connection test after a failure", async () => {
    const prompts = new FakePrompts(["openai", "bad-key", "skip", "gpt-5.4-mini", false, "/tmp/retry.db"]);
    const runtime = createSetupRuntime({
      testLlmConnection: vi.fn(async () => ({ ok: false, error: "401 invalid api key" })),
    });

    const result = await runSetupCore({
      prompts,
      runtime,
    });

    expect(result?.config.apiKey).toBe("bad-key");
    expect(prompts.log.warnMessages).toContain("Skipping the provider connection test. You can verify it later by running a recall or ingest command.");
    expect(runtime.writeConfig).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-5.4-mini",
      apiKey: "bad-key",
      dbPath: "/tmp/retry.db",
    });
  });
});
