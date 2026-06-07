import os from "node:os";
import path from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";

import { createAgenrOpenClawServices } from "../../../src/adapters/openclaw/runtime.js";
import type { AgenrOpenClawHost } from "../../../src/adapters/openclaw/types.js";
import { createTempRoot, usePluginRuntimeEnv, writeJson } from "../../app/plugin-runtime/helpers.js";

describe("createAgenrOpenClawServices", () => {
  usePluginRuntimeEnv();

  it("creates claim extraction from OpenClaw auth even when agenr LLM credentials are absent", async () => {
    const root = await createTempRoot("agenr-openclaw-runtime-");
    const dbPath = path.join(root, "knowledge.db");
    await writeJson(path.join(root, "config.json"), {
      claimExtraction: {
        enabled: true,
      },
    });
    const resolveApiKeyForProvider = vi.fn(async () => ({
      apiKey: "openclaw-claim-key",
      source: "profile:default",
      mode: "api-key" as const,
    }));

    const services = await createAgenrOpenClawServices(
      { dbPath },
      {
        openClaw: createOpenClawHost({
          resolveApiKeyForProvider,
        }),
      },
    );

    expect(services.claimExtraction).toBeDefined();
    expect(resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "openai",
      cfg: services.openClaw.config,
    });

    await services.close();
  });

  it("skips claim extraction when disabled in agenr config", async () => {
    const root = await createTempRoot("agenr-openclaw-runtime-");
    const dbPath = path.join(root, "knowledge.db");
    await writeJson(path.join(root, "config.json"), {
      claimExtraction: {
        enabled: false,
      },
    });
    const resolveApiKeyForProvider = vi.fn(async () => ({
      apiKey: "openclaw-claim-key",
      source: "profile:default",
      mode: "api-key" as const,
    }));

    const services = await createAgenrOpenClawServices(
      { dbPath },
      {
        openClaw: createOpenClawHost({
          resolveApiKeyForProvider,
        }),
      },
    );

    expect(services.claimExtraction).toBeUndefined();
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();

    await services.close();
  });

  it("disables claim extraction when OpenClaw credential resolution fails", async () => {
    const root = await createTempRoot("agenr-openclaw-runtime-");
    const dbPath = path.join(root, "knowledge.db");
    await writeJson(path.join(root, "config.json"), {
      claimExtraction: {
        enabled: true,
      },
    });
    const resolveApiKeyForProvider = vi.fn(async () => {
      throw new Error("missing OpenClaw auth profile");
    });

    const services = await createAgenrOpenClawServices(
      { dbPath },
      {
        openClaw: createOpenClawHost({
          resolveApiKeyForProvider,
        }),
      },
    );

    expect(services.claimExtraction).toBeUndefined();
    expect(resolveApiKeyForProvider).toHaveBeenCalledTimes(1);

    await services.close();
  });

  it("exposes a debug sink alongside shared memory services", async () => {
    const root = await createTempRoot("agenr-openclaw-runtime-");
    const dbPath = path.join(root, "knowledge.db");
    await writeJson(path.join(root, "config.json"), {
      credentials: {
        openaiApiKey: "config-key",
      },
    });

    const services = await createAgenrOpenClawServices(
      { dbPath },
      {
        openClaw: createOpenClawHost(),
      },
    );

    expect(services.debugSink).toBeDefined();
    expect(services.sessionStart.repository).toBeDefined();
    expect(services.routeSessionMemoryTrigger).toBeTypeOf("function");
    expect(services.workingMemory).toBeDefined();

    await services.close();
  });

  it("applies the OpenClaw resolvePath hook when resolving plugin paths", async () => {
    const root = await createTempRoot("agenr-openclaw-runtime-");
    await writeJson(path.join(root, "config.json"), {
      credentials: {
        openaiApiKey: "config-key",
      },
    });

    const services = await createAgenrOpenClawServices(
      { dbPath: "relative/knowledge.db" },
      {
        openClaw: createOpenClawHost(),
        resolvePath: (input) => path.join(root, input),
      },
    );

    expect(services.config.dbPath).toBe(path.join(root, "relative/knowledge.db"));

    await services.close();
  });
});

function createOpenClawHost(
  options: {
    model?: string;
    resolveApiKeyForProvider?: AgenrOpenClawHost["runtime"]["modelAuth"]["resolveApiKeyForProvider"];
  } = {},
): AgenrOpenClawHost {
  const workspaceDir = path.join(os.tmpdir(), "agenr-openclaw-test-workspace");
  const agentDir = path.join(os.tmpdir(), "agenr-openclaw-test-agent");
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
          throw new Error("Embedded continuity summary runner unavailable.");
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
