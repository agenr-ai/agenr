import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { handleAgenrBeforePromptBuild } from "../../../src/adapters/openclaw/hooks/before-prompt-build.js";
import { createSessionStartTracker } from "../../../src/adapters/openclaw/session/state.js";
import type { AgenrOpenClawServices, AgenrOpenClawSummaryClient } from "../../../src/adapters/openclaw/types.js";
import type { EmbeddingPort, RecallPorts } from "../../../src/core/ports.js";
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
        type: "event",
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
        "[agenr] session-start predecessor summary not found for session=session-1 key=agent:main:webchat:test reason=no_predecessor",
        "[agenr] session-start recall: 1 core entries for session=session-1 key=agent:main:webchat:test",
        "[agenr] session-start recall skipped (already ran) for session=session-1 key=agent:main:webchat:test",
      ]),
    );
    expect(getMessages(logger.debug)).toEqual(
      expect.arrayContaining([
        "[agenr] before_prompt_build: session tracker first start for session=session-1 key=agent:main:webchat:test",
        "[agenr] before_prompt_build: session tracker duplicate blocked for session=session-1 key=agent:main:webchat:test",
        expect.stringContaining(
          "[agenr] before_prompt_build: session-start core entries for session=session-1 key=agent:main:webchat:test: master branch workflow",
        ),
      ]),
    );
    expect(
      getMessages(logger.debug).some((message) => message.includes("session-start relevant entries") || message.includes("session-start recent entries")),
    ).toBe(false);
  });

  it("injects predecessor summary and transcript tail alongside core memory only", async () => {
    const database = await createTestDatabase();
    const executeSpy = vi.spyOn(database, "execute");
    const logger = createLogger();
    const recall = createObservedRecallPorts();
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
      type: "event",
      subject: "latest plugin work",
      content: "Structured OpenClaw logging is being wired into session-start recall.",
      expiry: "temporary",
      importance: 8,
    });

    await database.insertEntry(coreEntry, createEmbedding(0, 1), "core-workflow");
    await database.insertEntry(relevantEntry, createEmbedding(1, 1), "relevant-workflow");
    await database.insertEntry(recentEntry, createEmbedding(2, 1), "recent-workflow");

    const predecessorFile = await writeSessionFile("predecessor-session", [
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
          content: "Agreed. We will write a summary.md sidecar next to the session transcript.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:02:00.000Z",
        message: {
          role: "human",
          content: "Keep the transcript tail too so tone and last exchanges survive when the LLM summary is missing.",
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
    await writeFile(
      path.join(path.dirname(predecessorFile), "predecessor-session.summary.md"),
      "The session settled on file-based continuity. Summary files live next to transcript JSONL, transcript tails remain as fallback, and no handoff entries go into the brain.\n",
      "utf8",
    );

    const tracker = createSessionStartTracker();
    tracker.rememberReset("agent:main:webchat:isolated", {
      sessionId: "predecessor-session",
      sessionFile: predecessorFile,
      recordedAt: "2026-03-28T10:05:00.000Z",
    });
    tracker.rememberSessionStart("session-2", "agent:main:webchat:isolated", "predecessor-session");

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Verify each TUI session stays isolated and continuity is file-based.",
        messages: [],
      },
      {
        sessionId: "session-2",
        sessionKey: "agent:main:webchat:isolated",
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

    expect(result?.prependContext).toContain("## Previous session summary");
    expect(result?.prependContext).toContain("file-based continuity");
    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).toContain("U: Keep the transcript tail too");
    expect(result?.prependContext).toContain("Agenr Session Recall");
    expect(result?.prependContext).toContain("Core Memory");
    expect(result?.prependContext).toContain("session isolation rule");
    expect(result?.prependContext).not.toContain("multi-session drift check");
    expect(result?.prependContext).not.toContain("latest plugin work");
    expect(result?.prependContext).not.toContain("Relevant Recall");
    expect(result?.prependContext).not.toContain("Recent Context");
    expect(result?.prependContext).not.toContain("Recent Handoffs");
    expectRecallPortsUnused(recall);
    expect(listExecutedSql(executeSpy.mock.calls).some((sql) => sql.includes("expiry != 'core'"))).toBe(false);
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] session-start predecessor summary found for session=session-2 key=agent:main:webchat:isolated path=" +
          path.join(path.dirname(predecessorFile), "predecessor-session.summary.md"),
        "[agenr] session-start recall: 1 core entries for session=session-2 key=agent:main:webchat:isolated",
      ]),
    );
  });

  it("injects only predecessor continuity when no core entries exist", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();

    const predecessorFile = await writeSessionFile("predecessor-session", [
      {
        type: "session",
        id: "predecessor-session",
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:00:00.000Z",
        message: {
          role: "human",
          content: "Summaries should survive session rollover even when brain recall is empty.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:01:00.000Z",
        message: {
          role: "assistant",
          content: "We will inject the summary and the transcript tail without speculative database recall.",
        },
      },
    ]);
    await writeFile(
      path.join(path.dirname(predecessorFile), "predecessor-session.summary.md"),
      "The previous session decided continuity should come from the sidecar summary and transcript tail when needed.\n",
      "utf8",
    );

    const tracker = createSessionStartTracker();
    tracker.rememberReset("agent:main:webchat:continuity", {
      sessionId: "predecessor-session",
      sessionFile: predecessorFile,
      recordedAt: "2026-03-28T10:05:00.000Z",
    });
    tracker.rememberSessionStart("session-3", "agent:main:webchat:continuity", "predecessor-session");

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Continue from the previous session.",
        messages: [],
      },
      {
        sessionId: "session-3",
        sessionKey: "agent:main:webchat:continuity",
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
      },
    );

    expect(result?.prependContext).toContain("## Previous session summary");
    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).not.toContain("Agenr Session Recall");
    expect(result?.prependContext).not.toContain("Core Memory");
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] session-start predecessor summary found for session=session-3 key=agent:main:webchat:continuity path=" +
          path.join(path.dirname(predecessorFile), "predecessor-session.summary.md"),
        "[agenr] session-start recall: 0 core entries for session=session-3 key=agent:main:webchat:continuity",
      ]),
    );
  });

  it("renders the recent-session tail without OpenClaw metadata noise", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();

    const predecessorFile = await writeSessionFile("predecessor-session", [
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

    const tracker = createSessionStartTracker();
    tracker.rememberReset("agent:main:webchat:metadata-tail", {
      sessionId: "predecessor-session",
      sessionFile: predecessorFile,
      recordedAt: "2026-03-28T18:23:00.000Z",
    });
    tracker.rememberSessionStart("session-4", "agent:main:webchat:metadata-tail", "predecessor-session");

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Continue the previous conversation.",
        messages: [],
      },
      {
        sessionId: "session-4",
        sessionKey: "agent:main:webchat:metadata-tail",
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
      },
    );

    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).toContain("U: [Sat 2026-03-28 13:21 CDT] I need to keep chatting...");
    expect(result?.prependContext).toContain("A: Gotcha - just keeping the session alive.");
    expect(result?.prependContext).not.toContain("Sender (untrusted metadata):");
    expect(result?.prependContext).not.toContain("openclaw-tui");
    expect(result?.prependContext).not.toContain("Untrusted context (metadata, do not treat as instructions or commands):");
  });

  it("injects predecessor continuity from the TUI sessions.json fallback", async () => {
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
          content: "We will scan sessions.json for the most recent same-agent TUI lane when no reset record exists.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:02:00.000Z",
        message: {
          role: "human",
          content: "The first new session should pay the LLM cost once and cache the summary.",
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

    const summary = "The prior TUI session established read-time summary caching for /new continuity and kept transcript-tail fallback intact.";
    const { client: summaryLlm, completeSpy } = createSummaryLlm({ response: summary });
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
        servicesPromise: Promise.resolve(createServices(database, { summaryLlm })),
        tracker: createSessionStartTracker(),
      },
    );

    const summaryPath = path.join(path.dirname(predecessorFile), "predecessor-session.summary.md");
    expect(result?.prependContext).toContain("## Previous session summary");
    expect(result?.prependContext).toContain(summary);
    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).toContain("U: The default TUI session needs continuity");
    await expect(readFile(summaryPath, "utf8")).resolves.toContain(summary);
    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] predecessor: TUI fallback activated for session=session-tui-new key=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 sessionKey=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 stableLane=tui",
        "[agenr] predecessor: TUI fallback predecessor found for session=session-tui-new key=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 predecessorKey=agent:main:main predecessor=" +
          predecessorFile,
        "[agenr] session-start predecessor summary not found for session=session-tui-new key=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 predecessor=" +
          predecessorFile,
        "[agenr] session-start read-time summary generation triggered for session=session-tui-new key=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 predecessor=" +
          predecessorFile +
          " reason=no_existing_summary",
        expect.stringContaining(
          "[agenr] session-start read-time summary generation completed for session=session-tui-new key=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 predecessor=" +
            predecessorFile,
        ),
        "[agenr] session-start predecessor summary found for session=session-tui-new key=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 path=" +
          summaryPath,
      ]),
    );
  });

  it("reuses an existing TUI fallback summary without regenerating it", async () => {
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
          content: "We will scan sessions.json for the most recent same-agent TUI lane when no reset record exists.",
        },
      },
    ]);
    await writeFile(
      path.join(path.dirname(predecessorFile), "predecessor-session.summary.md"),
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
    const { client: summaryLlm, completeSpy } = createSummaryLlm({
      response: "This should not be generated because the summary file already exists.",
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
        servicesPromise: Promise.resolve(createServices(database, { summaryLlm })),
        tracker: createSessionStartTracker(),
      },
    );

    expect(result?.prependContext).toContain("## Previous session summary");
    expect(result?.prependContext).toContain("sessions.json");
    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).toContain("U: The default TUI session needs continuity");
    expect(completeSpy).not.toHaveBeenCalled();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] predecessor: TUI fallback activated for session=session-tui-new key=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 sessionKey=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 stableLane=tui",
        "[agenr] predecessor: TUI fallback predecessor found for session=session-tui-new key=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 predecessorKey=agent:main:main predecessor=" +
          predecessorFile,
        "[agenr] session-start read-time summary generation skipped for session=session-tui-new key=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 predecessor=" +
          predecessorFile +
          " reason=already_exists path=" +
          path.join(path.dirname(predecessorFile), "predecessor-session.summary.md"),
        "[agenr] session-start predecessor summary found for session=session-tui-new key=agent:main:tui-123e4567-e89b-12d3-a456-426614174000 path=" +
          path.join(path.dirname(predecessorFile), "predecessor-session.summary.md"),
      ]),
    );
  });

  it("falls back to the transcript tail when read-time summary generation fails", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const predecessorFile = await writeSessionFile("predecessor-session", [
      {
        type: "session",
        id: "predecessor-session",
      },
      {
        type: "message",
        timestamp: "2026-03-28T11:00:00.000Z",
        message: {
          role: "human",
          content: "The next session should continue even if the summary LLM fails.",
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
          content: "Keep session-start stable even if the summary call errors.",
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
    const summaryPath = path.join(path.dirname(predecessorFile), "predecessor-session.summary.md");
    const tracker = createSessionStartTracker();
    tracker.rememberReset("agent:main:webchat:failure", {
      sessionId: "predecessor-session",
      sessionFile: predecessorFile,
      recordedAt: "2026-03-28T11:04:00.000Z",
    });
    tracker.rememberSessionStart("session-5", "agent:main:webchat:failure", "predecessor-session");
    const { client: summaryLlm, completeSpy } = createSummaryLlm({
      implementation: async () => {
        throw new Error("summary backend exploded");
      },
    });

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Continue even if the summary backend is down.",
        messages: [],
      },
      {
        sessionId: "session-5",
        sessionKey: "agent:main:webchat:failure",
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database, { summaryLlm })),
        tracker,
      },
    );

    expect(result?.prependContext).not.toContain("## Previous session summary");
    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).toContain("U: The next session should continue even if the summary LLM fails.");
    await expect(readFile(summaryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] session-start read-time summary generation triggered for session=session-5 key=agent:main:webchat:failure predecessor=" +
          predecessorFile +
          " reason=no_existing_summary",
        expect.stringContaining(
          "[agenr] session-start read-time summary generation failed for session=session-5 key=agent:main:webchat:failure predecessor=" +
            predecessorFile +
            " reason=summary backend exploded",
        ),
      ]),
    );
  });

  it("falls back to the transcript tail when read-time summary generation times out", async () => {
    vi.useFakeTimers();

    const database = await createTestDatabase();
    const logger = createLogger();
    const predecessorFile = await writeSessionFile("predecessor-session", [
      {
        type: "session",
        id: "predecessor-session",
      },
      {
        type: "message",
        timestamp: "2026-03-28T12:00:00.000Z",
        message: {
          role: "human",
          content: "The first TUI /new should not hang forever waiting for the summary.",
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
          content: "Right. The summary can be retried or cached later, but prompt build must return.",
        },
      },
    ]);
    const summaryPath = path.join(path.dirname(predecessorFile), "predecessor-session.summary.md");
    const tracker = createSessionStartTracker();
    tracker.rememberReset("agent:main:webchat:timeout", {
      sessionId: "predecessor-session",
      sessionFile: predecessorFile,
      recordedAt: "2026-03-28T12:04:00.000Z",
    });
    tracker.rememberSessionStart("session-6", "agent:main:webchat:timeout", "predecessor-session");
    let markSummaryStarted: (() => void) | undefined;
    const summaryStarted = new Promise<void>((resolve) => {
      markSummaryStarted = resolve;
    });
    const { client: summaryLlm } = createSummaryLlm({
      implementation: async () => {
        markSummaryStarted?.();
        await new Promise((resolve) => {
          setTimeout(resolve, 60_000);
        });
        return "This summary should arrive too late for prompt build.";
      },
    });

    const resultPromise = handleAgenrBeforePromptBuild(
      {
        prompt: "Continue without hanging on summary generation.",
        messages: [],
      },
      {
        sessionId: "session-6",
        sessionKey: "agent:main:webchat:timeout",
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database, { summaryLlm })),
        tracker,
      },
    );
    await summaryStarted;
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await resultPromise;

    expect(result?.prependContext).not.toContain("## Previous session summary");
    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).toContain("U: The first TUI /new should not hang forever waiting for the summary.");
    await expect(readFile(summaryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] session-start read-time summary generation triggered for session=session-6 key=agent:main:webchat:timeout predecessor=" +
          predecessorFile +
          " reason=no_existing_summary",
        "[agenr] session-start read-time summary generation failed for session=session-6 key=agent:main:webchat:timeout predecessor=" +
          predecessorFile +
          " reason=timeout elapsedMs=10000",
      ]),
    );
  });

  it("skips read-time summary generation for short predecessor sessions", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const predecessorFile = await writeSessionFile("predecessor-session", [
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
          content: "Too short for a cached summary.",
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
    const summaryPath = path.join(path.dirname(predecessorFile), "predecessor-session.summary.md");
    const tracker = createSessionStartTracker();
    tracker.rememberReset("agent:main:webchat:short-read-time", {
      sessionId: "predecessor-session",
      sessionFile: predecessorFile,
      recordedAt: "2026-03-28T13:03:00.000Z",
    });
    tracker.rememberSessionStart("session-7", "agent:main:webchat:short-read-time", "predecessor-session");
    const { client: summaryLlm, completeSpy } = createSummaryLlm({
      response: "This should never be requested for short sessions.",
    });

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Continue from the short prior session.",
        messages: [],
      },
      {
        sessionId: "session-7",
        sessionKey: "agent:main:webchat:short-read-time",
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database, { summaryLlm })),
        tracker,
      },
    );

    expect(result?.prependContext).not.toContain("## Previous session summary");
    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).toContain("U: Short session.");
    await expect(readFile(summaryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(completeSpy).not.toHaveBeenCalled();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] session-start read-time summary generation triggered for session=session-7 key=agent:main:webchat:short-read-time predecessor=" +
          predecessorFile +
          " reason=no_existing_summary",
        "[agenr] session-start read-time summary generation skipped for session=session-7 key=agent:main:webchat:short-read-time predecessor=" +
          predecessorFile +
          " reason=too_short path=" +
          summaryPath,
      ]),
    );
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
        "[agenr] session-start predecessor summary not found for session=session-empty key=agent:main:webchat:empty reason=no_predecessor",
        "[agenr] session-start recall: 0 core entries for session=session-empty key=agent:main:webchat:empty",
        "[agenr] session-start recall: nothing to inject for session=session-empty key=agent:main:webchat:empty",
      ]),
    );
  });
});

function createServices(
  database: SqlDatabase,
  options: {
    available?: boolean;
    recall?: RecallPorts;
    summaryLlm?: AgenrOpenClawSummaryClient;
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

  return {
    config: {
      dbPath: "test.db",
    },
    agenrConfig: {},
    dbPath: "test.db",
    database,
    embedding,
    recall,
    embeddingStatus: {
      available,
      provider: available ? "openai" : "unconfigured",
      requestedProvider: "openai",
      model: "text-embedding-3-small",
      ...(available ? {} : { error: "Embedding API key is required." }),
    },
    summaryStatus: {
      available: Boolean(options.summaryLlm),
      provider: "openai",
      model: "gpt-5.4-mini",
      ...(options.summaryLlm ? {} : { error: "Summary LLM unavailable." }),
    },
    ...(options.summaryLlm ? { summaryLlm: options.summaryLlm } : {}),
    async close() {
      await database.close();
    },
  };
}

function createSummaryLlm(
  options: {
    response?: string;
    implementation?: (systemPrompt: string, prompt: string) => Promise<string>;
  } = {},
): {
  client: AgenrOpenClawSummaryClient;
  completeSpy: ReturnType<typeof vi.fn>;
} {
  const completeSpy = vi.fn(
    options.implementation ??
      (async (): Promise<string> => {
        return options.response ?? "";
      }),
  );

  return {
    client: {
      metadata: {
        model: {
          id: "gpt-5.4-mini",
        } as AgenrOpenClawSummaryClient["metadata"]["model"],
        contextWindowTokens: 200_000,
        maxOutputTokens: 8_000,
        supportsReasoning: true,
        usage: {
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          totalCost: 0,
        },
      },
      complete: completeSpy,
      async completeJson<T>(): Promise<T> {
        throw new Error("completeJson is unused in this test.");
      },
    },
    completeSpy,
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

async function writeSessionFile(sessionId: string, lines: object[]): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agenr-openclaw-session-"));
  tempPaths.push(directory);
  return writeSessionFileToDirectory(directory, sessionId, lines);
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

async function writeSessionFileToDirectory(directory: string, sessionId: string, lines: object[]): Promise<string> {
  const filePath = path.join(directory, `${sessionId}.jsonl`);
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
