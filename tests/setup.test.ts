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
  const textMock = vi.fn();
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
  const runEmbeddingConnectionTestMock = vi.fn();

  return {
    cancelToken,
    introMock,
    noteMock,
    confirmMock,
    selectMock,
    textMock,
    passwordMock,
    cancelMock,
    outroMock,
    spinnerStartMock,
    spinnerStopMock,
    spinnerMock,
    logMock,
    probeCredentialsMock,
    runConnectionTestMock,
    runEmbeddingConnectionTestMock,
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
  text: getMocks().textMock,
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
  runEmbeddingConnectionTest: getMocks().runEmbeddingConnectionTestMock,
}));

import * as setupModule from "../src/setup.js";

const tempDirs: string[] = [];

async function makeTempConfigEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-setup-test-"));
  tempDirs.push(dir);
  return {
    ...process.env,
    AGENR_CONFIG_PATH: path.join(dir, "config.json"),
    OPENAI_API_KEY: "",
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
  const current = getMocks();
  current.runConnectionTestMock.mockResolvedValue({ ok: true });
  current.runEmbeddingConnectionTestMock.mockResolvedValue({ ok: true });
});

describe("formatExistingConfig", () => {
  it("shows projects when they exist", () => {
    const sharedDbPath = path.join(os.homedir(), ".agenr", "knowledge.db");
    const formatted = setupModule.formatExistingConfig(
      {
        auth: "openai-api-key",
        provider: "openai",
        model: "openai/gpt-4.1",
        projects: {
          [path.join(os.homedir(), ".openclaw")]: {
            project: "openclaw",
            platform: "openclaw",
          },
          [path.join(os.homedir(), ".openclaw-sandbox")]: {
            project: "openclaw",
            platform: "openclaw",
            dbPath: path.join(os.homedir(), ".openclaw-sandbox", "agenr-data", "knowledge.db"),
          },
        },
      },
      sharedDbPath,
    );

    expect(formatted).toContain("Projects:");
    expect(formatted).toContain("  openclaw");
    expect(formatted).toContain("    Directory: ~/.openclaw");
    expect(formatted).toContain("    Directory: ~/.openclaw-sandbox");
  });

  it("omits projects section when none exist", () => {
    const formatted = setupModule.formatExistingConfig({
      auth: "openai-api-key",
      provider: "openai",
      model: "openai/gpt-4.1",
    });

    expect(formatted).not.toContain("Projects:");
  });

  it("shows isolated and shared labels", () => {
    const sharedDbPath = path.join(os.homedir(), ".agenr", "knowledge.db");
    const formatted = setupModule.formatExistingConfig(
      {
        auth: "openai-api-key",
        provider: "openai",
        model: "openai/gpt-4.1",
        projects: {
          "/tmp/openclaw-main": {
            project: "openclaw",
            platform: "openclaw",
          },
          "/tmp/openclaw-sandbox": {
            project: "openclaw",
            platform: "openclaw",
            dbPath: "/tmp/openclaw-sandbox/agenr-data/knowledge.db",
          },
        },
      },
      sharedDbPath,
    );

    expect(formatted).toContain("~/.agenr/knowledge.db (shared)");
    expect(formatted).toContain("/tmp/openclaw-sandbox/agenr-data/knowledge.db (isolated)");
  });

  it("shows tilde paths for home directory", () => {
    const sharedDbPath = path.join(os.homedir(), ".agenr", "knowledge.db");
    const formatted = setupModule.formatExistingConfig(
      {
        auth: "openai-api-key",
        provider: "openai",
        model: "openai/gpt-4.1",
        projects: {
          [path.join(os.homedir(), ".openclaw")]: {
            project: "openclaw",
            platform: "openclaw",
          },
          [path.join(os.homedir(), ".openclaw-sandbox")]: {
            project: "openclaw",
            platform: "openclaw",
            dbPath: path.join(os.homedir(), ".openclaw-sandbox", "agenr-data", "knowledge.db"),
          },
        },
      },
      sharedDbPath,
    );

    expect(formatted).toContain("Directory: ~/.openclaw-sandbox");
    expect(formatted).toContain("Database:  ~/.openclaw-sandbox/agenr-data/knowledge.db (isolated)");
    expect(formatted).toContain("~/.agenr/knowledge.db");
  });
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
    mocks.passwordMock.mockResolvedValueOnce("sk-openai-test-embeddings");

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
    mocks.passwordMock.mockResolvedValueOnce("sk-openai-test-embeddings");

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

  it("tests embedding key after entry", async () => {
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
    mocks.passwordMock.mockResolvedValueOnce("sk-openai-test-embeddings");

    await setupModule.runSetupCore({
      env,
      existingConfig: null,
      skipIntroOutro: true,
    });

    expect(mocks.runEmbeddingConnectionTestMock).toHaveBeenCalledWith("sk-openai-test-embeddings");
    expect(mocks.spinnerStartMock).toHaveBeenCalledWith("Testing embeddings connection...");
  });

  it("retries embedding test on failure", async () => {
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
    mocks.passwordMock.mockResolvedValueOnce("sk-openai-test-embeddings");
    mocks.runEmbeddingConnectionTestMock
      .mockResolvedValueOnce({ ok: false, error: "invalid key" })
      .mockResolvedValueOnce({ ok: true });
    mocks.confirmMock.mockResolvedValueOnce(true);

    await setupModule.runSetupCore({
      env,
      existingConfig: null,
      skipIntroOutro: true,
    });

    expect(mocks.runEmbeddingConnectionTestMock).toHaveBeenCalledTimes(2);
    expect(mocks.confirmMock).toHaveBeenCalledWith({
      message: "Retry embeddings test?",
      initialValue: true,
    });
  });

  it("allows skipping embedding test", async () => {
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
    mocks.passwordMock.mockResolvedValueOnce("sk-openai-test-embeddings");
    mocks.runEmbeddingConnectionTestMock.mockResolvedValueOnce({ ok: false, error: "invalid key" });
    mocks.confirmMock.mockResolvedValueOnce(false);

    await setupModule.runSetupCore({
      env,
      existingConfig: null,
      skipIntroOutro: true,
    });

    expect(mocks.logMock.info).toHaveBeenCalledWith(
      expect.stringContaining("Skipping embeddings test. You can verify later with "),
    );
  });

  it("tests embedding key on update path", async () => {
    const mocks = getMocks();
    const env = await makeTempConfigEnv();

    mocks.selectMock.mockResolvedValueOnce("anthropic-api-key").mockResolvedValueOnce("claude-sonnet-4-20250514");
    mocks.probeCredentialsMock.mockReturnValue({
      available: true,
      source: "config:credentials.anthropicApiKey",
      guidance: "Credentials available.",
      credentials: {
        apiKey: "sk-ant-existing",
        source: "config:credentials.anthropicApiKey",
      },
    });
    mocks.confirmMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mocks.passwordMock.mockResolvedValueOnce("sk-openai-new");

    await setupModule.runSetupCore({
      env,
      existingConfig: {
        auth: "anthropic-api-key",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        credentials: {
          anthropicApiKey: "sk-ant-existing",
          openaiApiKey: "sk-openai-old",
        },
      },
      skipIntroOutro: true,
    });

    expect(mocks.runEmbeddingConnectionTestMock).toHaveBeenCalledWith("sk-openai-new");
  });

  it("update-embeddings does not persist key when embedding test is cancelled", async () => {
    const mocks = getMocks();
    const env = await makeTempConfigEnv();

    mocks.selectMock.mockResolvedValueOnce("update-embeddings");
    mocks.passwordMock.mockResolvedValueOnce("sk-openai-new");
    mocks.runEmbeddingConnectionTestMock.mockResolvedValueOnce({ ok: false, error: "invalid key" });
    mocks.confirmMock.mockResolvedValueOnce(mocks.cancelToken);

    const result = await setupModule.runSetupCore({
      env,
      existingConfig: {
        auth: "anthropic-api-key",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        credentials: {
          anthropicApiKey: "sk-ant-existing",
          openaiApiKey: "sk-openai-old",
        },
      },
      skipIntroOutro: true,
    });

    expect(result).toBeNull();
    expect(mocks.runEmbeddingConnectionTestMock).toHaveBeenCalledWith("sk-openai-new");
    expect(mocks.logMock.info).not.toHaveBeenCalledWith("Embedding API key updated.");
    expect(readConfig(env)).toBeNull();
  });

  it("stores only non-default per-task models when advanced config is enabled", async () => {
    const mocks = getMocks();
    const env = await makeTempConfigEnv();

    mocks.selectMock
      .mockResolvedValueOnce("openai-api-key")
      .mockResolvedValueOnce("gpt-4.1-mini")
      .mockResolvedValueOnce("configure")
      .mockResolvedValueOnce("__use_default__")
      .mockResolvedValueOnce("gpt-4.1-mini")
      .mockResolvedValueOnce("__use_default__")
      .mockResolvedValueOnce("__use_default__");
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

    expect(result?.config.models).toEqual({
      claimExtraction: "gpt-4.1-mini",
    });
    expect(readConfig(env)?.models).toEqual({
      claimExtraction: "gpt-4.1-mini",
    });
  });

  it("stores explicitly selected task model even when it matches the default", async () => {
    const mocks = getMocks();
    const env = await makeTempConfigEnv();

    mocks.selectMock
      .mockResolvedValueOnce("openai-api-key")
      .mockResolvedValueOnce("gpt-4.1-mini")
      .mockResolvedValueOnce("configure")
      .mockResolvedValueOnce("__use_default__")
      .mockResolvedValueOnce("__use_default__")
      .mockResolvedValueOnce("gpt-4.1-nano")
      .mockResolvedValueOnce("__use_default__");
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

    expect(result?.config.models).toEqual({
      contradictionJudge: "gpt-4.1-nano",
    });
    expect(readConfig(env)?.models).toEqual({
      contradictionJudge: "gpt-4.1-nano",
    });
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
