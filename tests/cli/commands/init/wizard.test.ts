import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runInitWizard, type InitWizardRuntime } from "../../../../src/cli/commands/init/wizard.js";
import { FakePrompts } from "../../../cli/fake-prompts.js";

const tempDirs: string[] = [];
const originalConfigPath = process.env.AGENR_CONFIG_PATH;

beforeEach(async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agenr-init-test-"));
  tempDirs.push(directory);
  process.env.AGENR_CONFIG_PATH = path.join(directory, "config.json");
});

afterEach(async () => {
  if (originalConfigPath === undefined) {
    delete process.env.AGENR_CONFIG_PATH;
  } else {
    process.env.AGENR_CONFIG_PATH = originalConfigPath;
  }

  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

function createInitRuntime(overrides: Partial<InitWizardRuntime> = {}): InitWizardRuntime {
  return {
    runSetupCore: vi.fn(async () => ({
      config: {
        auth: "openai-api-key",
        provider: "openai",
        model: "gpt-5.4-mini",
        credentials: {
          openaiApiKey: "sk-test",
        },
        dbPath: "/tmp/knowledge.db",
      },
      configPath: process.env.AGENR_CONFIG_PATH ?? "/tmp/config.json",
      dbPath: "/tmp/knowledge.db",
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-5.4-mini",
      embeddingUsesPrimaryKey: true,
    })),
    detectOpenClawInstallation: vi.fn(() => ({
      detected: false,
      stateDir: "/tmp/.openclaw",
      configPath: "/tmp/.openclaw/openclaw.json",
      sessionsRoot: "/tmp/.openclaw/agents",
      source: "default" as const,
    })),
    installOpenClawPlugin: vi.fn(async () => ({ success: true, message: "agenr plugin installed" })),
    restartOpenClawGateway: vi.fn(async () => ({ success: true, message: "OpenClaw gateway restarted" })),
    writeOpenClawPluginConfig: vi.fn(async () => "/tmp/.openclaw/openclaw.json"),
    scanSessionFiles: vi.fn(async () => ({
      totalFiles: 0,
      allFiles: [],
      recentFiles: [],
      totalSizeBytes: 0,
      recentSizeBytes: 0,
    })),
    estimateIngestCost: vi.fn((totalBytes, modelId) => ({
      inputTokens: totalBytes,
      outputTokens: Math.ceil(totalBytes * 0.1),
      inputCostUsd: 0,
      outputCostUsd: 0,
      totalCostUsd: 0,
      modelId,
    })),
    runBulkIngest: vi.fn(async () => ({
      filesProcessed: 1,
      storedEntries: 2,
      failedFiles: 0,
      totalCostUsd: 0.01,
    })),
    ...overrides,
  };
}

describe("runInitWizard", () => {
  it("skips OpenClaw integration when OpenClaw is not detected", async () => {
    const prompts = new FakePrompts([]);
    const runtime = createInitRuntime();

    await runInitWizard({
      prompts,
      runtime,
    });

    expect(runtime.runSetupCore).toHaveBeenCalledTimes(1);
    expect(runtime.installOpenClawPlugin).not.toHaveBeenCalled();
    expect(runtime.scanSessionFiles).not.toHaveBeenCalled();
    expect(prompts.notes.at(-1)?.message).toContain("OpenClaw: not detected");
  });

  it("installs the plugin, restarts the gateway, and ingests recent sessions when detected", async () => {
    const prompts = new FakePrompts([true, "recent"]);
    const runtime = createInitRuntime({
      detectOpenClawInstallation: vi.fn(() => ({
        detected: true,
        stateDir: "/tmp/.openclaw",
        configPath: "/tmp/.openclaw/openclaw.json",
        sessionsRoot: "/tmp/.openclaw/agents",
        source: "default" as const,
      })),
      restartOpenClawGateway: vi.fn(async () => ({
        success: false,
        message: "OpenClaw gateway needs a manual restart: `openclaw gateway restart`.",
      })),
      scanSessionFiles: vi.fn(async () => ({
        totalFiles: 2,
        allFiles: ["/tmp/.openclaw/agents/main/sessions/a.jsonl", "/tmp/.openclaw/agents/main/sessions/b.jsonl"],
        recentFiles: ["/tmp/.openclaw/agents/main/sessions/b.jsonl"],
        totalSizeBytes: 4000,
        recentSizeBytes: 1000,
      })),
      runBulkIngest: vi.fn(async () => ({
        filesProcessed: 1,
        storedEntries: 5,
        failedFiles: 0,
        totalCostUsd: 0.02,
      })),
    });

    await runInitWizard({
      prompts,
      runtime,
    });

    expect(runtime.installOpenClawPlugin).toHaveBeenCalledTimes(1);
    expect(runtime.writeOpenClawPluginConfig).toHaveBeenCalledWith("/tmp/.openclaw", {
      dbPath: "/tmp/knowledge.db",
      configPath: process.env.AGENR_CONFIG_PATH,
    });
    expect(runtime.restartOpenClawGateway).toHaveBeenCalledTimes(1);
    expect(runtime.runBulkIngest).toHaveBeenCalledWith(["/tmp/.openclaw/agents/main/sessions/b.jsonl"], expect.any(Object), prompts);
    expect(prompts.outros.at(-1)).toContain("openclaw gateway restart");
  });
});
