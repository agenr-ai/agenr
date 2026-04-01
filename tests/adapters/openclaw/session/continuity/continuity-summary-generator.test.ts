import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const openClawLlmClientMocks = vi.hoisted(() => ({
  createOpenClawLlmClient: vi.fn(),
}));

vi.mock("../../../../../src/adapters/openclaw/llm/openclaw-llm-client.js", () => ({
  createOpenClawLlmClient: openClawLlmClientMocks.createOpenClawLlmClient,
}));

import type { LlmPort } from "../../../../../src/core/ports.js";
import { generateAndWriteOpenClawContinuitySummary } from "../../../../../src/adapters/openclaw/session/continuity/continuity-summary-generator.js";
import type { AgenrOpenClawHost } from "../../../../../src/adapters/openclaw/types.js";

const tempPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  openClawLlmClientMocks.createOpenClawLlmClient.mockReset();

  while (tempPaths.length > 0) {
    await rm(tempPaths.pop() ?? "", { force: true, recursive: true });
  }
});

describe("generateAndWriteOpenClawContinuitySummary", () => {
  it("uses the lightweight OpenClaw LLM client without embedded-agent temp state", async () => {
    const sessionFile = await writeSessionFile("continuity-summary-session", [
      {
        type: "session",
        id: "continuity-summary-session",
      },
      {
        type: "message",
        message: {
          role: "human",
          content: "We should keep continuity summaries next to the transcript file.",
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: "That lets the next session recover context without writing handoff entries into the brain.",
        },
      },
      {
        type: "message",
        message: {
          role: "human",
          content: "Use OpenClaw's configured model and auth instead of agenr's own continuity summary client.",
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: "Agreed. The plugin should call the lightweight client and keep embeddings separate.",
        },
      },
    ]);
    const runEmbeddedPiAgentSpy = vi.fn();
    const logger = createLogger();
    const openClaw = createOpenClawHost({
      model: "openai/gpt-5.4",
      runEmbeddedPiAgentImplementation: runEmbeddedPiAgentSpy as AgenrOpenClawHost["runtime"]["agent"]["runEmbeddedPiAgent"],
    });
    const llmComplete = vi.fn(async () => {
      return "# Continuity\nOpenClaw now owns continuity summary model resolution and auth, while embeddings still come from agenr config.";
    });
    openClawLlmClientMocks.createOpenClawLlmClient.mockResolvedValue(createLlmPort(llmComplete));
    const tempEntriesBefore = await listTempDirEntries("agenr-continuity-summary-");

    const result = await generateAndWriteOpenClawContinuitySummary({
      sessionFile,
      agentId: "main",
      openClaw,
      logger,
    });

    expect(result).toMatchObject({
      status: "written",
      model: "openai/gpt-5.4",
    });
    expect(openClawLlmClientMocks.createOpenClawLlmClient).toHaveBeenCalledWith(openClaw, "openai/gpt-5.4", "continuity model override");
    expect(llmComplete).toHaveBeenCalledWith(
      expect.stringContaining("You write concise narrative continuity summaries that help the next session continue smoothly."),
      expect.stringContaining("Transcript:\nUser: We should keep continuity summaries next to the transcript file."),
    );
    expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
    await expect(listTempDirEntries("agenr-continuity-summary-")).resolves.toEqual(tempEntriesBefore);

    const continuitySummaryPath = path.join(path.dirname(sessionFile), "continuity-summary-session.continuity-summary.md");
    await expect(readFile(continuitySummaryPath, "utf8")).resolves.toBe(
      "OpenClaw now owns continuity summary model resolution and auth, while embeddings still come from agenr config.\n",
    );
    expect(getMessages(logger.info)).toContain("[agenr] continuity-summary: using OpenClaw LLM client model=openai/gpt-5.4");
  });

  it("returns a timeout failure when the lightweight LLM client does not finish in time", async () => {
    vi.useFakeTimers();

    const sessionFile = await writeSessionFile("continuity-summary-session", [
      {
        type: "session",
        id: "continuity-summary-session",
      },
      {
        type: "message",
        message: {
          role: "human",
          content: "Please summarize this session.",
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: "I will try.",
        },
      },
      {
        type: "message",
        message: {
          role: "human",
          content: "Keep the fallback path stable.",
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: "The recent transcript tail should still be available.",
        },
      },
    ]);
    const runEmbeddedPiAgentSpy = vi.fn();
    const logger = createLogger();
    const openClaw = createOpenClawHost({
      model: "openai/gpt-5.4-mini",
      runEmbeddedPiAgentImplementation: runEmbeddedPiAgentSpy as AgenrOpenClawHost["runtime"]["agent"]["runEmbeddedPiAgent"],
    });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    openClawLlmClientMocks.createOpenClawLlmClient.mockResolvedValue(
      createLlmPort(
        vi.fn(async () => {
          markStarted?.();
          return await new Promise<string>(() => {
            return;
          });
        }),
      ),
    );

    const resultPromise = generateAndWriteOpenClawContinuitySummary({
      sessionFile,
      agentId: "main",
      openClaw,
      logger,
    });

    await started;
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await resultPromise;

    expect(result).toMatchObject({
      status: "failed",
      reason: "timeout",
      model: "openai/gpt-5.4-mini",
    });
    expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
  });

  it("prefers the configured continuity model override over the agent primary model", async () => {
    const sessionFile = await writeSessionFile("continuity-summary-session", [
      {
        type: "session",
        id: "continuity-summary-session",
      },
      {
        type: "message",
        message: {
          role: "human",
          content: "Use a smaller model for continuity summaries.",
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: "That should keep continuity generation responsive.",
        },
      },
      {
        type: "message",
        message: {
          role: "human",
          content: "Keep the override local to continuity only.",
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: "The agent primary model can stay unchanged.",
        },
      },
    ]);
    const runEmbeddedPiAgentSpy = vi.fn();
    const logger = createLogger();
    const openClaw = createOpenClawHost({
      model: "anthropic/claude-opus-4-6",
      runEmbeddedPiAgentImplementation: runEmbeddedPiAgentSpy as AgenrOpenClawHost["runtime"]["agent"]["runEmbeddedPiAgent"],
    });
    openClawLlmClientMocks.createOpenClawLlmClient.mockResolvedValue(
      createLlmPort(
        vi.fn(async () => {
          return "Continuity generation used the configured override.";
        }),
      ),
    );

    const result = await generateAndWriteOpenClawContinuitySummary({
      sessionFile,
      agentId: "main",
      openClaw,
      logger,
      pluginConfig: {
        continuityModel: "anthropic/claude-haiku-4-5",
      },
    });

    expect(result).toMatchObject({
      status: "written",
      model: "anthropic/claude-haiku-4-5",
    });
    expect(openClawLlmClientMocks.createOpenClawLlmClient).toHaveBeenCalledWith(openClaw, "anthropic/claude-haiku-4-5", "continuity model override");
    expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
  });
});

async function writeSessionFile(sessionId: string, entries: object[]): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenr-openclaw-continuity-summary-"));
  tempPaths.push(root);
  const sessionFile = path.join(root, `${sessionId}.jsonl`);
  await writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return sessionFile;
}

function createLlmPort(complete: LlmPort["complete"]): LlmPort {
  return {
    complete,
    completeJson: async <T>(systemPrompt: string, userMessage: string): Promise<T> => {
      return JSON.parse(await complete(systemPrompt, userMessage)) as T;
    },
  };
}

async function listTempDirEntries(prefix: string): Promise<string[]> {
  return (await readdir(os.tmpdir())).filter((entry) => entry.startsWith(prefix)).sort();
}

function createOpenClawHost(options: {
  model: string;
  runEmbeddedPiAgentImplementation: AgenrOpenClawHost["runtime"]["agent"]["runEmbeddedPiAgent"];
}): AgenrOpenClawHost {
  const workspaceDir = path.join(os.tmpdir(), `agenr-openclaw-continuity-summary-workspace-${randomUUID()}`);
  const agentDir = path.join(os.tmpdir(), `agenr-openclaw-continuity-summary-agent-${randomUUID()}`);
  const config = {
    defaultAgent: "main",
    agents: {
      list: [
        {
          id: "main",
          workspace: workspaceDir,
          agentDir,
          model: options.model,
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
        runEmbeddedPiAgent: options.runEmbeddedPiAgentImplementation,
      },
      modelAuth: {
        resolveApiKeyForProvider: async () => ({
          apiKey: "openclaw-test-key",
          source: "profile:default",
          mode: "api-key",
        }),
      },
      state: {
        resolveStateDir: () => path.join(os.tmpdir(), ".openclaw"),
      },
    },
  };
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function getMessages(logFn: ReturnType<typeof vi.fn>): string[] {
  return logFn.mock.calls.map(([message]) => message as string);
}
