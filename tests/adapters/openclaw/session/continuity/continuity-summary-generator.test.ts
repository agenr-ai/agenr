import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { generateAndWriteOpenClawContinuitySummary } from "../../../../../src/adapters/openclaw/session/continuity/continuity-summary-generator.js";
import type { AgenrOpenClawHost } from "../../../../../src/adapters/openclaw/types.js";

const tempPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();

  while (tempPaths.length > 0) {
    await rm(tempPaths.pop() ?? "", { force: true, recursive: true });
  }
});

describe("generateAndWriteOpenClawContinuitySummary", () => {
  it("uses the OpenClaw-configured model and cleans temp session state", async () => {
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
          content: "Agreed. The plugin should call the embedded runner and keep embeddings separate.",
        },
      },
    ]);
    let tempContinuitySummarySessionFile: string | undefined;
    const runEmbeddedPiAgentSpy = vi.fn(async (params: Parameters<AgenrOpenClawHost["runtime"]["agent"]["runEmbeddedPiAgent"]>[0]) => {
      tempContinuitySummarySessionFile = params.sessionFile;
      await expect(access(path.dirname(params.sessionFile))).resolves.toBeUndefined();

      return {
        payloads: [
          {
            text: "# Continuity\nOpenClaw now owns continuity summary model resolution and auth, while embeddings still come from agenr config.",
          },
        ],
        meta: {
          durationMs: 1,
        },
      };
    });
    const openClaw = createOpenClawHost({
      model: "openai/gpt-5.4",
      runEmbeddedPiAgentImplementation: runEmbeddedPiAgentSpy as AgenrOpenClawHost["runtime"]["agent"]["runEmbeddedPiAgent"],
    });
    const logger = createLogger();

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
    expect(runEmbeddedPiAgentSpy).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentSpy.mock.calls[0]?.[0]).toMatchObject({
      agentId: "main",
      config: openClaw.config,
      model: "gpt-5.4",
      provider: "openai",
      sessionKey: "temp:agenr-continuity-summary",
      timeoutMs: 30_000,
    });
    expect(runEmbeddedPiAgentSpy.mock.calls[0]?.[0]?.extraSystemPrompt).toContain(
      "You write concise narrative continuity summaries that help the next session continue smoothly.",
    );
    expect(runEmbeddedPiAgentSpy.mock.calls[0]?.[0]?.prompt).toContain("Transcript:");

    const continuitySummaryPath = path.join(path.dirname(sessionFile), "continuity-summary-session.continuity-summary.md");
    await expect(readFile(continuitySummaryPath, "utf8")).resolves.toBe(
      "OpenClaw now owns continuity summary model resolution and auth, while embeddings still come from agenr config.\n",
    );
    expect(tempContinuitySummarySessionFile).toBeDefined();
    await expect(access(path.dirname(tempContinuitySummarySessionFile ?? ""))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(getMessages(logger.info)).toContain("[agenr] continuity-summary: using OpenClaw embedded agent provider=openai model=gpt-5.4 agent=main");
  });

  it("warns and skips when the embedded runner is unavailable", async () => {
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
    const openClaw = createUnavailableOpenClawHost();
    const logger = createLogger();

    const result = await generateAndWriteOpenClawContinuitySummary({
      sessionFile,
      agentId: "main",
      openClaw,
      logger,
    });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "embedded_agent_unavailable",
      model: "openai/gpt-5.4-mini",
    });
    expect(getMessages(logger.warn)).toContain(`[agenr] continuity-summary: OpenClaw embedded agent runner unavailable for file=${sessionFile}`);
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
    const runEmbeddedPiAgentSpy = vi.fn(async () => {
      return {
        payloads: [
          {
            text: "Continuity generation used the configured override.",
          },
        ],
      };
    });
    const openClaw = createOpenClawHost({
      model: "anthropic/claude-opus-4-6",
      runEmbeddedPiAgentImplementation: runEmbeddedPiAgentSpy as AgenrOpenClawHost["runtime"]["agent"]["runEmbeddedPiAgent"],
    });
    const logger = createLogger();

    const result = await generateAndWriteOpenClawContinuitySummary({
      sessionFile,
      agentId: "main",
      openClaw,
      logger,
      pluginConfig: {
        continuityModel: "openai/gpt-5.4-mini",
      },
    });

    expect(result).toMatchObject({
      status: "written",
      model: "openai/gpt-5.4-mini",
    });
    expect(runEmbeddedPiAgentSpy.mock.calls[0]?.[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-mini",
      timeoutMs: 30_000,
    });
  });
});

async function writeSessionFile(sessionId: string, entries: object[]): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenr-openclaw-continuity-summary-"));
  tempPaths.push(root);
  const sessionFile = path.join(root, `${sessionId}.jsonl`);
  await writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return sessionFile;
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
      state: {
        resolveStateDir: () => path.join(os.tmpdir(), ".openclaw"),
      },
    },
  };
}

function createUnavailableOpenClawHost(): AgenrOpenClawHost {
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
          model: "openai/gpt-5.4-mini",
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
        runEmbeddedPiAgent: undefined,
      },
      state: {
        resolveStateDir: () => path.join(os.tmpdir(), ".openclaw"),
      },
    },
  } as unknown as AgenrOpenClawHost;
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
