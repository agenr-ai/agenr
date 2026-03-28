import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveOpenClawSessionPredecessor } from "../../../../src/adapters/openclaw/session/predecessor.js";
import { createSessionStartTracker } from "../../../../src/adapters/openclaw/session/state.js";

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    await rm(tempPaths.pop() ?? "", { force: true, recursive: true });
  }
});

describe("resolveOpenClawSessionPredecessor", () => {
  it("falls back from a TUI /new session to the previous default main session", async () => {
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    await writeSessionJsonl(sessionsDir, "previous-main");
    await writeSessionsJson(sessionsDir, {
      "agent:main:main": {
        sessionId: "previous-main",
        sessionFile: "previous-main.jsonl",
        updatedAt: 2_000,
      },
      "agent:worker:tui-123e4567-e89b-12d3-a456-426614174000": {
        sessionId: "other-agent",
        sessionFile: "other-agent.jsonl",
        updatedAt: 9_000,
      },
    });

    const logger = createLogger();
    const result = await resolveOpenClawSessionPredecessor(
      {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:tui-223e4567-e89b-12d3-a456-426614174000",
        workspaceDir,
      },
      createSessionStartTracker(),
      logger,
    );

    expect(result).toEqual({
      sessionId: "previous-main",
      sessionFile: path.join(sessionsDir, "previous-main.jsonl"),
    });
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] predecessor: TUI fallback activated for session=current-session key=agent:main:tui-223e4567-e89b-12d3-a456-426614174000 sessionKey=agent:main:tui-223e4567-e89b-12d3-a456-426614174000 stableLane=tui",
        `[agenr] predecessor: TUI fallback predecessor found for session=current-session key=agent:main:tui-223e4567-e89b-12d3-a456-426614174000 predecessorKey=agent:main:main predecessor=${path.join(sessionsDir, "previous-main.jsonl")}`,
      ]),
    );
  });

  it("treats current tui uuid sessions as the broad tui continuity bucket", async () => {
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    await writeSessionJsonl(sessionsDir, "tui-1-prev");
    await writeSessionJsonl(sessionsDir, "tui-2-prev");
    await writeSessionJsonl(sessionsDir, "previous-main");
    await writeSessionsJson(sessionsDir, {
      "agent:main:tui-1": {
        sessionId: "tui-1-prev",
        sessionFile: "tui-1-prev.jsonl",
        updatedAt: 3_000,
      },
      "agent:main:tui-2": {
        sessionId: "tui-2-prev",
        sessionFile: "tui-2-prev.jsonl",
        updatedAt: 2_000,
      },
      "agent:main:main": {
        sessionId: "previous-main",
        sessionFile: "previous-main.jsonl",
        updatedAt: 1_000,
      },
    });

    const result = await resolveOpenClawSessionPredecessor(
      {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:tui-323e4567-e89b-12d3-a456-426614174000",
        workspaceDir,
      },
      createSessionStartTracker(),
      createLogger(),
    );

    expect(result).toEqual({
      sessionId: "tui-1-prev",
      sessionFile: path.join(sessionsDir, "tui-1-prev.jsonl"),
    });
  });

  it("keeps the primary tracker path for TUI resets without activating fallback", async () => {
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    await writeSessionJsonl(sessionsDir, "stale-fallback");
    await writeSessionsJson(sessionsDir, {
      "agent:main:tui-1": {
        sessionId: "stale-fallback",
        sessionFile: "stale-fallback.jsonl",
        updatedAt: 5_000,
      },
    });

    const tracker = createSessionStartTracker();
    tracker.rememberReset("agent:main:tui-423e4567-e89b-12d3-a456-426614174000", {
      sessionId: "tracked-predecessor",
      sessionFile: "/tmp/tracked-predecessor.jsonl",
      recordedAt: "2026-03-28T10:00:00.000Z",
    });
    tracker.rememberSessionStart("current-session", "agent:main:tui-423e4567-e89b-12d3-a456-426614174000", "tracked-predecessor");

    const logger = createLogger();
    const result = await resolveOpenClawSessionPredecessor(
      {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:tui-423e4567-e89b-12d3-a456-426614174000",
        workspaceDir,
      },
      tracker,
      logger,
    );

    expect(result).toEqual({
      sessionId: "tracked-predecessor",
      sessionFile: "/tmp/tracked-predecessor.jsonl",
    });
    expect(getMessages(logger.info).some((message) => message.includes("TUI fallback activated"))).toBe(false);
  });

  it("returns undefined gracefully when sessions.json is missing", async () => {
    const { workspaceDir } = await createWorkspaceWithSessions();
    const logger = createLogger();

    const result = await resolveOpenClawSessionPredecessor(
      {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:tui-523e4567-e89b-12d3-a456-426614174000",
        workspaceDir,
      },
      createSessionStartTracker(),
      logger,
    );

    expect(result).toBeUndefined();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] predecessor: TUI fallback activated for session=current-session key=agent:main:tui-523e4567-e89b-12d3-a456-426614174000 sessionKey=agent:main:tui-523e4567-e89b-12d3-a456-426614174000 stableLane=tui",
        "[agenr] predecessor: TUI fallback no predecessor found for session=current-session key=agent:main:tui-523e4567-e89b-12d3-a456-426614174000 reason=no_matching_sessions",
      ]),
    );
  });

  it("does not activate fallback for non-tui current session keys", async () => {
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    await writeSessionJsonl(sessionsDir, "previous-main");
    await writeSessionsJson(sessionsDir, {
      "agent:main:main": {
        sessionId: "previous-main",
        sessionFile: "previous-main.jsonl",
        updatedAt: 2_000,
      },
    });

    const logger = createLogger();
    const result = await resolveOpenClawSessionPredecessor(
      {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:webchat:tab-a",
        workspaceDir,
      },
      createSessionStartTracker(),
      logger,
    );

    expect(result).toBeUndefined();
    expect(getMessages(logger.info).some((message) => message.includes("TUI fallback"))).toBe(false);
  });
});

async function createWorkspaceWithSessions(): Promise<{ workspaceDir: string; sessionsDir: string }> {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "agenr-openclaw-workspace-"));
  tempPaths.push(workspaceDir);
  const sessionsDir = path.join(workspaceDir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  return { workspaceDir, sessionsDir };
}

async function writeSessionJsonl(sessionsDir: string, sessionId: string): Promise<void> {
  await writeFile(path.join(sessionsDir, `${sessionId}.jsonl`), `${JSON.stringify({ type: "session", id: sessionId })}\n`, "utf8");
}

async function writeSessionsJson(sessionsDir: string, entries: Record<string, Record<string, unknown>>): Promise<void> {
  await writeFile(path.join(sessionsDir, "sessions.json"), `${JSON.stringify(entries, null, 2)}\n`, "utf8");
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
