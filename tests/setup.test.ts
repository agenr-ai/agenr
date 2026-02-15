import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfig, writeConfig } from "../src/config.js";
import type { AgenrConfig } from "../src/types.js";

const mocks = vi.hoisted(() => {
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
});

vi.mock("@clack/prompts", () => ({
  intro: mocks.introMock,
  note: mocks.noteMock,
  confirm: mocks.confirmMock,
  select: mocks.selectMock,
  password: mocks.passwordMock,
  cancel: mocks.cancelMock,
  outro: mocks.outroMock,
  spinner: mocks.spinnerMock,
  log: mocks.logMock,
  isCancel: (value: unknown) => value === mocks.cancelToken,
}));

vi.mock("../src/llm/credentials.js", () => ({
  probeCredentials: mocks.probeCredentialsMock,
}));

vi.mock("../src/auth-status.js", () => ({
  runConnectionTest: mocks.runConnectionTestMock,
}));

import { runSetup } from "../src/setup.js";

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

describe("runSetup", () => {
  it("keeps existing config when user declines reconfigure", async () => {
    const env = await makeTempConfigEnv();
    const existing: AgenrConfig = {
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-4o",
      credentials: { openaiApiKey: "sk-existing" },
    };
    writeConfig(existing, env);

    mocks.confirmMock.mockResolvedValueOnce(false);

    await runSetup(env);

    expect(mocks.cancelMock).toHaveBeenCalledWith("Setup unchanged.");
    expect(mocks.selectMock).not.toHaveBeenCalled();
    expect(readConfig(env)).toEqual(existing);
  });

  it("cancels gracefully when auth selection is cancelled", async () => {
    const env = await makeTempConfigEnv();

    mocks.selectMock.mockResolvedValueOnce(mocks.cancelToken);

    await runSetup(env);

    expect(mocks.cancelMock).toHaveBeenCalledWith("Setup cancelled.");
    expect(readConfig(env)).toBeNull();
  });

  it("cancels gracefully when model selection is cancelled", async () => {
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

    await runSetup(env);

    expect(mocks.cancelMock).toHaveBeenCalledWith("Setup cancelled.");
    expect(mocks.runConnectionTestMock).not.toHaveBeenCalled();
    expect(readConfig(env)).toBeNull();
  });

  it("stores entered credential, tests connection, and saves config", async () => {
    const env = await makeTempConfigEnv();

    mocks.selectMock.mockResolvedValueOnce("openai-api-key").mockResolvedValueOnce("gpt-4o");
    mocks.confirmMock.mockResolvedValueOnce(true);
    mocks.passwordMock.mockResolvedValueOnce("sk-entered");
    mocks.probeCredentialsMock
      .mockReturnValueOnce({
        available: false,
        guidance: "No OpenAI API key found.",
      })
      .mockReturnValueOnce({
        available: true,
        source: "config:credentials.openaiApiKey",
        guidance: "Credentials available.",
        credentials: {
          apiKey: "sk-entered",
          source: "config:credentials.openaiApiKey",
        },
      });
    mocks.runConnectionTestMock.mockResolvedValueOnce({ ok: true });

    await runSetup(env);

    const saved = readConfig(env);
    expect(saved).toMatchObject({
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-4o",
      credentials: {
        openaiApiKey: "sk-entered",
      },
    });
    expect(mocks.spinnerStartMock).toHaveBeenCalledWith("Testing connection...");
    expect(mocks.spinnerStopMock).toHaveBeenCalledWith(expect.stringContaining("Connected"));
  });

  it("handles failed connection test and no-retry path", async () => {
    const env = await makeTempConfigEnv();

    mocks.selectMock.mockResolvedValueOnce("openai-api-key").mockResolvedValueOnce("gpt-4o");
    mocks.probeCredentialsMock.mockReturnValue({
      available: true,
      source: "env:OPENAI_API_KEY",
      guidance: "Credentials available.",
      credentials: {
        apiKey: "sk-test",
        source: "env:OPENAI_API_KEY",
      },
    });
    mocks.runConnectionTestMock.mockResolvedValueOnce({ ok: false, error: "bad key" });
    mocks.confirmMock.mockResolvedValueOnce(false);

    await runSetup(env);

    expect(mocks.spinnerStopMock).toHaveBeenCalledWith(expect.stringContaining("Connection failed: bad key"));
    expect(mocks.logMock.info).toHaveBeenCalledWith(expect.stringContaining("Skipping connection test."));
    expect(readConfig(env)).toMatchObject({
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-4o",
    });
  });

  it("skips connection test when credentials remain unavailable", async () => {
    const env = await makeTempConfigEnv();

    mocks.selectMock.mockResolvedValueOnce("anthropic-oauth").mockResolvedValueOnce("claude-opus-4-6");
    mocks.probeCredentialsMock.mockReturnValue({
      available: false,
      guidance: "Claude CLI credentials not found.",
    });

    await runSetup(env);

    expect(mocks.runConnectionTestMock).not.toHaveBeenCalled();
    expect(mocks.logMock.warn).toHaveBeenCalledWith("Claude CLI credentials not found.");
    expect(mocks.logMock.info).toHaveBeenCalledWith("Credentials not available yet. Skipping connection test.");
    expect(readConfig(env)).toMatchObject({
      auth: "anthropic-oauth",
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
  });
});
