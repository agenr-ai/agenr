import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveStateDir as resolveOpenClawStateDir } from "openclaw/plugin-sdk/state-paths";
import { afterEach, describe, expect, it, vi } from "vitest";

const openClawLlmClientMocks = vi.hoisted(() => ({
  createOpenClawLlmClient: vi.fn(),
}));

vi.mock("../../../src/adapters/openclaw/llm/openclaw-llm-client.js", () => ({
  createOpenClawLlmClient: openClawLlmClientMocks.createOpenClawLlmClient,
}));

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { createOpenClawRepository } from "../../../src/adapters/db/openclaw-repository.js";
import { createSessionStartRepository } from "../../../src/adapters/db/session-start-repository.js";
import { handleAgenrAfterToolCall } from "../../../src/adapters/openclaw/hooks/after-tool-call.js";
import { handleAgenrBeforePromptBuild } from "../../../src/adapters/openclaw/hooks/before-prompt-build.js";
import { createMidSessionTracker, createSessionStartTracker } from "../../../src/adapters/openclaw/session/state.js";
import type { AgenrOpenClawHost, AgenrOpenClawServices } from "../../../src/adapters/openclaw/types.js";
import type { EmbeddingPort, LlmPort, RecallPorts } from "../../../src/core/ports.js";
import type { Entry } from "../../../src/core/types.js";

const openDatabases: SqlDatabase[] = [];
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
  vi.clearAllTimers();
  vi.useRealTimers();
  openClawLlmClientMocks.createOpenClawLlmClient.mockReset();

  while (openDatabases.length > 0) {
    await openDatabases.pop()?.close();
  }

  while (tempPaths.length > 0) {
    await rm(tempPaths.pop() ?? "", { force: true, recursive: true });
  }
});

describe("handleAgenrBeforePromptBuild", () => {
  it("injects only core session-start memory once per session and skips speculative recall", async () => {
    const database = await createTestDatabase();
    const executeSpy = vi.spyOn(database, "execute");
    const logger = createLogger();
    const recall = createObservedRecallPorts();
    await database.insertEntry(
      createEntry({
        type: "decision",
        subject: "master branch workflow",
        content: "Branch from local master, commit, then fast-forward merge back to master.",
        expiry: "core",
        importance: 10,
      }),
      createEmbedding(0, 1),
      "core-workflow",
    );
    await database.insertEntry(
      createEntry({
        type: "milestone",
        subject: "latest plugin work",
        content: "Phase 1 of the agenr OpenClaw memory plugin is in progress.",
        expiry: "temporary",
        importance: 8,
      }),
      createEmbedding(1, 1),
      "recent-work",
    );

    const tracker = createSessionStartTracker();
    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "What should I work on next?",
        messages: [],
      },
      {
        sessionId: "session-1",
        sessionKey: "agent:main:webchat:test",
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            available: true,
            recall,
          }),
        ),
        tracker,
      },
    );
    const secondResult = await handleAgenrBeforePromptBuild(
      {
        prompt: "And after that?",
        messages: [],
      },
      {
        sessionId: "session-1",
        sessionKey: "agent:main:webchat:test",
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            available: true,
            recall,
          }),
        ),
        tracker,
      },
    );

    expect(result?.prependContext).toContain("Agenr Session Recall");
    expect(result?.prependContext).toContain("Core Memory");
    expect(result?.prependContext).toContain("master branch workflow");
    expect(result?.prependContext).not.toContain("latest plugin work");
    expect(result?.prependContext).not.toContain("Relevant Recall");
    expect(result?.prependContext).not.toContain("Recent Context");
    expect(result?.prependContext).not.toContain("## Previous session summary");
    expect(result?.prependContext).not.toContain("## Recent session");
    expect(result?.prependContext).not.toContain("Recent Handoffs");
    expect(secondResult).toBeUndefined();
    expectRecallPortsUnused(recall);
    expect(listExecutedSql(executeSpy.mock.calls).some((sql) => sql.includes("expiry != 'core'"))).toBe(false);
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] session-start recall for session=session-1 key=agent:main:webchat:test",
        "[agenr] session-start predecessor continuity summary not found for session=session-1 key=agent:main:webchat:test reason=no_predecessor",
        "[agenr] session-start recall: 1 durable entries for session=session-1 key=agent:main:webchat:test (core_candidates=1 artifact_candidates=0)",
        "[agenr] session-start recall skipped (already ran) for session=session-1 key=agent:main:webchat:test",
      ]),
    );
    expect(getMessages(logger.debug)).toEqual(
      expect.arrayContaining([
        "[agenr] before_prompt_build: session tracker first start for session=session-1 key=agent:main:webchat:test",
        "[agenr] before_prompt_build: session tracker duplicate blocked for session=session-1 key=agent:main:webchat:test",
        expect.stringContaining(
          "[agenr] before_prompt_build: session-start durable entries for session=session-1 key=agent:main:webchat:test: master branch workflow",
        ),
      ]),
    );
    expect(
      getMessages(logger.debug).some((message) => message.includes("session-start relevant entries") || message.includes("session-start recent entries")),
    ).toBe(false);
  });

  it("injects continuity for a main-session predecessor resolved from resumedFrom archive", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    const tracker = createSessionStartTracker();
    tracker.rememberSessionStart("session-main-new", "agent:main:main", "predecessor-session");

    const predecessorFile = await writeArchivedSessionFileToDirectory(sessionsDir, "predecessor-session", "reset.2026-03-31T10:00:00.000Z", [
      {
        type: "session",
        id: "predecessor-session",
      },
      {
        type: "message",
        timestamp: "2026-03-28T09:00:00.000Z",
        message: {
          role: "human",
          content: "Continue from the main session after the reset.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T09:01:00.000Z",
        message: {
          role: "assistant",
          content: "The main session summary should come from the archived predecessor transcript.",
        },
      },
    ]);
    await writeFile(
      path.join(sessionsDir, "predecessor-session.continuity-summary.md"),
      "Main-session continuity should survive resets through resumedFrom archive lookup.\n",
      "utf8",
    );

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Resume the main session.",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: "session-main-new",
        sessionKey: "agent:main:main",
        workspaceDir,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
      },
    );

    expect(result?.prependContext).toContain("## Previous session summary");
    expect(result?.prependContext).toContain("Main-session continuity should survive resets");
    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).toContain("U: Continue from the main session after the reset.");
    expect(result?.prependContext).not.toContain("Agenr Session Recall");
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        `[agenr] predecessor: predecessor found for session=session-main-new key=agent:main:main strategy=resumed_from predecessorKey=session_start predecessor=${predecessorFile}`,
        `[agenr] session-start predecessor continuity summary found for session=session-main-new key=agent:main:main path=` +
          path.join(sessionsDir, "predecessor-session.continuity-summary.md"),
      ]),
    );
  });

  it("injects predecessor continuity summary and transcript tail alongside core memory only", async () => {
    const database = await createTestDatabase();
    const executeSpy = vi.spyOn(database, "execute");
    const logger = createLogger();
    const recall = createObservedRecallPorts();
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    const currentSessionId = "session-tui-isolated";
    const currentSessionKey = "agent:main:tui-423e4567-e89b-12d3-a456-426614174000";
    const coreEntry = createEntry({
      type: "decision",
      subject: "session isolation rule",
      content: "Keep each TUI session pinned to its own session key and continuity chain.",
      expiry: "core",
      importance: 10,
    });
    const relevantEntry = createEntry({
      type: "lesson",
      subject: "multi-session drift check",
      content: "Operators grep gateway.err.log by session key to verify recall stayed isolated.",
      expiry: "permanent",
      importance: 8,
      tags: ["openclaw", "debugging"],
    });
    const recentEntry = createEntry({
      type: "milestone",
      subject: "latest plugin work",
      content: "Structured OpenClaw logging is being wired into session-start recall.",
      expiry: "temporary",
      importance: 8,
    });

    await database.insertEntry(coreEntry, createEmbedding(0, 1), "core-workflow");
    await database.insertEntry(relevantEntry, createEmbedding(1, 1), "relevant-workflow");
    await database.insertEntry(recentEntry, createEmbedding(2, 1), "recent-workflow");

    const predecessorFile = await writeSessionFileToDirectory(sessionsDir, "predecessor-session", [
      {
        type: "session",
        id: "predecessor-session",
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:00:00.000Z",
        message: {
          role: "human",
          content: "We need file-based continuity instead of handoff brain entries.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:01:00.000Z",
        message: {
          role: "assistant",
          content: "Agreed. We will write a continuity-summary.md sidecar next to the session transcript.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:02:00.000Z",
        message: {
          role: "human",
          content: "Keep the transcript tail too so tone and last exchanges survive when the continuity summary is missing.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:03:00.000Z",
        message: {
          role: "assistant",
          content: "Understood. No handoff entries will be stored in the brain.",
        },
      },
    ]);
    await writeSessionsJson(sessionsDir, {
      "agent:main:main": {
        sessionId: "predecessor-session",
        sessionFile: "predecessor-session.jsonl",
        updatedAt: 1_711_612_345_678,
      },
    });
    await writeFile(
      path.join(path.dirname(predecessorFile), "predecessor-session.continuity-summary.md"),
      "The session settled on file-based continuity. Continuity summary files live next to transcript JSONL, transcript tails remain as fallback, and no handoff entries go into the brain.\n",
      "utf8",
    );

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Verify each TUI session stays isolated and continuity is file-based.",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: currentSessionId,
        sessionKey: currentSessionKey,
        workspaceDir,
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            available: true,
            recall,
          }),
        ),
        tracker: createSessionStartTracker(),
      },
    );

    expect(result?.prependContext).toContain("## Previous session summary");
    expect(result?.prependContext).toContain("file-based continuity");
    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).toContain("U: Keep the transcript tail too");
    expect(result?.prependContext).toContain("Agenr Session Recall");
    expect(result?.prependContext).toContain("Core Memory");
    expect(result?.prependContext).toContain("session isolation rule");
    expect(result?.prependContext).not.toContain("multi-session drift check");
    expect(result?.prependContext).not.toContain("latest plugin work");
    expect(result?.prependContext).not.toContain("Relevant Durable Memory");
    expect(result?.prependContext).not.toContain("Recent Handoffs");
    expect(recall.embed).toHaveBeenCalledOnce();
    expect(recall.vectorSearch).toHaveBeenCalledOnce();
    expect(recall.ftsSearch).toHaveBeenCalledOnce();
    expect(listExecutedSql(executeSpy.mock.calls).some((sql) => sql.includes("expiry != 'core'"))).toBe(false);
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        `[agenr] predecessor: predecessor found for session=${currentSessionId} key=${currentSessionKey} strategy=sessions_json_scan predecessorKey=agent:main:main predecessor=${predecessorFile}`,
        `[agenr] session-start predecessor continuity summary found for session=${currentSessionId} key=${currentSessionKey} path=` +
          path.join(path.dirname(predecessorFile), "predecessor-session.continuity-summary.md"),
        `[agenr] session-start recall: 1 durable entries for session=${currentSessionId} key=${currentSessionKey} (core_candidates=1 artifact_candidates=0)`,
      ]),
    );
  });

  it("injects continuity for the same group lane via resumedFrom", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    const tracker = createSessionStartTracker();
    tracker.rememberSessionStart("session-group-new", "agent:main:telegram:group:-100123", "group-predecessor");

    const predecessorFile = await writeArchivedSessionFileToDirectory(sessionsDir, "group-predecessor", "reset.2026-03-31T10:00:00.000Z", [
      {
        type: "session",
        id: "group-predecessor",
      },
      {
        type: "message",
        timestamp: "2026-03-28T11:00:00.000Z",
        message: {
          role: "human",
          content: "Carry group continuity forward for the same Telegram group.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T11:01:00.000Z",
        message: {
          role: "assistant",
          content: "Only the same group lane should get this predecessor summary.",
        },
      },
    ]);
    await writeFile(
      path.join(sessionsDir, "group-predecessor.continuity-summary.md"),
      "Same-group continuity should flow through resumedFrom without sessions.json scanning.\n",
      "utf8",
    );

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Continue the Telegram group session.",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: "session-group-new",
        sessionKey: "agent:main:telegram:group:-100123",
        workspaceDir,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
      },
    );

    expect(result?.prependContext).toContain("## Previous session summary");
    expect(result?.prependContext).toContain("Same-group continuity should flow");
    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).toContain("U: Carry group continuity forward");
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        `[agenr] predecessor: predecessor found for session=session-group-new key=agent:main:telegram:group:-100123 strategy=resumed_from predecessorKey=session_start predecessor=${predecessorFile}`,
      ]),
    );
  });

  it("does not inject continuity from a different group topic when resumedFrom is unavailable", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();

    await writeSessionFileToDirectory(sessionsDir, "topic-41-predecessor", [
      {
        type: "session",
        id: "topic-41-predecessor",
      },
      {
        type: "message",
        timestamp: "2026-03-28T12:00:00.000Z",
        message: {
          role: "human",
          content: "This continuity belongs to Telegram topic 41 only.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T12:01:00.000Z",
        message: {
          role: "assistant",
          content: "Topic 42 must not inherit it without an exact resumedFrom predecessor.",
        },
      },
    ]);
    await writeSessionsJson(sessionsDir, {
      "agent:main:telegram:group:-100123:topic:41": {
        sessionId: "topic-41-predecessor",
        sessionFile: "topic-41-predecessor.jsonl",
        updatedAt: 1_711_612_345_678,
      },
    });
    await writeFile(path.join(sessionsDir, "topic-41-predecessor.continuity-summary.md"), "Topic 41 continuity should not leak into topic 42.\n", "utf8");

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Continue the Telegram topic 42 session.",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: "session-topic-42",
        sessionKey: "agent:main:telegram:group:-100123:topic:42",
        workspaceDir,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker: createSessionStartTracker(),
      },
    );

    expect(result).toBeUndefined();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] session-start predecessor continuity summary not found for session=session-topic-42 key=agent:main:telegram:group:-100123:topic:42 reason=no_predecessor",
        "[agenr] session-start recall: 0 durable entries for session=session-topic-42 key=agent:main:telegram:group:-100123:topic:42 (core_candidates=0 artifact_candidates=0)",
        "[agenr] session-start recall: nothing to inject for session=session-topic-42 key=agent:main:telegram:group:-100123:topic:42",
      ]),
    );
  });

  it("injects only predecessor continuity when no core entries exist", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    const currentSessionId = "session-tui-continuity";
    const currentSessionKey = "agent:main:tui-523e4567-e89b-12d3-a456-426614174000";

    const predecessorFile = await writeSessionFileToDirectory(sessionsDir, "predecessor-session", [
      {
        type: "session",
        id: "predecessor-session",
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:00:00.000Z",
        message: {
          role: "human",
          content: "Continuity summaries should survive session rollover even when brain recall is empty.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:01:00.000Z",
        message: {
          role: "assistant",
          content: "We will inject the continuity summary and the transcript tail without speculative database recall.",
        },
      },
    ]);
    await writeSessionsJson(sessionsDir, {
      "agent:main:main": {
        sessionId: "predecessor-session",
        sessionFile: "predecessor-session.jsonl",
        updatedAt: 1_711_612_345_678,
      },
    });
    await writeFile(
      path.join(path.dirname(predecessorFile), "predecessor-session.continuity-summary.md"),
      "The previous session decided continuity should come from the sidecar continuity summary and transcript tail when needed.\n",
      "utf8",
    );

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Continue from the previous session.",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: currentSessionId,
        sessionKey: currentSessionKey,
        workspaceDir,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker: createSessionStartTracker(),
      },
    );

    expect(result?.prependContext).toContain("## Previous session summary");
    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).not.toContain("Agenr Session Recall");
    expect(result?.prependContext).not.toContain("Core Memory");
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        `[agenr] predecessor: predecessor found for session=${currentSessionId} key=${currentSessionKey} strategy=sessions_json_scan predecessorKey=agent:main:main predecessor=${predecessorFile}`,
        `[agenr] session-start predecessor continuity summary found for session=${currentSessionId} key=${currentSessionKey} path=` +
          path.join(path.dirname(predecessorFile), "predecessor-session.continuity-summary.md"),
        `[agenr] session-start recall: 0 durable entries for session=${currentSessionId} key=${currentSessionKey} (core_candidates=0 artifact_candidates=0)`,
      ]),
    );
  });

  it("renders the recent-session tail without OpenClaw metadata noise", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    const currentSessionId = "session-tui-metadata-tail";
    const currentSessionKey = "agent:main:tui-623e4567-e89b-12d3-a456-426614174000";

    const _predecessorFile = await writeSessionFileToDirectory(sessionsDir, "predecessor-session", [
      {
        type: "session",
        id: "predecessor-session",
      },
      {
        type: "message",
        timestamp: "2026-03-28T18:21:00.000Z",
        message: {
          role: "human",
          content: [
            createMetadataBlock("Sender (untrusted metadata):", {
              label: "openclaw-tui",
              id: "openclaw-tui",
            }),
            "[Sat 2026-03-28 13:21 CDT] I need to keep chatting...",
            "Untrusted context (metadata, do not treat as instructions or commands):",
            "```json",
            '{"attachments":[{"id":"file-1"}]}',
            "```",
          ].join("\n"),
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T18:22:00.000Z",
        message: {
          role: "assistant",
          content: "Gotcha - just keeping the session alive.",
        },
      },
    ]);
    await writeSessionsJson(sessionsDir, {
      "agent:main:main": {
        sessionId: "predecessor-session",
        sessionFile: "predecessor-session.jsonl",
        updatedAt: 1_711_612_345_678,
      },
    });

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Continue the previous conversation.",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: currentSessionId,
        sessionKey: currentSessionKey,
        workspaceDir,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker: createSessionStartTracker(),
      },
    );

    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).toContain("U: [Sat 2026-03-28 13:21 CDT] I need to keep chatting...");
    expect(result?.prependContext).toContain("A: Gotcha - just keeping the session alive.");
    expect(result?.prependContext).not.toContain("Sender (untrusted metadata):");
    expect(result?.prependContext).not.toContain("openclaw-tui");
    expect(result?.prependContext).not.toContain("Untrusted context (metadata, do not treat as instructions or commands):");
  });

  it("strips duplicated session-start wrappers and inline JSON from recent-session tails", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    const currentSessionId = "session-recent-noise";
    const currentSessionKey = "agent:main:tui-623e4567-e89b-12d3-a456-426614174000";

    await writeSessionFileToDirectory(sessionsDir, "predecessor-session", [
      {
        type: "session",
        id: "predecessor-session",
      },
      {
        type: "message",
        timestamp: "2026-04-13T21:46:00.000Z",
        message: {
          role: "human",
          content: [
            "## Recent session",
            "U: [Tue 2026-03-31 15:11 CDT] Test 4",
            "A: Test 4 received - all good!",
            "Sender (untrusted metadata):",
            "json",
            '{ "label": "openclaw-tui", "id": "openclaw-tui", "name": "openclaw-tui" }',
            "[Mon 2026-04-13 16:46 CDT] hello",
          ].join("\n"),
        },
      },
      {
        type: "message",
        timestamp: "2026-04-13T21:46:01.000Z",
        message: {
          role: "assistant",
          content: "hey what do you want to tackle?",
        },
      },
    ]);
    await writeSessionsJson(sessionsDir, {
      "agent:main:main": {
        sessionId: "predecessor-session",
        sessionFile: "predecessor-session.jsonl",
        updatedAt: 1_712_045_561_000,
      },
    });

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Continue the previous conversation.",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: currentSessionId,
        sessionKey: currentSessionKey,
        workspaceDir,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker: createSessionStartTracker(),
      },
    );

    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).toContain("U: [Mon 2026-04-13 16:46 CDT] hello");
    expect(result?.prependContext).toContain("A: hey what do you want to tackle?");
    expect(result?.prependContext).not.toContain("U: [Tue 2026-03-31 15:11 CDT] Test 4");
    expect(result?.prependContext).not.toContain("Sender (untrusted metadata):");
    expect(result?.prependContext).not.toContain('"label": "openclaw-tui"');
    expect(result?.prependContext).not.toContain("openclaw-tui");
    expect(result?.prependContext).not.toContain("## Recent session U:");
  });

  it("allows Relevant Durable Memory to be disabled through plugin config", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    const recall = createObservedRecallPorts();
    await database.insertEntry(
      createEntry({
        type: "decision",
        subject: "master branch workflow",
        content: "Branch from local master, commit, then fast-forward merge back to master.",
        expiry: "core",
        importance: 10,
      }),
      createEmbedding(0, 1),
      "core-workflow",
    );
    await database.insertEntry(
      createEntry({
        type: "lesson",
        subject: "artifact memory should stay off",
        content: "This entry would normally appear under Relevant Durable Memory.",
        expiry: "permanent",
        importance: 8,
      }),
      createEmbedding(1, 1),
      "artifact-memory",
    );
    await writeSessionFileToDirectory(sessionsDir, "predecessor-session", [
      {
        type: "session",
        id: "predecessor-session",
      },
      {
        type: "message",
        timestamp: "2026-04-13T21:46:00.000Z",
        message: {
          role: "human",
          content: "hello",
        },
      },
      {
        type: "message",
        timestamp: "2026-04-13T21:46:01.000Z",
        message: {
          role: "assistant",
          content: "What should we work on next?",
        },
      },
    ]);
    await writeFile(
      path.join(sessionsDir, "predecessor-session.continuity-summary.md"),
      "We decided to disable artifact-grounded recall until the prompt gets less noisy.\n",
      "utf8",
    );
    await writeSessionsJson(sessionsDir, {
      "agent:main:main": {
        sessionId: "predecessor-session",
        sessionFile: "predecessor-session.jsonl",
        updatedAt: 1_712_045_561_000,
      },
    });

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Continue the previous conversation.",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: "session-disable-relevant-durable",
        sessionKey: "agent:main:main",
        workspaceDir,
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            available: true,
            recall,
            pluginConfig: {
              memoryPolicy: {
                sessionStart: {
                  relevantDurableMemory: false,
                },
              },
            },
          }),
        ),
        tracker: createSessionStartTracker(),
      },
    );

    expect(result?.prependContext).toContain("## Previous session summary");
    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).toContain("Core Memory");
    expect(result?.prependContext).toContain("master branch workflow");
    expect(result?.prependContext).not.toContain("Relevant Durable Memory");
    expect(result?.prependContext).not.toContain("This entry would normally appear under Relevant Durable Memory.");
    expect(recall.embed).not.toHaveBeenCalled();
    expect(recall.ftsSearch).not.toHaveBeenCalled();
    expect(recall.recordRecallEvents).not.toHaveBeenCalled();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([expect.stringContaining("Artifact-grounded durable recall disabled by session-start policy.")]),
    );
  });

  it("injects predecessor continuity from the TUI sessions.json scan", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();

    const predecessorFile = await writeSessionFileToDirectory(sessionsDir, "predecessor-session", [
      {
        type: "session",
        id: "predecessor-session",
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:00:00.000Z",
        message: {
          role: "human",
          content: "The default TUI session needs continuity when /new generates a fresh tui uuid.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:01:00.000Z",
        message: {
          role: "assistant",
          content: "We will scan sessions.json for the most recent same-agent TUI lane when reset hooks are unavailable.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:02:00.000Z",
        message: {
          role: "human",
          content: "The first new session should pay the LLM cost once and cache the continuity summary.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:03:00.000Z",
        message: {
          role: "assistant",
          content: "Then every future TUI session can reuse the sidecar file without regenerating it.",
        },
      },
    ]);
    await writeFile(
      path.join(sessionsDir, "sessions.json"),
      `${JSON.stringify(
        {
          "agent:main:main": {
            sessionId: "predecessor-session",
            sessionFile: "predecessor-session.jsonl",
            updatedAt: 1_711_612_345_678,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const continuitySummary =
      "The prior TUI session established read-time continuity summary caching for /new continuity and kept transcript-tail fallback intact.";
    const { runEmbeddedPiAgent: continuitySummaryRunner, runEmbeddedPiAgentSpy } = createContinuitySummaryRunner({
      response: continuitySummary,
    });
    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Continue the TUI session after /new.",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: "session-tui-new",
        sessionKey: "agent:main:tui-123e4567-e89b-12d3-a456-426614174000",
        workspaceDir,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database, { continuitySummaryRunImplementation: continuitySummaryRunner })),
        tracker: createSessionStartTracker(),
      },
    );

    const continuitySummaryPath = path.join(path.dirname(predecessorFile), "predecessor-session.continuity-summary.md");
    expect(result?.prependContext).toContain("## Previous session summary");
    expect(result?.prependContext).toContain(continuitySummary);
    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).toContain("U: The default TUI session needs continuity");
    await expect(readFile(continuitySummaryPath, "utf8")).resolves.toContain(continuitySummary);
    expect(runEmbeddedPiAgentSpy).toHaveBeenCalledTimes(1);
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] predecessor: predecessor resolution for session=session-tui-new key=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 strategy=sessions_json_scan sessionKey=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 kind=tui stableLane=tui",
        "[agenr] predecessor: predecessor found for session=session-tui-new key=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 strategy=sessions_json_scan predecessorKey=agent:main:main predecessor=" +
          predecessorFile,
        "[agenr] session-start predecessor continuity summary not found for session=session-tui-new key=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 predecessor=" +
          predecessorFile,
        "[agenr] session-start read-time continuity summary generation triggered for session=session-tui-new key=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 predecessor=" +
          predecessorFile +
          " reason=no_existing_continuity_summary",
        expect.stringContaining(
          "[agenr] session-start read-time continuity summary generation completed for session=session-tui-new key=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 predecessor=" +
            predecessorFile,
        ),
        "[agenr] session-start predecessor continuity summary found for session=session-tui-new key=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 path=" +
          continuitySummaryPath,
      ]),
    );
  });

  it("reuses an existing TUI predecessor continuity summary without regenerating it", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();

    const predecessorFile = await writeSessionFileToDirectory(sessionsDir, "predecessor-session", [
      {
        type: "session",
        id: "predecessor-session",
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:00:00.000Z",
        message: {
          role: "human",
          content: "The default TUI session needs continuity when /new generates a fresh tui uuid.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:01:00.000Z",
        message: {
          role: "assistant",
          content: "We will scan sessions.json for the most recent same-agent TUI lane when reset hooks are unavailable.",
        },
      },
    ]);
    await writeFile(
      path.join(path.dirname(predecessorFile), "predecessor-session.continuity-summary.md"),
      "The prior TUI session should be recovered from sessions.json when /new bypasses reset hooks.\n",
      "utf8",
    );
    await writeFile(
      path.join(sessionsDir, "sessions.json"),
      `${JSON.stringify(
        {
          "agent:main:main": {
            sessionId: "predecessor-session",
            sessionFile: "predecessor-session.jsonl",
            updatedAt: 1_711_612_345_678,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const { runEmbeddedPiAgent: continuitySummaryRunner, runEmbeddedPiAgentSpy } = createContinuitySummaryRunner({
      response: "This should not be generated because the continuity summary file already exists.",
    });

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Continue the TUI session after /new.",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: "session-tui-new",
        sessionKey: "agent:main:tui-123e4567-e89b-12d3-a456-426614174000",
        workspaceDir,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database, { continuitySummaryRunImplementation: continuitySummaryRunner })),
        tracker: createSessionStartTracker(),
      },
    );

    expect(result?.prependContext).toContain("## Previous session summary");
    expect(result?.prependContext).toContain("sessions.json");
    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).toContain("U: The default TUI session needs continuity");
    expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] predecessor: predecessor resolution for session=session-tui-new key=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 strategy=sessions_json_scan sessionKey=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 kind=tui stableLane=tui",
        "[agenr] predecessor: predecessor found for session=session-tui-new key=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 strategy=sessions_json_scan predecessorKey=agent:main:main predecessor=" +
          predecessorFile,
        "[agenr] session-start read-time continuity summary generation skipped for session=session-tui-new key=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 predecessor=" +
          predecessorFile +
          " reason=already_exists path=" +
          path.join(path.dirname(predecessorFile), "predecessor-session.continuity-summary.md"),
        "[agenr] session-start predecessor continuity summary found for session=session-tui-new key=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 path=" +
          path.join(path.dirname(predecessorFile), "predecessor-session.continuity-summary.md"),
      ]),
    );
  });

  it("uses the lightweight OpenClaw LLM client for both read-time continuity and background episode writes", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();

    const predecessorFile = await writeSessionFileToDirectory(sessionsDir, "predecessor-session", [
      {
        type: "session",
        id: "predecessor-session",
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:00:00.000Z",
        message: {
          role: "human",
          content: "The first new session should pay the LLM cost once and cache the continuity summary.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:01:00.000Z",
        message: {
          role: "assistant",
          content: "That same predecessor should also produce one episodic summary in the background.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:02:00.000Z",
        message: {
          role: "human",
          content: "Continuity should load inline while the episode write stays best effort.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:03:00.000Z",
        message: {
          role: "assistant",
          content: "Both summary paths are plain single-shot text completions.",
        },
      },
    ]);
    await writeSessionsJson(sessionsDir, {
      "agent:main:main": {
        sessionId: "predecessor-session",
        sessionFile: "predecessor-session.jsonl",
        updatedAt: 1_711_612_345_678,
      },
    });

    const continuitySummary = "The predecessor session established that continuity should be cached inline while episode summaries run in the background.";
    const { runEmbeddedPiAgent: continuitySummaryRunner, runEmbeddedPiAgentSpy } = createContinuitySummaryRunner({
      response: continuitySummary,
    });
    const { runEmbeddedPiAgent: episodeSummaryRunner, runEmbeddedPiAgentSpy: episodeSummaryRunnerSpy } = createEpisodeSummaryRunner({
      response: JSON.stringify({
        summary: "The predecessor session wrote one background episode summary through the lightweight OpenClaw client.",
        tags: ["agenr", "episode", "openclaw"],
        activityLevel: "substantial",
        project: "agenr",
      }),
    });
    const services = createServices(database, {
      continuitySummaryRunImplementation: continuitySummaryRunner,
      episodeSummaryRunImplementation: episodeSummaryRunner,
    });

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Continue the TUI session after /new.",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: "session-tui-both-paths",
        sessionKey: "agent:main:tui-b23e4567-e89b-12d3-a456-426614174000",
        workspaceDir,
      },
      {
        logger,
        servicesPromise: Promise.resolve(services),
        tracker: createSessionStartTracker(),
      },
    );

    expect(result?.prependContext).toContain("## Previous session summary");
    expect(result?.prependContext).toContain(continuitySummary);
    await vi.waitFor(async () => {
      const stored = await database.getEpisodeBySourceId("openclaw", "predecessor-session");
      expect(stored?.summary).toContain("lightweight OpenClaw client");
    });
    expect(runEmbeddedPiAgentSpy).toHaveBeenCalledTimes(1);
    expect(episodeSummaryRunnerSpy).toHaveBeenCalledTimes(1);
    expect(openClawLlmClientMocks.createOpenClawLlmClient.mock.calls).toEqual(
      expect.arrayContaining([
        [services.openClaw, "openai/gpt-5.4-mini", "continuity model override"],
        [services.openClaw, "openai/gpt-5.4-mini", "episode model override"],
      ]),
    );
    expect(services.openClaw.runtime.agent.runEmbeddedPiAgent).not.toHaveBeenCalled();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        `[agenr] session-start predecessor episode write triggered for session=session-tui-both-paths key=agent:main:tui-b23e4567-e89b-12d3-a456-426614174000 predecessor=${predecessorFile}`,
        expect.stringContaining(
          `[agenr] session-start predecessor episode write written for session=session-tui-both-paths key=agent:main:tui-b23e4567-e89b-12d3-a456-426614174000 predecessor=${predecessorFile} episode=`,
        ),
      ]),
    );
  });

  it("falls back to the transcript tail when read-time continuity summary generation fails", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    const currentSessionId = "session-tui-failure";
    const currentSessionKey = "agent:main:tui-723e4567-e89b-12d3-a456-426614174000";
    const predecessorFile = await writeSessionFileToDirectory(sessionsDir, "predecessor-session", [
      {
        type: "session",
        id: "predecessor-session",
      },
      {
        type: "message",
        timestamp: "2026-03-28T11:00:00.000Z",
        message: {
          role: "human",
          content: "The next session should continue even if the continuity summary LLM fails.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T11:01:00.000Z",
        message: {
          role: "assistant",
          content: "Then prompt build must fall back to the transcript tail only.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T11:02:00.000Z",
        message: {
          role: "human",
          content: "Keep session-start stable even if the continuity summary call errors.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T11:03:00.000Z",
        message: {
          role: "assistant",
          content: "Agreed. The continuity summary is optional and cached only on success.",
        },
      },
    ]);
    await writeSessionsJson(sessionsDir, {
      "agent:main:main": {
        sessionId: "predecessor-session",
        sessionFile: "predecessor-session.jsonl",
        updatedAt: 1_711_612_345_678,
      },
    });
    const continuitySummaryPath = path.join(path.dirname(predecessorFile), "predecessor-session.continuity-summary.md");
    const { runEmbeddedPiAgent: continuitySummaryRunner, runEmbeddedPiAgentSpy } = createContinuitySummaryRunner({
      implementation: async () => {
        throw new Error("continuity summary backend exploded");
      },
    });

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Continue even if the continuity summary backend is down.",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: currentSessionId,
        sessionKey: currentSessionKey,
        workspaceDir,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database, { continuitySummaryRunImplementation: continuitySummaryRunner })),
        tracker: createSessionStartTracker(),
      },
    );

    expect(result?.prependContext).not.toContain("## Previous session summary");
    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).toContain("U: The next session should continue even if the continuity summary LLM fails.");
    await expect(readFile(continuitySummaryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(runEmbeddedPiAgentSpy).toHaveBeenCalledTimes(1);
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        `[agenr] predecessor: predecessor found for session=${currentSessionId} key=${currentSessionKey} strategy=sessions_json_scan predecessorKey=agent:main:main predecessor=${predecessorFile}`,
        `[agenr] session-start read-time continuity summary generation triggered for session=${currentSessionId} key=${currentSessionKey} predecessor=` +
          predecessorFile +
          " reason=no_existing_continuity_summary",
        expect.stringContaining(
          `[agenr] session-start read-time continuity summary generation failed for session=${currentSessionId} key=${currentSessionKey} predecessor=` +
            predecessorFile +
            " reason=continuity summary backend exploded",
        ),
      ]),
    );
  });

  it("falls back to the transcript tail when read-time continuity summary generation times out", async () => {
    vi.useFakeTimers();

    const database = await createTestDatabase();
    const logger = createLogger();
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    const currentSessionId = "session-tui-timeout";
    const currentSessionKey = "agent:main:tui-823e4567-e89b-12d3-a456-426614174000";
    const predecessorFile = await writeSessionFileToDirectory(sessionsDir, "predecessor-session", [
      {
        type: "session",
        id: "predecessor-session",
      },
      {
        type: "message",
        timestamp: "2026-03-28T12:00:00.000Z",
        message: {
          role: "human",
          content: "The first TUI /new should not hang forever waiting for the continuity summary.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T12:01:00.000Z",
        message: {
          role: "assistant",
          content: "We will cap the wait so session start can proceed with the transcript tail.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T12:02:00.000Z",
        message: {
          role: "human",
          content: "Anything slower than that should be treated as a fallback-only start.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T12:03:00.000Z",
        message: {
          role: "assistant",
          content: "Right. The continuity summary can be retried or cached later, but prompt build must return.",
        },
      },
    ]);
    await writeSessionsJson(sessionsDir, {
      "agent:main:main": {
        sessionId: "predecessor-session",
        sessionFile: "predecessor-session.jsonl",
        updatedAt: 1_711_612_345_678,
      },
    });
    const continuitySummaryPath = path.join(path.dirname(predecessorFile), "predecessor-session.continuity-summary.md");
    let markContinuitySummaryStarted: (() => void) | undefined;
    const continuitySummaryStarted = new Promise<void>((resolve) => {
      markContinuitySummaryStarted = resolve;
    });
    const { runEmbeddedPiAgent: continuitySummaryRunner } = createContinuitySummaryRunner({
      implementation: async () => {
        markContinuitySummaryStarted?.();
        await new Promise((resolve) => {
          setTimeout(resolve, 60_000);
        });
        return "This continuity summary should arrive too late for prompt build.";
      },
    });

    const resultPromise = handleAgenrBeforePromptBuild(
      {
        prompt: "Continue without hanging on continuity summary generation.",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: currentSessionId,
        sessionKey: currentSessionKey,
        workspaceDir,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database, { continuitySummaryRunImplementation: continuitySummaryRunner })),
        tracker: createSessionStartTracker(),
      },
    );
    await continuitySummaryStarted;
    await vi.advanceTimersByTimeAsync(35_000);
    const result = await resultPromise;

    expect(result?.prependContext).not.toContain("## Previous session summary");
    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).toContain("U: The first TUI /new should not hang forever waiting for the continuity summary.");
    await expect(readFile(continuitySummaryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        `[agenr] predecessor: predecessor found for session=${currentSessionId} key=${currentSessionKey} strategy=sessions_json_scan predecessorKey=agent:main:main predecessor=${predecessorFile}`,
        `[agenr] session-start read-time continuity summary generation triggered for session=${currentSessionId} key=${currentSessionKey} predecessor=` +
          predecessorFile +
          " reason=no_existing_continuity_summary",
        `[agenr] session-start read-time continuity summary generation failed for session=${currentSessionId} key=${currentSessionKey} predecessor=` +
          predecessorFile +
          " reason=timeout elapsedMs=30000 model=openai/gpt-5.4-mini",
      ]),
    );
  });

  it("skips read-time continuity summary generation for short predecessor sessions", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    const currentSessionId = "session-tui-short-read-time";
    const currentSessionKey = "agent:main:tui-923e4567-e89b-12d3-a456-426614174000";
    const predecessorFile = await writeSessionFileToDirectory(sessionsDir, "predecessor-session", [
      {
        type: "session",
        id: "predecessor-session",
      },
      {
        type: "message",
        timestamp: "2026-03-28T13:00:00.000Z",
        message: {
          role: "human",
          content: "Short session.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T13:01:00.000Z",
        message: {
          role: "assistant",
          content: "Too short for a cached continuity summary.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T13:02:00.000Z",
        message: {
          role: "human",
          content: "Use the tail only.",
        },
      },
    ]);
    await writeSessionsJson(sessionsDir, {
      "agent:main:main": {
        sessionId: "predecessor-session",
        sessionFile: "predecessor-session.jsonl",
        updatedAt: 1_711_612_345_678,
      },
    });
    const continuitySummaryPath = path.join(path.dirname(predecessorFile), "predecessor-session.continuity-summary.md");
    const { runEmbeddedPiAgent: continuitySummaryRunner, runEmbeddedPiAgentSpy } = createContinuitySummaryRunner({
      response: "This should never be requested for short sessions.",
    });

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Continue from the short prior session.",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: currentSessionId,
        sessionKey: currentSessionKey,
        workspaceDir,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database, { continuitySummaryRunImplementation: continuitySummaryRunner })),
        tracker: createSessionStartTracker(),
      },
    );

    expect(result?.prependContext).not.toContain("## Previous session summary");
    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).toContain("U: Short session.");
    await expect(readFile(continuitySummaryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        `[agenr] predecessor: predecessor found for session=${currentSessionId} key=${currentSessionKey} strategy=sessions_json_scan predecessorKey=agent:main:main predecessor=${predecessorFile}`,
        `[agenr] session-start read-time continuity summary generation triggered for session=${currentSessionId} key=${currentSessionKey} predecessor=` +
          predecessorFile +
          " reason=no_existing_continuity_summary",
        `[agenr] session-start read-time continuity summary generation skipped for session=${currentSessionId} key=${currentSessionKey} predecessor=` +
          predecessorFile +
          " reason=too_short path=" +
          continuitySummaryPath,
      ]),
    );
  });

  it("returns prompt context even when the background predecessor episode write times out", async () => {
    vi.useFakeTimers();

    const database = await createTestDatabase();
    const logger = createLogger();
    const { workspaceDir, sessionsDir } = await createWorkspaceWithSessions();
    const currentSessionId = "session-tui-episode-timeout";
    const currentSessionKey = "agent:main:tui-a23e4567-e89b-12d3-a456-426614174000";
    await database.insertEntry(
      createEntry({
        type: "decision",
        subject: "background episode writing",
        content: "Episode writes must never block prompt construction.",
        expiry: "core",
        importance: 10,
      }),
      createEmbedding(0, 1),
      "background-episode-writing",
    );

    const predecessorFile = await writeSessionFileToDirectory(sessionsDir, "predecessor-session", [
      {
        type: "session",
        id: "predecessor-session",
      },
      {
        type: "message",
        timestamp: "2026-03-28T13:00:00.000Z",
        message: {
          role: "human",
          content: "We need background predecessor episode writes.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T13:01:00.000Z",
        message: {
          role: "assistant",
          content: "They should never block prompt build.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T13:02:00.000Z",
        message: {
          role: "human",
          content: "Continuity still needs to load normally.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T13:03:00.000Z",
        message: {
          role: "assistant",
          content: "Right. The episode write can time out independently.",
        },
      },
    ]);
    await writeSessionsJson(sessionsDir, {
      "agent:main:main": {
        sessionId: "predecessor-session",
        sessionFile: "predecessor-session.jsonl",
        updatedAt: 1_711_612_345_678,
      },
    });
    await writeFile(
      path.join(path.dirname(predecessorFile), "predecessor-session.continuity-summary.md"),
      "The previous session established that predecessor episode writes should run in the background.\n",
      "utf8",
    );

    let markEpisodeStarted: (() => void) | undefined;
    const episodeStarted = new Promise<void>((resolve) => {
      markEpisodeStarted = resolve;
    });
    const { runEmbeddedPiAgent: episodeSummaryRunner } = createEpisodeSummaryRunner({
      implementation: async () => {
        markEpisodeStarted?.();
        await new Promise((resolve) => {
          setTimeout(resolve, 60_000);
        });
        return JSON.stringify({
          summary: "Too late.",
          tags: ["late"],
          activityLevel: "minimal",
          project: "agenr",
        });
      },
    });

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Continue from the predecessor session.",
        messages: [],
      },
      {
        agentId: "main",
        sessionId: currentSessionId,
        sessionKey: currentSessionKey,
        workspaceDir,
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            episodeSummaryRunImplementation: episodeSummaryRunner,
          }),
        ),
        tracker: createSessionStartTracker(),
      },
    );

    expect(result?.prependContext).toContain("## Previous session summary");
    expect(result?.prependContext).toContain("predecessor episode writes should run in the background");
    expect(result?.prependContext).toContain("Agenr Session Recall");
    expect(result?.prependContext).toContain("background episode writing");

    await episodeStarted;
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.runAllTimersAsync();

    expect(await database.getEpisodeBySourceId("openclaw", "predecessor-session")).toBeNull();
    await vi.waitFor(() => {
      expect(getMessages(logger.info)).toEqual(
        expect.arrayContaining([
          `[agenr] session-start predecessor episode write triggered for session=${currentSessionId} key=${currentSessionKey} predecessor=${predecessorFile}`,
          `[agenr] session-start predecessor episode write timed_out for session=${currentSessionId} key=${currentSessionKey} predecessor=${predecessorFile} timeoutMs=45000`,
        ]),
      );
    });
  });

  it("logs when session-start recall has nothing to inject", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Anything to remember?",
        messages: [],
      },
      {
        sessionId: "session-empty",
        sessionKey: "agent:main:webchat:empty",
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker: createSessionStartTracker(),
      },
    );

    expect(result).toBeUndefined();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] session-start predecessor continuity summary not found for session=session-empty key=agent:main:webchat:empty reason=no_predecessor",
        "[agenr] session-start recall: 0 durable entries for session=session-empty key=agent:main:webchat:empty (core_candidates=0 artifact_candidates=0)",
        "[agenr] session-start recall: nothing to inject for session=session-empty key=agent:main:webchat:empty",
      ]),
    );
  });

  it("injects a memory-check nudge on non-first turns after the configured gap", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const tracker = createSessionStartTracker();
    const midSessionTracker = createMidSessionTracker();
    const sessionId = "session-store-nudge";
    const sessionKey = "agent:main:webchat:store-nudge";

    await handleAgenrBeforePromptBuild(
      {
        prompt: "Start the session.",
        messages: [],
      },
      {
        sessionId,
        sessionKey,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
        midSessionTracker,
        storeNudgeConfig: {
          enabled: true,
          threshold: 2,
          maxPerSession: 3,
        },
      },
    );

    const secondResult = await handleAgenrBeforePromptBuild(
      {
        prompt: "Continue the session.",
        messages: [],
      },
      {
        sessionId,
        sessionKey,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
        midSessionTracker,
        storeNudgeConfig: {
          enabled: true,
          threshold: 2,
          maxPerSession: 3,
        },
      },
    );

    const thirdResult = await handleAgenrBeforePromptBuild(
      {
        prompt: "Keep going.",
        messages: [],
      },
      {
        sessionId,
        sessionKey,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
        midSessionTracker,
        storeNudgeConfig: {
          enabled: true,
          threshold: 2,
          maxPerSession: 3,
        },
      },
    );

    expect(secondResult).toBeUndefined();
    expect(thirdResult?.prependContext).toContain("[MEMORY CHECK]");
    expect(thirdResult?.prependContext).toContain("You haven't stored anything this session.");
    expect(midSessionTracker.peek(sessionId, sessionKey)).toMatchObject({
      turnCount: 2,
      nudgeCount: 1,
      lastSuccessfulStoreTurn: 2,
    });
  });

  it("suppresses nudges after skipped memory work until the cooldown expires", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const tracker = createSessionStartTracker();
    const midSessionTracker = createMidSessionTracker();
    const sessionId = "session-store-skip";
    const sessionKey = "agent:main:webchat:store-skip";

    await handleAgenrBeforePromptBuild(
      {
        prompt: "Start the session.",
        messages: [],
      },
      {
        sessionId,
        sessionKey,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
        midSessionTracker,
        storeNudgeConfig: {
          enabled: true,
          threshold: 2,
          maxPerSession: 3,
        },
      },
    );

    await handleAgenrBeforePromptBuild(
      {
        prompt: "One follow-up.",
        messages: [],
      },
      {
        sessionId,
        sessionKey,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
        midSessionTracker,
        storeNudgeConfig: {
          enabled: true,
          threshold: 2,
          maxPerSession: 3,
        },
      },
    );

    handleAgenrAfterToolCall(
      {
        toolName: "agenr_store",
        params: {
          subject: "duplicate decision",
        },
        result: {
          status: "skipped",
        },
      },
      {
        sessionId,
        sessionKey,
      },
      {
        logger,
        midSessionTracker,
      },
    );

    const thirdResult = await handleAgenrBeforePromptBuild(
      {
        prompt: "Two follow-ups.",
        messages: [],
      },
      {
        sessionId,
        sessionKey,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
        midSessionTracker,
        storeNudgeConfig: {
          enabled: true,
          threshold: 2,
          maxPerSession: 3,
        },
      },
    );

    const fourthResult = await handleAgenrBeforePromptBuild(
      {
        prompt: "Three follow-ups.",
        messages: [],
      },
      {
        sessionId,
        sessionKey,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
        midSessionTracker,
        storeNudgeConfig: {
          enabled: true,
          threshold: 2,
          maxPerSession: 3,
        },
      },
    );

    expect(thirdResult).toBeUndefined();
    expect(fourthResult?.prependContext).toContain("[MEMORY CHECK]");
    expect(midSessionTracker.peek(sessionId, sessionKey)).toMatchObject({
      turnCount: 3,
      lastMemoryActionTurn: 1,
      nudgeCount: 1,
    });
  });

  it("skips store nudges for non-user triggers", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const tracker = createSessionStartTracker();
    const midSessionTracker = createMidSessionTracker();
    const sessionId = "session-store-trigger";
    const sessionKey = "agent:main:webchat:store-trigger";

    await handleAgenrBeforePromptBuild(
      {
        prompt: "Start the session.",
        messages: [],
      },
      {
        sessionId,
        sessionKey,
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
        midSessionTracker,
        storeNudgeConfig: {
          enabled: true,
          threshold: 1,
          maxPerSession: 3,
        },
      },
    );

    const heartbeatResult = await handleAgenrBeforePromptBuild(
      {
        prompt: "Internal memory maintenance.",
        messages: [],
      },
      {
        sessionId,
        sessionKey,
        trigger: "heartbeat",
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
        midSessionTracker,
        storeNudgeConfig: {
          enabled: true,
          threshold: 1,
          maxPerSession: 3,
        },
      },
    );

    expect(heartbeatResult).toBeUndefined();
    expect(midSessionTracker.peek(sessionId, sessionKey)).toBeUndefined();
    expect(getMessages(logger.debug)).toEqual(
      expect.arrayContaining([
        `[agenr] before_prompt_build: store nudge skipped for session=${sessionId} key=${sessionKey} reason=non_user_trigger trigger=heartbeat`,
      ]),
    );
  });
});

function createServices(
  database: SqlDatabase,
  options: {
    available?: boolean;
    recall?: RecallPorts;
    pluginConfig?: AgenrOpenClawServices["pluginConfig"];
    continuitySummaryRunImplementation?: LlmPort["complete"];
    episodeSummaryRunImplementation?: LlmPort["complete"];
  } = {},
): AgenrOpenClawServices {
  const available = options.available ?? false;
  const embedding: EmbeddingPort = {
    async embed(): Promise<number[][]> {
      throw new Error("Embeddings unavailable in this test.");
    },
  };
  const recall =
    options.recall ??
    ({
      async embed(): Promise<number[]> {
        throw new Error("Recall should not run when embeddings are unavailable.");
      },
      async vectorSearch() {
        return [];
      },
      async ftsSearch() {
        return [];
      },
      async hydrateEntries() {
        return [];
      },
      async recordRecallEvents() {
        return;
      },
    } satisfies RecallPorts);
  const openClaw = createOpenClawHost({
    continuitySummaryRunImplementation:
      options.continuitySummaryRunImplementation ??
      (async () => {
        throw new Error("Continuity summary client unavailable.");
      }),
    episodeSummaryRunImplementation:
      options.episodeSummaryRunImplementation ??
      (async () => {
        return JSON.stringify({
          summary:
            "The session focused on agenr episodic-memory work and agreed to write predecessor episodes in the background so prompt build stays fast. The discussion stayed grounded in OpenClaw integration details for temporal recall. The work was substantive and project-scoped.",
          tags: ["agenr", "openclaw", "episodic-memory"],
          activityLevel: "substantial",
          project: "agenr",
        });
      }),
  });
  openClawLlmClientMocks.createOpenClawLlmClient.mockImplementation(async (host: AgenrOpenClawHost, _modelRef?: string, label?: string): Promise<LlmPort> => {
    const testHost = host as TestOpenClawHost;
    if (label === "continuity model override") {
      return createLlmPort(testHost.__testLlm.continuitySummaryRunImplementation);
    }

    if (label === "episode model override") {
      return createLlmPort(testHost.__testLlm.episodeSummaryRunImplementation);
    }

    throw new Error(`Unexpected OpenClaw LLM client label: ${label ?? "missing"}`);
  });

  return {
    openClaw,
    config: {
      dbPath: "test.db",
    },
    pluginConfig: options.pluginConfig ?? {},
    agenrConfig: {},
    dbPath: "test.db",
    entries: database,
    episodes: database,
    procedures: database,
    memory: createOpenClawRepository(database),
    sessionStart: {
      repository: createSessionStartRepository(database),
      recall,
    },
    embedding,
    recall,
    embeddingStatus: {
      available,
      provider: available ? "openai" : "unconfigured",
      requestedProvider: "openai",
      model: "text-embedding-3-small",
      ...(available ? {} : { error: "Embedding API key is required." }),
    },
    async close() {
      await database.close();
    },
  };
}

type TestOpenClawHost = AgenrOpenClawHost & {
  __testLlm: {
    continuitySummaryRunImplementation: LlmPort["complete"];
    episodeSummaryRunImplementation: LlmPort["complete"];
  };
};

function createContinuitySummaryRunner(
  options: {
    implementation?: LlmPort["complete"];
    response?: string;
  } = {},
): {
  runEmbeddedPiAgent: LlmPort["complete"];
  runEmbeddedPiAgentSpy: ReturnType<typeof vi.fn>;
} {
  const runEmbeddedPiAgentSpy = vi.fn(
    options.implementation ??
      (async () => {
        return options.response ?? "";
      }),
  );

  return {
    runEmbeddedPiAgent: runEmbeddedPiAgentSpy as LlmPort["complete"],
    runEmbeddedPiAgentSpy,
  };
}

function createEpisodeSummaryRunner(
  options: {
    implementation?: LlmPort["complete"];
    response?: string;
  } = {},
): {
  runEmbeddedPiAgent: LlmPort["complete"];
  runEmbeddedPiAgentSpy: ReturnType<typeof vi.fn>;
} {
  const runEmbeddedPiAgentSpy = vi.fn(
    options.implementation ??
      (async () => {
        return (
          options.response ??
          JSON.stringify({
            summary:
              "The session focused on agenr episodic-memory work and agreed to write predecessor episodes in the background so prompt build stays fast. The discussion stayed grounded in OpenClaw integration details for temporal recall. The work was substantive and project-scoped.",
            tags: ["agenr", "openclaw", "episodic-memory"],
            activityLevel: "substantial",
            project: "agenr",
          })
        );
      }),
  );

  return {
    runEmbeddedPiAgent: runEmbeddedPiAgentSpy as LlmPort["complete"],
    runEmbeddedPiAgentSpy,
  };
}

function createOpenClawHost(options: {
  continuitySummaryRunImplementation: LlmPort["complete"];
  episodeSummaryRunImplementation: LlmPort["complete"];
}): TestOpenClawHost {
  const workspaceDir = path.join(os.tmpdir(), "agenr-openclaw-test-workspace");
  const agentDir = path.join(os.tmpdir(), "agenr-openclaw-test-agent");
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
        runEmbeddedPiAgent: vi.fn(async () => {
          throw new Error("Embedded agent runner should not be used in before-prompt-build tests.");
        }),
      },
      modelAuth: {
        resolveApiKeyForProvider: async () => ({
          apiKey: "openclaw-test-key",
          source: "profile:default",
          mode: "api-key",
        }),
      },
      state: {
        resolveStateDir: (env?: NodeJS.ProcessEnv) => resolveOpenClawStateDir(env),
      },
    },
    __testLlm: {
      continuitySummaryRunImplementation: options.continuitySummaryRunImplementation,
      episodeSummaryRunImplementation: options.episodeSummaryRunImplementation,
    },
  };
}

function createLlmPort(complete: LlmPort["complete"]): LlmPort {
  return {
    complete,
    completeJson: async <T>(systemPrompt: string, userMessage: string): Promise<T> => {
      return JSON.parse(await complete(systemPrompt, userMessage)) as T;
    },
  };
}

function createObservedRecallPorts() {
  return {
    embed: vi.fn(async (): Promise<number[]> => createEmbedding(0, 1)),
    vectorSearch: vi.fn(async () => []),
    ftsSearch: vi.fn(async () => []),
    hydrateEntries: vi.fn(async () => []),
    recordRecallEvents: vi.fn(async () => undefined),
  } satisfies RecallPorts;
}

function expectRecallPortsUnused(recall: ReturnType<typeof createObservedRecallPorts>): void {
  expect(recall.embed).not.toHaveBeenCalled();
  expect(recall.vectorSearch).not.toHaveBeenCalled();
  expect(recall.ftsSearch).not.toHaveBeenCalled();
  expect(recall.hydrateEntries).not.toHaveBeenCalled();
  expect(recall.recordRecallEvents).not.toHaveBeenCalled();
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

function listExecutedSql(executeCalls: unknown[][]): string[] {
  return executeCalls.flatMap(([statementOrSql]) => {
    if (typeof statementOrSql === "string") {
      return [statementOrSql];
    }

    if (hasSqlText(statementOrSql)) {
      return [statementOrSql.sql];
    }

    return [];
  });
}

function hasSqlText(value: unknown): value is { sql: string } {
  return typeof value === "object" && value !== null && "sql" in value && typeof value.sql === "string";
}

async function createTestDatabase(): Promise<SqlDatabase> {
  const databasePath = path.join(os.tmpdir(), `agenr-openclaw-${randomUUID()}.sqlite`);
  tempPaths.push(databasePath);

  const database = await createDatabase(databasePath);
  openDatabases.push(database);
  return database;
}

async function createWorkspaceWithSessions(): Promise<{ workspaceDir: string; sessionsDir: string }> {
  const sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "agenr-openclaw-sandbox-"));
  tempPaths.push(sandboxRoot);
  const workspaceDir = path.join(sandboxRoot, "workspace");
  const stateDir = path.join(sandboxRoot, ".openclaw");
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  delete process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_HOME = sandboxRoot;
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  return { workspaceDir, sessionsDir };
}

async function writeSessionsJson(sessionsDir: string, entries: Record<string, Record<string, unknown>>): Promise<void> {
  await writeFile(path.join(sessionsDir, "sessions.json"), `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

async function writeSessionFileToDirectory(directory: string, sessionId: string, lines: object[]): Promise<string> {
  const filePath = path.join(directory, `${sessionId}.jsonl`);
  await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return filePath;
}

async function writeArchivedSessionFileToDirectory(directory: string, sessionId: string, suffix: string, lines: object[]): Promise<string> {
  const filePath = path.join(directory, `${sessionId}.jsonl.${suffix}`);
  await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return filePath;
}

function createMetadataBlock(sentinel: string, payload: object): string {
  return [sentinel, "```json", JSON.stringify(payload), "```"].join("\n");
}

function createEntry(overrides: Partial<Entry> = {}): Entry {
  const now = new Date("2026-03-27T12:00:00.000Z").toISOString();
  return {
    id: overrides.id ?? randomUUID(),
    type: overrides.type ?? "fact",
    subject: overrides.subject ?? "test subject",
    content: overrides.content ?? "test content",
    importance: overrides.importance ?? 7,
    expiry: overrides.expiry ?? "permanent",
    tags: overrides.tags ?? [],
    source_file: overrides.source_file,
    source_context: overrides.source_context,
    embedding: overrides.embedding,
    content_hash: overrides.content_hash,
    norm_content_hash: overrides.norm_content_hash,
    quality_score: overrides.quality_score ?? 0.5,
    recall_count: overrides.recall_count ?? 0,
    last_recalled_at: overrides.last_recalled_at,
    superseded_by: overrides.superseded_by,
    cluster_id: overrides.cluster_id,
    retired: overrides.retired ?? false,
    retired_at: overrides.retired_at,
    retired_reason: overrides.retired_reason,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  };
}

function createEmbedding(index: number, value: number): number[] {
  const vector = Array.from({ length: 1024 }, () => 0);
  vector[index] = value;
  return vector;
}
