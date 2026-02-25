import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfig } from "../src/config.js";

function createMocks() {
  const cancelToken = Symbol("cancel");
  const introMock = vi.fn();
  const noteMock = vi.fn();
  const confirmMock = vi.fn();
  const selectMock = vi.fn();
  const passwordMock = vi.fn();
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
  const probeCredentialsMock = vi.fn();
  const runConnectionTestMock = vi.fn();

  return {
    cancelToken,
    introMock,
    noteMock,
    confirmMock,
    selectMock,
    passwordMock,
    cancelMock,
    outroMock,
    spinnerStartMock,
    spinnerStopMock,
    spinnerMock,
    logMock,
    probeCredentialsMock,
    runConnectionTestMock,
  };
}

type SetupMocks = ReturnType<typeof createMocks>;
var mocks: SetupMocks | undefined;

function getMocks(): SetupMocks {
  if (!mocks) {
    mocks = createMocks();
  }
  return mocks;
}

vi.mock("@clack/prompts", () => ({
  intro: getMocks().introMock,
  note: getMocks().noteMock,
  confirm: getMocks().confirmMock,
  select: getMocks().selectMock,
  password: getMocks().passwordMock,
  cancel: getMocks().cancelMock,
  outro: getMocks().outroMock,
  spinner: getMocks().spinnerMock,
  log: getMocks().logMock,
  isCancel: (value: unknown) => value === getMocks().cancelToken,
}));

vi.mock("../src/llm/credentials.js", () => ({
  probeCredentials: getMocks().probeCredentialsMock,
}));

vi.mock("../src/auth-status.js", () => ({
  runConnectionTest: getMocks().runConnectionTestMock,
}));

import * as setupModule from "../src/setup.js";

const tempDirs: string[] = [];

async function makeTempConfigEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-setup-test-"));
  tempDirs.push(dir);
  return {
    ...process.env,
    AGENR_CONFIG_PATH: path.join(dir, "config.json"),
  };
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runSetupCore", () => {
  it("returns SetupResult with auth, provider, model on success", async () => {
    const mocks = getMocks();
    const env = await makeTempConfigEnv();

    mocks.selectMock.mockResolvedValueOnce("openai-api-key").mockResolvedValueOnce("gpt-4.1-mini");
    mocks.probeCredentialsMock.mockReturnValue({
      available: true,
      source: "env:OPENAI_API_KEY",
      guidance: "Credentials available.",
      credentials: {
        apiKey: "sk-test",
        source: "env:OPENAI_API_KEY",
      },
    });
    mocks.runConnectionTestMock.mockResolvedValueOnce({ ok: true });

    const result = await setupModule.runSetupCore({
      env,
      existingConfig: null,
      skipIntroOutro: true,
    });

    expect(result).toMatchObject({
      auth: "openai-api-key",
      provider: "openai",
      model: "openai/gpt-4.1-mini",
      changed: true,
    });
    expect(readConfig(env)).toMatchObject({
      auth: "openai-api-key",
      provider: "openai",
      model: "openai/gpt-4.1-mini",
    });
  });

  it("returns null when user cancels at auth step", async () => {
    const mocks = getMocks();
    const env = await makeTempConfigEnv();

    mocks.selectMock.mockResolvedValueOnce(mocks.cancelToken);

    const result = await setupModule.runSetupCore({
      env,
      existingConfig: null,
      skipIntroOutro: true,
    });

    expect(result).toBeNull();
    expect(readConfig(env)).toBeNull();
  });

  it("returns null when user cancels at model step", async () => {
    const mocks = getMocks();
    const env = await makeTempConfigEnv();

    mocks.selectMock.mockResolvedValueOnce("openai-api-key").mockResolvedValueOnce(mocks.cancelToken);
    mocks.probeCredentialsMock.mockReturnValue({
      available: true,
      source: "env:OPENAI_API_KEY",
      guidance: "Credentials available.",
      credentials: {
        apiKey: "sk-test",
        source: "env:OPENAI_API_KEY",
      },
    });

    const result = await setupModule.runSetupCore({
      env,
      existingConfig: null,
      skipIntroOutro: true,
    });

    expect(result).toBeNull();
    expect(readConfig(env)).toBeNull();
  });

  it("shows API key link for OpenAI", async () => {
    const mocks = getMocks();
    const env = await makeTempConfigEnv();

    mocks.selectMock.mockResolvedValueOnce("openai-api-key").mockResolvedValueOnce("gpt-4.1-mini");
    mocks.probeCredentialsMock.mockReturnValue({
      available: true,
      source: "env:OPENAI_API_KEY",
      guidance: "Credentials available.",
      credentials: {
        apiKey: "sk-test",
        source: "env:OPENAI_API_KEY",
      },
    });
    mocks.runConnectionTestMock.mockResolvedValueOnce({ ok: true });

    await setupModule.runSetupCore({
      env,
      existingConfig: null,
      skipIntroOutro: true,
    });

    expect(mocks.logMock.info).toHaveBeenCalledWith("Get your API key at https://platform.openai.com/api-keys");
  });

  it("shows API key link for Anthropic", async () => {
    const mocks = getMocks();
    const env = await makeTempConfigEnv();

    mocks.selectMock.mockResolvedValueOnce("anthropic-api-key").mockResolvedValueOnce("claude-sonnet-4-20250514");
    mocks.probeCredentialsMock.mockReturnValue({
      available: true,
      source: "env:ANTHROPIC_API_KEY",
      guidance: "Credentials available.",
      credentials: {
        apiKey: "sk-ant-test",
        source: "env:ANTHROPIC_API_KEY",
      },
    });
    mocks.runConnectionTestMock.mockResolvedValueOnce({ ok: true });

    await setupModule.runSetupCore({
      env,
      existingConfig: null,
      skipIntroOutro: true,
    });

    expect(mocks.logMock.info).toHaveBeenCalledWith("Get your API key at https://console.anthropic.com/settings/keys");
  });

  it("shows subscription note for advanced auth methods", async () => {
    const mocks = getMocks();
    const env = await makeTempConfigEnv();

    mocks.selectMock
      .mockResolvedValueOnce("advanced-options")
      .mockResolvedValueOnce("openai-subscription")
      .mockResolvedValueOnce("gpt-5.3-codex");
    mocks.probeCredentialsMock.mockReturnValue({
      available: false,
      guidance: "Codex CLI credentials not found.",
    });

    await setupModule.runSetupCore({
      env,
      existingConfig: null,
      skipIntroOutro: true,
    });

    expect(mocks.logMock.info).toHaveBeenCalledWith(
      "Note: Subscription models may have limited extraction quality. API keys with gpt-4.1-mini are recommended for best results.",
    );
    expect(mocks.logMock.info).toHaveBeenCalledWith("This uses your existing subscription - no API key needed.");
  });
});

describe("runSetup", () => {
  it("still works as standalone command", async () => {
    const env = await makeTempConfigEnv();
    const runSetupCoreSpy = vi.spyOn(setupModule.setupRuntime, "runSetupCore").mockResolvedValue({
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-4.1-mini",
      config: {
        auth: "openai-api-key",
        provider: "openai",
        model: "gpt-4.1-mini",
      },
      changed: true,
    });

    await setupModule.runSetup(env);

    expect(runSetupCoreSpy).toHaveBeenCalledWith({
      env,
      existingConfig: null,
      skipIntroOutro: true,
    });
    expect(getMocks().introMock).toHaveBeenCalled();
    expect(getMocks().outroMock).toHaveBeenCalledWith(expect.stringContaining("agenr extract"));
  });
});
