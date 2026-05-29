import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveStateDir as resolveOpenClawStateDir } from "openclaw/plugin-sdk/state-paths";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveOpenClawSessionPredecessor } from "../../../../../src/adapters/openclaw/session/continuity/predecessor-resolver.js";
import { createSessionStartTracker } from "../../../../../src/app/plugin-runtime/session-tracking.js";

const tempPaths: string[] = [];
const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
const originalOpenClawHome = process.env.OPENCLAW_HOME;
const originalHome = process.env.HOME;

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
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  vi.restoreAllMocks();

  while (tempPaths.length > 0) {
    await rm(tempPaths.pop() ?? "", { force: true, recursive: true });
  }
});

describe("resolveOpenClawSessionPredecessor", () => {
  it("uses OPENCLAW_HOME instead of workspace-relative sessions paths", async () => {
    const { workspaceDir, sessionsDir, workspaceSessionsDir } = await createWorkspaceWithSessions();
    await writeSessionJsonl(sessionsDir, "previous-main");
    await writeSessionsJson(sessionsDir, {
      "agent:main:main": {
        sessionId: "previous-main",
        sessionFile: "previous-main.jsonl",
        updatedAt: 2_000,
      },
    });
    await writeSessionJsonl(workspaceSessionsDir, "wrong-workspace-session");
    await writeSessionsJson(workspaceSessionsDir, {
      "agent:main:main": {
        sessionId: "wrong-workspace-session",
        sessionFile: "wrong-workspace-session.jsonl",
        updatedAt: 9_000,
      },
    });

    const logger = createLogger();
    const result = await resolveOpenClawSessionPredecessor(
      {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:tui-123e4567-e89b-12d3-a456-426614174000",
        workspaceDir,
      },
      createSessionStartTracker(),
      {
        logger,
        resolveStateDir: resolveOpenClawStateDir,
      },
    );

    expect(result).toEqual({
      sessionId: "previous-main",
      sessionFile: path.join(sessionsDir, "previous-main.jsonl"),
    });
    expect(getMessages(logger.debug)).toEqual(
      expect.arrayContaining([`[agenr] sessions-store-reader: loaded sessions.json entries=1 path=${path.join(sessionsDir, "sessions.json")}`]),
    );
    expect(getMessages(logger.debug).some((message) => message.includes(path.join(workspaceSessionsDir, "sessions.json")))).toBe(false);
  });

  it("prefers OPENCLAW_STATE_DIR over OPENCLAW_HOME when both are set", async () => {
    const sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "agenr-openclaw-sandbox-"));
    tempPaths.push(sandboxRoot);
    const workspaceDir = path.join(sandboxRoot, "workspace");
    const homeStateDir = path.join(sandboxRoot, ".openclaw");
    const stateOverrideDir = path.join(sandboxRoot, "explicit-state");
    const homeSessionsDir = path.join(homeStateDir, "agents", "main", "sessions");
    const stateOverrideSessionsDir = path.join(stateOverrideDir, "agents", "main", "sessions");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(homeSessionsDir, { recursive: true });
    await mkdir(stateOverrideSessionsDir, { recursive: true });
    await writeSessionJsonl(homeSessionsDir, "wrong-home-session");
    await writeSessionsJson(homeSessionsDir, {
      "agent:main:main": {
        sessionId: "wrong-home-session",
        sessionFile: "wrong-home-session.jsonl",
        updatedAt: 1_000,
      },
    });
    await writeSessionJsonl(stateOverrideSessionsDir, "preferred-state-session");
    await writeSessionsJson(stateOverrideSessionsDir, {
      "agent:main:main": {
        sessionId: "preferred-state-session",
        sessionFile: "preferred-state-session.jsonl",
        updatedAt: 2_000,
      },
    });
    process.env.OPENCLAW_HOME = sandboxRoot;
    process.env.OPENCLAW_STATE_DIR = stateOverrideDir;

    const result = await resolveOpenClawSessionPredecessor(
      {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:tui-123e4567-e89b-12d3-a456-426614174999",
        workspaceDir,
      },
      createSessionStartTracker(),
      {
        logger: createLogger(),
        resolveStateDir: resolveOpenClawStateDir,
      },
    );

    expect(result).toEqual({
      sessionId: "preferred-state-session",
      sessionFile: path.join(stateOverrideSessionsDir, "preferred-state-session.jsonl"),
    });
  });

  it("falls back to ~/.openclaw when OPENCLAW_STATE_DIR is unset", async () => {
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_HOME;

    const fakeHomeDir = await mkdtemp(path.join(os.tmpdir(), "agenr-openclaw-home-"));
    tempPaths.push(fakeHomeDir);
    const sessionsDir = path.join(fakeHomeDir, ".openclaw", "agents", "main", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeSessionJsonl(sessionsDir, "previous-main");
    await writeSessionsJson(sessionsDir, {
      "agent:main:main": {
        sessionId: "previous-main",
        sessionFile: "previous-main.jsonl",
        updatedAt: 2_000,
      },
    });

    process.env.HOME = fakeHomeDir;

    const result = await resolveOpenClawSessionPredecessor(
      {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:tui-133e4567-e89b-12d3-a456-426614174000",
        workspaceDir: path.join(fakeHomeDir, "workspace"),
      },
      createSessionStartTracker(),
      {
        logger: createLogger(),
        resolveStateDir: resolveOpenClawStateDir,
      },
    );

    expect(result).toEqual({
      sessionId: "previous-main",
      sessionFile: path.join(sessionsDir, "previous-main.jsonl"),
    });
  });

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
      {
        logger,
        resolveStateDir: resolveOpenClawStateDir,
      },
    );

    expect(result).toEqual({
      sessionId: "previous-main",
      sessionFile: path.join(sessionsDir, "previous-main.jsonl"),
    });
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] predecessor: predecessor resolution for session=current-session key=agent:main:tui-223e4567-e89b-12d3-a456-426614174000 strategy=sessions_json_scan sessionKey=agent:main:tui-223e4567-e89b-12d3-a456-426614174000 kind=tui stableLane=tui",
        `[agenr] predecessor: predecessor found for session=current-session key=agent:main:tui-223e4567-e89b-12d3-a456-426614174000 strategy=sessions_json_scan predecessorKey=agent:main:main predecessor=${path.join(sessionsDir, "previous-main.jsonl")}`,
      ]),
    );
  });

  it("derives the predecessor sessionId from the session file when sessions.json omits it", async () => {
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    await writeSessionJsonl(sessionsDir, "derived-from-file");
    await writeSessionsJson(sessionsDir, {
      "agent:main:main": {
        sessionFile: "derived-from-file.jsonl",
        updatedAt: 2_000,
      },
    });

    const result = await resolveOpenClawSessionPredecessor(
      {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:tui-623e4567-e89b-12d3-a456-426614174000",
        workspaceDir,
      },
      createSessionStartTracker(),
      {
        logger: createLogger(),
        resolveStateDir: resolveOpenClawStateDir,
      },
    );

    expect(result).toEqual({
      sessionId: "derived-from-file",
      sessionFile: path.join(sessionsDir, "derived-from-file.jsonl"),
    });
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
      {
        logger: createLogger(),
        resolveStateDir: resolveOpenClawStateDir,
      },
    );

    expect(result).toEqual({
      sessionId: "tui-1-prev",
      sessionFile: path.join(sessionsDir, "tui-1-prev.jsonl"),
    });
  });

  it("falls back to sessions.json ordering for main sessions when resumedFrom is missing", async () => {
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    await writeSessionJsonl(sessionsDir, "older-main");
    await writeSessionJsonl(sessionsDir, "newer-main");
    await writeSessionsJson(sessionsDir, {
      "agent:main:main-old": {
        sessionId: "ignore-me",
        sessionFile: "ignore-me.jsonl",
        updatedAt: 1_000,
      },
      "agent:main:main": {
        sessionId: "newer-main",
        sessionFile: "newer-main.jsonl",
        updatedAt: 9_000,
      },
      "agent:main:tui-1": {
        sessionId: "older-main",
        sessionFile: "older-main.jsonl",
        updatedAt: 8_000,
      },
    });

    const tracker = createSessionStartTracker();
    tracker.rememberSessionStart("current-session", "agent:main:main", "missing-predecessor");
    const logger = createLogger();

    const result = await resolveOpenClawSessionPredecessor(
      {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:main",
        workspaceDir,
      },
      tracker,
      {
        logger,
        resolveStateDir: resolveOpenClawStateDir,
      },
    );

    expect(result).toEqual({
      sessionId: "newer-main",
      sessionFile: path.join(sessionsDir, "newer-main.jsonl"),
    });
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] predecessor: predecessor resolution for session=current-session key=agent:main:main strategy=sessions_json_scan sessionKey=agent:main:main kind=main stableLane=main",
        `[agenr] predecessor: predecessor found for session=current-session key=agent:main:main strategy=sessions_json_scan predecessorKey=agent:main:main predecessor=${path.join(sessionsDir, "newer-main.jsonl")}`,
      ]),
    );
  });

  it("resolves main-session predecessors from resumedFrom reset archives", async () => {
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    const archivedPredecessor = await writeArchivedSessionJsonl(sessionsDir, "predecessor-session", "reset.2026-03-31T10:00:00.000Z");

    const tracker = createSessionStartTracker();
    tracker.rememberSessionStart("current-session", "agent:main:main", "predecessor-session");
    const logger = createLogger();

    const result = await resolveOpenClawSessionPredecessor(
      {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:main",
        workspaceDir,
      },
      tracker,
      {
        logger,
        resolveStateDir: resolveOpenClawStateDir,
      },
    );

    expect(result).toEqual({
      sessionId: "predecessor-session",
      sessionFile: archivedPredecessor,
    });
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        `[agenr] predecessor: predecessor found for session=current-session key=agent:main:main strategy=resumed_from predecessorKey=session_start predecessor=${archivedPredecessor}`,
      ]),
    );
  });

  it("resolves direct-message predecessors from resumedFrom live files", async () => {
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    const predecessorFile = await writeSessionJsonl(sessionsDir, "direct-predecessor");

    const tracker = createSessionStartTracker();
    tracker.rememberSessionStart("current-session", "agent:main:telegram:direct:123", "direct-predecessor");

    const result = await resolveOpenClawSessionPredecessor(
      {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:telegram:direct:123",
        workspaceDir,
      },
      tracker,
      {
        logger: createLogger(),
        resolveStateDir: resolveOpenClawStateDir,
      },
    );

    expect(result).toEqual({
      sessionId: "direct-predecessor",
      sessionFile: predecessorFile,
    });
  });

  it("accepts cold start for direct-message sessions when resumedFrom cannot be resolved", async () => {
    const { workspaceDir } = await createWorkspaceWithSessions();
    const tracker = createSessionStartTracker();
    tracker.rememberSessionStart("current-session", "agent:main:telegram:direct:123", "missing-predecessor");
    const logger = createLogger();

    const result = await resolveOpenClawSessionPredecessor(
      {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:telegram:direct:123",
        workspaceDir,
      },
      tracker,
      {
        logger,
        resolveStateDir: resolveOpenClawStateDir,
      },
    );

    expect(result).toBeUndefined();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] predecessor: no predecessor found for session=current-session key=agent:main:telegram:direct:123 strategy=resumed_from reason=cold_start_after_resumed_from_miss",
      ]),
    );
  });

  it("resolves same-group predecessors from resumedFrom archived files", async () => {
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    const predecessorFile = await writeArchivedSessionJsonl(sessionsDir, "group-predecessor", "reset.2026-03-31T10:00:00.000Z");

    const tracker = createSessionStartTracker();
    tracker.rememberSessionStart("current-session", "agent:main:telegram:group:-100123", "group-predecessor");

    const result = await resolveOpenClawSessionPredecessor(
      {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:telegram:group:-100123",
        workspaceDir,
      },
      tracker,
      {
        logger: createLogger(),
        resolveStateDir: resolveOpenClawStateDir,
      },
    );

    expect(result).toEqual({
      sessionId: "group-predecessor",
      sessionFile: predecessorFile,
    });
  });

  it("keeps group-topic continuity isolated to the exact topic lane", async () => {
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    await writeArchivedSessionJsonl(sessionsDir, "topic-41-predecessor", "reset.2026-03-31T10:00:00.000Z");

    const tracker = createSessionStartTracker();
    tracker.rememberSessionStart("current-session", "agent:main:telegram:group:-100123:topic:42", "missing-topic-42");
    const logger = createLogger();

    const result = await resolveOpenClawSessionPredecessor(
      {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:telegram:group:-100123:topic:42",
        workspaceDir,
      },
      tracker,
      {
        logger,
        resolveStateDir: resolveOpenClawStateDir,
      },
    );

    expect(result).toBeUndefined();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] predecessor: no predecessor found for session=current-session key=agent:main:telegram:group:-100123:topic:42 strategy=resumed_from reason=cold_start_after_resumed_from_miss",
      ]),
    );
  });

  it("accepts cold start for group sessions when resumedFrom cannot be resolved", async () => {
    const { workspaceDir } = await createWorkspaceWithSessions();
    const tracker = createSessionStartTracker();
    tracker.rememberSessionStart("current-session", "agent:main:telegram:group:-100123", "missing-group");
    const logger = createLogger();

    const result = await resolveOpenClawSessionPredecessor(
      {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:telegram:group:-100123",
        workspaceDir,
      },
      tracker,
      {
        logger,
        resolveStateDir: resolveOpenClawStateDir,
      },
    );

    expect(result).toBeUndefined();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] predecessor: no predecessor found for session=current-session key=agent:main:telegram:group:-100123 strategy=resumed_from reason=cold_start_after_resumed_from_miss",
      ]),
    );
  });

  it("accepts cold start for channel-thread sessions when resumedFrom cannot be resolved", async () => {
    const { workspaceDir } = await createWorkspaceWithSessions();
    const tracker = createSessionStartTracker();
    tracker.rememberSessionStart("current-session", "agent:main:discord:channel:123:thread:456", "missing-thread");
    const logger = createLogger();

    const result = await resolveOpenClawSessionPredecessor(
      {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:discord:channel:123:thread:456",
        workspaceDir,
      },
      tracker,
      {
        logger,
        resolveStateDir: resolveOpenClawStateDir,
      },
    );

    expect(result).toBeUndefined();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] predecessor: no predecessor found for session=current-session key=agent:main:discord:channel:123:thread:456 strategy=resumed_from reason=cold_start_after_resumed_from_miss",
      ]),
    );
  });

  it("returns undefined for unknown and ineligible current key kinds", async () => {
    const { workspaceDir } = await createWorkspaceWithSessions();

    await expect(
      resolveOpenClawSessionPredecessor(
        {
          agentId: "main",
          sessionId: "current-session",
          sessionKey: "agent:main:discord:slash:123",
          workspaceDir,
        },
        createSessionStartTracker(),
        {
          logger: createLogger(),
          resolveStateDir: resolveOpenClawStateDir,
        },
      ),
    ).resolves.toBeUndefined();

    await expect(
      resolveOpenClawSessionPredecessor(
        {
          agentId: "main",
          sessionId: "current-session",
          sessionKey: "agent:main:subagent:123",
          workspaceDir,
        },
        createSessionStartTracker(),
        {
          logger: createLogger(),
          resolveStateDir: resolveOpenClawStateDir,
        },
      ),
    ).resolves.toBeUndefined();
  });
});

async function createWorkspaceWithSessions(agentId = "main"): Promise<{ workspaceDir: string; sessionsDir: string; workspaceSessionsDir: string }> {
  const sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "agenr-openclaw-sandbox-"));
  tempPaths.push(sandboxRoot);
  const workspaceDir = path.join(sandboxRoot, "workspace");
  const stateDir = path.join(sandboxRoot, ".openclaw");
  const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
  const workspaceSessionsDir = path.join(workspaceDir, "sessions");
  delete process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_HOME = sandboxRoot;
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(workspaceSessionsDir, { recursive: true });
  return { workspaceDir, sessionsDir, workspaceSessionsDir };
}

async function writeSessionJsonl(sessionsDir: string, sessionId: string): Promise<string> {
  const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);
  await writeFile(filePath, `${JSON.stringify({ type: "session", id: sessionId })}\n`, "utf8");
  return filePath;
}

async function writeArchivedSessionJsonl(sessionsDir: string, sessionId: string, suffix: string): Promise<string> {
  const filePath = path.join(sessionsDir, `${sessionId}.jsonl.${suffix}`);
  await writeFile(filePath, `${JSON.stringify({ type: "session", id: sessionId })}\n`, "utf8");
  return filePath;
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
