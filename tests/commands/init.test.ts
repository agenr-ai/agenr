import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as configModule from "../../src/config.js";
import { readConfig, writeConfig } from "../../src/config.js";
import type { AgenrConfig } from "../../src/types.js";

function createMocks() {
  const cancelToken = Symbol("cancel");
  const introMock = vi.fn();
  const noteMock = vi.fn();
  const confirmMock = vi.fn();
  const selectMock = vi.fn();
  const textMock = vi.fn();
  const cancelMock = vi.fn();
  const outroMock = vi.fn();
  const spinnerStartMock = vi.fn();
  const spinnerStopMock = vi.fn();
  const spinnerMock = vi.fn(() => ({
    start: spinnerStartMock,
    stop: spinnerStopMock,
    message: vi.fn(),
    cancel: vi.fn(),
    error: vi.fn(),
    clear: vi.fn(),
    isCancelled: false,
  }));
  const logMock = {
    warn: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
  };

  return {
    cancelToken,
    introMock,
    noteMock,
    confirmMock,
    selectMock,
    textMock,
    cancelMock,
    outroMock,
    spinnerStartMock,
    spinnerStopMock,
    spinnerMock,
    logMock,
  };
}

type InitMocks = ReturnType<typeof createMocks>;
var mocks: InitMocks | undefined;

function getMocks(): InitMocks {
  if (!mocks) {
    mocks = createMocks();
  }
  return mocks;
}

function queueResponses(mockFn: ReturnType<typeof vi.fn>, values: unknown[], kind: string): void {
  mockFn.mockImplementation(async () => {
    if (values.length === 0) {
      throw new Error(`Unexpected ${kind} prompt`);
    }
    return values.shift();
  });
}

vi.mock("@clack/prompts", () => ({
  intro: getMocks().introMock,
  note: getMocks().noteMock,
  confirm: getMocks().confirmMock,
  select: getMocks().selectMock,
  text: getMocks().textMock,
  cancel: getMocks().cancelMock,
  outro: getMocks().outroMock,
  spinner: getMocks().spinnerMock,
  log: getMocks().logMock,
  isCancel: (value: unknown) => value === getMocks().cancelToken,
}));

import * as initModule from "../../src/commands/init.js";

const tempDirs: string[] = [];
let previousConfigPath: string | undefined;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function setupExistingConfig(
  projectDir: string,
  overrides: Partial<AgenrConfig> = {},
): Promise<NodeJS.ProcessEnv> {
  const configDir = await makeTempDir("agenr-init-config-test-");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENR_CONFIG_PATH: path.join(configDir, "config.json"),
  };
  process.env.AGENR_CONFIG_PATH = env.AGENR_CONFIG_PATH;

  const base: AgenrConfig = {
    auth: "openai-api-key",
    provider: "openai",
    models: {
      extraction: "gpt-4.1-mini",
      claimExtraction: "gpt-4.1-nano",
      contradictionJudge: "gpt-4.1-nano",
      handoffSummary: "gpt-4.1-nano",
    },
    projects: {
      [path.resolve(projectDir)]: {
        project: "codex-project",
        platform: "codex",
      },
    },
  };

  writeConfig(
    {
      ...base,
      ...overrides,
      projects: overrides.projects ?? base.projects,
    },
    env,
  );

  return env;
}

function mockWizardRuntime(projectDir: string): void {
  vi.spyOn(initModule.initWizardRuntime, "detectPlatforms").mockReturnValue([
    {
      id: "codex",
      label: "Codex",
      detected: true,
      configDir: projectDir,
      sessionsDir: path.join(projectDir, "sessions"),
    },
  ]);
  vi.spyOn(initModule.initWizardRuntime, "runInitCommand").mockResolvedValue({
    platform: "codex",
    project: "codex-project",
    projectDir,
    dependencies: [],
    configPath: process.env.AGENR_CONFIG_PATH ?? path.join(projectDir, "config.json"),
    instructionsPath: null,
    mcpPath: path.join(projectDir, "mcp.json"),
    mcpSkipped: false,
    gitignoreUpdated: false,
  });
  vi.spyOn(initModule.initWizardRuntime, "runSetupCore").mockResolvedValue({
    auth: "openai-api-key",
    provider: "openai",
    model: "gpt-4.1-mini",
    config: {
      auth: "openai-api-key",
      provider: "openai",
      models: {
        extraction: "gpt-4.1-mini",
        claimExtraction: "gpt-4.1-nano",
        contradictionJudge: "gpt-4.1-nano",
        handoffSummary: "gpt-4.1-nano",
      },
    },
    changed: false,
  });
  vi.spyOn(initModule.initWizardRuntime, "scanSessionFiles").mockResolvedValue({
    totalFiles: 0,
    recentFiles: [],
    allFiles: [],
    totalSizeBytes: 0,
    recentSizeBytes: 0,
  });
}

beforeEach(() => {
  previousConfigPath = process.env.AGENR_CONFIG_PATH;
  vi.clearAllMocks();
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
});

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
  if (previousConfigPath) {
    process.env.AGENR_CONFIG_PATH = previousConfigPath;
  } else {
    delete process.env.AGENR_CONFIG_PATH;
  }
  vi.restoreAllMocks();
});

describe("task model defaults", () => {
  it("resolveTaskModelDefaults applies the base model to all tasks", () => {
    expect(initModule.resolveTaskModelDefaults("claude-sonnet-4-20250514")).toEqual({
      extraction: "claude-sonnet-4-20250514",
      claimExtraction: "claude-sonnet-4-20250514",
      contradictionJudge: "claude-sonnet-4-20250514",
      handoffSummary: "claude-sonnet-4-20250514",
    });
  });
});

describe("init wizard auth/model reconfigure", () => {
  it("updates model via change-model without re-running auth setup", async () => {
    const current = getMocks();
    const projectDir = await makeTempDir("agenr-init-project-test-");
    const env = await setupExistingConfig(projectDir);
    mockWizardRuntime(projectDir);

    queueResponses(current.confirmMock, [true], "confirm");
    queueResponses(current.selectMock, ["change-model", "gpt-4.1", "no", "keep", "keep", "keep"], "select");
    queueResponses(current.textMock, [], "text");

    await initModule.runInitWizard({
      isInteractive: true,
      path: projectDir,
    });

    expect(readConfig(env)?.models?.extraction).toBe("gpt-4.1");
    expect(initModule.initWizardRuntime.runSetupCore).not.toHaveBeenCalled();

    const messages = current.selectMock.mock.calls.map((call) => {
      const args = call[0] as { message?: string };
      return args.message ?? "";
    });
    expect(messages).toContain("Select default model:");
    expect(messages).toContain("Configure per-task models? (Advanced)");
  });

  it("does not persist config when user cancels after model-only change", async () => {
    const current = getMocks();
    const projectDir = await makeTempDir("agenr-init-project-test-");
    const env = await setupExistingConfig(projectDir);
    mockWizardRuntime(projectDir);

    const writeConfigSpy = vi.spyOn(configModule, "writeConfig");
    writeConfigSpy.mockClear();

    queueResponses(current.confirmMock, [true], "confirm");
    queueResponses(current.selectMock, ["change-model", "gpt-4.1", current.cancelToken], "select");
    queueResponses(current.textMock, [], "text");

    await initModule.runInitWizard({
      isInteractive: true,
      path: projectDir,
    });

    expect(writeConfigSpy).not.toHaveBeenCalled();
    expect(readConfig(env)?.models?.extraction).toBe("gpt-4.1-mini");
  });

  it("keeps current auth and model without showing model picker", async () => {
    const current = getMocks();
    const projectDir = await makeTempDir("agenr-init-project-test-");
    await setupExistingConfig(projectDir);
    mockWizardRuntime(projectDir);

    queueResponses(current.confirmMock, [true], "confirm");
    queueResponses(current.selectMock, ["keep", "no", "keep", "keep"], "select");
    queueResponses(current.textMock, [], "text");

    await initModule.runInitWizard({
      isInteractive: true,
      path: projectDir,
    });

    expect(initModule.initWizardRuntime.runSetupCore).not.toHaveBeenCalled();
    const messages = current.selectMock.mock.calls.map((call) => {
      const args = call[0] as { message?: string };
      return args.message ?? "";
    });
    expect(messages).not.toContain("Select default model:");
  });

  it("runs full setup for change-auth", async () => {
    const current = getMocks();
    const projectDir = await makeTempDir("agenr-init-project-test-");
    await setupExistingConfig(projectDir);
    mockWizardRuntime(projectDir);

    queueResponses(current.confirmMock, [true], "confirm");
    queueResponses(current.selectMock, ["change-auth", "keep", "keep"], "select");
    queueResponses(current.textMock, [], "text");

    await initModule.runInitWizard({
      isInteractive: true,
      path: projectDir,
    });

    expect(initModule.initWizardRuntime.runSetupCore).toHaveBeenCalledTimes(1);
  });

  it("prompts per-task models after selecting change-model", async () => {
    const current = getMocks();
    const projectDir = await makeTempDir("agenr-init-project-test-");
    await setupExistingConfig(projectDir);
    mockWizardRuntime(projectDir);

    queueResponses(current.confirmMock, [true], "confirm");
    queueResponses(current.selectMock, ["change-model", "gpt-4.1", "no", "keep", "keep", "keep"], "select");
    queueResponses(current.textMock, [], "text");

    await initModule.runInitWizard({
      isInteractive: true,
      path: projectDir,
    });

    const messages = current.selectMock.mock.calls.map((call) => {
      const args = call[0] as { message?: string };
      return args.message ?? "";
    });
    const modelSelectIndex = messages.indexOf("Select default model:");
    const taskPromptIndex = messages.indexOf("Configure per-task models? (Advanced)");
    expect(modelSelectIndex).toBeGreaterThan(-1);
    expect(taskPromptIndex).toBeGreaterThan(modelSelectIndex);
  });
});

describe("init wizard per-task model setup", () => {
  it("keeps existing task models when user skips advanced per-task setup", async () => {
    const current = getMocks();
    const projectDir = await makeTempDir("agenr-init-project-test-");
    const env = await setupExistingConfig(projectDir);
    mockWizardRuntime(projectDir);

    queueResponses(current.confirmMock, [true], "confirm");
    queueResponses(current.selectMock, ["keep", "no", "keep", "keep"], "select");
    queueResponses(current.textMock, [], "text");

    await initModule.runInitWizard({
      isInteractive: true,
      path: projectDir,
    });

    expect(readConfig(env)?.models).toEqual({
      extraction: "gpt-4.1-mini",
      claimExtraction: "gpt-4.1-nano",
      contradictionJudge: "gpt-4.1-nano",
      handoffSummary: "gpt-4.1-nano",
    });

    const taskPromptCall = current.selectMock.mock.calls.find((call) => {
      const args = call[0] as { message?: string; options?: Array<{ label: string }> };
      return args.message === "Configure per-task models? (Advanced)";
    });
    expect(taskPromptCall).toBeDefined();
    const taskPromptOptions = (taskPromptCall?.[0] as { options: Array<{ label: string }> }).options;
    expect(taskPromptOptions[0]?.label).toBe("No, keep current task models");
  });

  it("writes configured per-task overrides to config.models", async () => {
    const current = getMocks();
    const projectDir = await makeTempDir("agenr-init-project-test-");
    const env = await setupExistingConfig(projectDir);
    mockWizardRuntime(projectDir);

    queueResponses(current.confirmMock, [true], "confirm");
    queueResponses(
      current.selectMock,
      ["keep", "yes", "keep", "change", "change", "keep", "keep", "keep"],
      "select",
    );
    queueResponses(current.textMock, ["gpt-4.1", "o3-mini"], "text");

    await initModule.runInitWizard({
      isInteractive: true,
      path: projectDir,
    });

    expect(readConfig(env)?.models).toEqual({
      extraction: "gpt-4.1-mini",
      claimExtraction: "gpt-4.1",
      contradictionJudge: "o3-mini",
      handoffSummary: "gpt-4.1-nano",
    });

    const summaryCall = current.noteMock.mock.calls.find((call) => call[1] === "Setup summary");
    expect(summaryCall).toBeDefined();
    expect(summaryCall?.[0]).toContain("Per-task models:");
    expect(summaryCall?.[0]).toContain("Claim extraction: gpt-4.1");
    expect(summaryCall?.[0]).toContain("Contradiction judge: o3-mini");
  });

  it("shows existing per-task models in reconfigure mode", async () => {
    const current = getMocks();
    const projectDir = await makeTempDir("agenr-init-project-test-");
    await setupExistingConfig(projectDir, {
      models: {
        extraction: "gpt-4.1-mini",
        claimExtraction: "model-claims",
        contradictionJudge: "gpt-4.1-nano",
        handoffSummary: "model-handoff",
      },
    });
    mockWizardRuntime(projectDir);

    queueResponses(current.confirmMock, [true], "confirm");
    queueResponses(
      current.selectMock,
      ["keep", "yes", "keep", "keep", "keep", "keep", "keep", "keep"],
      "select",
    );
    queueResponses(current.textMock, [], "text");

    await initModule.runInitWizard({
      isInteractive: true,
      path: projectDir,
    });

    const messages = current.selectMock.mock.calls.map((call) => {
      const args = call[0] as { message?: string };
      return args.message ?? "";
    });
    expect(messages).toContain("Claim extraction: model-claims - Keep / Change");
    expect(messages).toContain("Handoff summary: model-handoff - Keep / Change");
  });

  it("keeps existing per-task models when skipping customization", async () => {
    const current = getMocks();
    const projectDir = await makeTempDir("agenr-init-project-test-");
    const env = await setupExistingConfig(projectDir, {
      models: {
        extraction: "gpt-4.1-mini",
        claimExtraction: "model-claims",
        contradictionJudge: "gpt-4.1-nano",
        handoffSummary: "gpt-4.1-nano",
      },
    });
    mockWizardRuntime(projectDir);

    queueResponses(current.confirmMock, [true], "confirm");
    queueResponses(current.selectMock, ["keep", "no", "keep", "keep"], "select");
    queueResponses(current.textMock, [], "text");

    await initModule.runInitWizard({
      isInteractive: true,
      path: projectDir,
    });

    expect(readConfig(env)?.models).toEqual({
      extraction: "gpt-4.1-mini",
      claimExtraction: "model-claims",
      contradictionJudge: "gpt-4.1-nano",
      handoffSummary: "gpt-4.1-nano",
    });
  });

  it("persists explicit task selections even when they match defaults", async () => {
    const current = getMocks();
    const projectDir = await makeTempDir("agenr-init-project-test-");
    const env = await setupExistingConfig(projectDir);
    mockWizardRuntime(projectDir);

    queueResponses(current.confirmMock, [true], "confirm");
    queueResponses(
      current.selectMock,
      ["keep", "yes", "change", "change", "keep", "keep", "keep", "keep"],
      "select",
    );
    queueResponses(current.textMock, ["gpt-4.1-mini", "gpt-4.1"], "text");

    await initModule.runInitWizard({
      isInteractive: true,
      path: projectDir,
    });

    expect(readConfig(env)?.models).toEqual({
      extraction: "gpt-4.1-mini",
      claimExtraction: "gpt-4.1",
      contradictionJudge: "gpt-4.1-nano",
      handoffSummary: "gpt-4.1-nano",
    });
  });
});
