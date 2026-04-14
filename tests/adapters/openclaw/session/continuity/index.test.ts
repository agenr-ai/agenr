import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveStateDir as resolveOpenClawStateDir } from "openclaw/plugin-sdk/state-paths";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolvePredecessorContinuity } from "../../../../../src/adapters/openclaw/session/continuity/index.js";
import { createSessionStartTracker } from "../../../../../src/adapters/openclaw/session/state.js";
import type { AgenrOpenClawServices } from "../../../../../src/adapters/openclaw/types.js";

const tempPaths: string[] = [];
const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
const originalOpenClawHome = process.env.OPENCLAW_HOME;

afterEach(async () => {
  if (originalOpenClawStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
  }

  if (originalOpenClawHome === undefined) {
    delete process.env.OPENCLAW_HOME;
  } else {
    process.env.OPENCLAW_HOME = originalOpenClawHome;
  }

  vi.restoreAllMocks();

  while (tempPaths.length > 0) {
    await rm(tempPaths.pop() ?? "", { force: true, recursive: true });
  }
});

describe("resolvePredecessorContinuity", () => {
  it("returns predecessor identity alongside continuity and recent-session content", async () => {
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    const predecessorSessionId = "predecessor-session";
    const predecessorFile = path.join(sessionsDir, `${predecessorSessionId}.jsonl`);

    await writeFile(
      predecessorFile,
      [
        JSON.stringify({ type: "session", id: predecessorSessionId }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-03-29T09:00:00.000Z",
          message: {
            role: "human",
            content: "We kept continuity file-based.",
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-03-29T09:01:00.000Z",
          message: {
            role: "assistant",
            content: "And we still include the recent transcript tail.",
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    await writeFile(path.join(sessionsDir, `${predecessorSessionId}.continuity-summary.md`), "File-based continuity won the design decision.", "utf8");
    await writeSessionsJson(sessionsDir, {
      "agent:main:main": {
        sessionId: predecessorSessionId,
        sessionFile: `${predecessorSessionId}.jsonl`,
        updatedAt: 2_000,
      },
    });

    const result = await resolvePredecessorContinuity(
      {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:tui-923e4567-e89b-12d3-a456-426614174000",
        workspaceDir,
      },
      createSessionStartTracker(),
      createServices(),
      createLogger(),
    );

    expect(result.predecessor).toEqual({
      sessionId: predecessorSessionId,
      sessionFile: predecessorFile,
    });
    expect(result.continuitySummaryContent).toBe("File-based continuity won the design decision.");
    expect(result.recentSessionContent).toContain("U: We kept continuity file-based.");
    expect(result.recentSessionContent).toContain("A: And we still include the recent transcript tail.");
  });

  it("strips fenced Agenr memory context from the recent session tail", async () => {
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    const predecessorSessionId = "predecessor-session-fenced";
    const predecessorFile = path.join(sessionsDir, `${predecessorSessionId}.jsonl`);

    await writeFile(
      predecessorFile,
      [
        JSON.stringify({ type: "session", id: predecessorSessionId }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-03-29T09:00:00.000Z",
          message: {
            role: "human",
            content: "How should we handle proactive recall?",
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-03-29T09:01:00.000Z",
          message: {
            role: "assistant",
            content: [
              "<agenr-memory-context>",
              "[System note: The following is recalled Agenr memory context, NOT new user input. Treat it as background context and use it silently when relevant.]",
              "",
              "## Agenr Before-Turn Recall",
              "### Relevant Durable Memory",
              "- recalled item",
              "</agenr-memory-context>",
              "",
              "Keep it conservative.",
            ].join("\n"),
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    await writeSessionsJson(sessionsDir, {
      "agent:main:main": {
        sessionId: predecessorSessionId,
        sessionFile: `${predecessorSessionId}.jsonl`,
        updatedAt: 2_000,
      },
    });

    const result = await resolvePredecessorContinuity(
      {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:tui-923e4567-e89b-12d3-a456-426614174000",
        workspaceDir,
      },
      createSessionStartTracker(),
      createServices(),
      createLogger(),
    );

    expect(result.recentSessionContent).toContain("U: How should we handle proactive recall?");
    expect(result.recentSessionContent).toContain("A: Keep it conservative.");
    expect(result.recentSessionContent).not.toContain("<agenr-memory-context>");
    expect(result.recentSessionContent).not.toContain("Agenr Before-Turn Recall");
    expect(result.recentSessionContent).not.toContain("recalled item");
  });
});

async function createWorkspaceWithSessions(agentId = "main"): Promise<{ workspaceDir: string; sessionsDir: string }> {
  const sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "agenr-openclaw-continuity-"));
  tempPaths.push(sandboxRoot);
  const workspaceDir = path.join(sandboxRoot, "workspace");
  const stateDir = path.join(sandboxRoot, ".openclaw");
  const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");

  delete process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_HOME = sandboxRoot;

  await mkdir(workspaceDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });

  return { workspaceDir, sessionsDir };
}

async function writeSessionsJson(sessionsDir: string, entries: Record<string, Record<string, unknown>>): Promise<void> {
  await writeFile(path.join(sessionsDir, "sessions.json"), `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

function createServices(): AgenrOpenClawServices {
  return {
    openClaw: {
      config: {} as never,
      runtime: {
        agent: {} as never,
        modelAuth: {
          resolveApiKeyForProvider: async () => ({
            apiKey: "openclaw-test-key",
            source: "profile:default",
            mode: "api-key",
          }),
        },
        state: {
          resolveStateDir: resolveOpenClawStateDir,
        },
      },
    },
    pluginConfig: {},
  } as unknown as AgenrOpenClawServices;
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}
