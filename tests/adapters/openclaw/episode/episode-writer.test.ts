import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../../src/adapters/db/client.js";
import { writeOpenClawPredecessorEpisode } from "../../../../src/adapters/openclaw/episode/episode-writer.js";
import type { AgenrOpenClawHost, AgenrOpenClawServices } from "../../../../src/adapters/openclaw/types.js";
import type { EmbeddingPort, RecallPorts } from "../../../../src/core/ports.js";

describe("writeOpenClawPredecessorEpisode", () => {
  const databases: SqlDatabase[] = [];
  const tempPaths: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();

    while (databases.length > 0) {
      await databases.pop()?.close();
    }

    while (tempPaths.length > 0) {
      await rm(tempPaths.pop() ?? "", { force: true, recursive: true });
    }
  });

  it("writes a missing predecessor episode with parsed transcript metadata", async () => {
    const database = await createTestDatabase(databases, tempPaths);
    const sessionFile = await writeSessionFile(tempPaths, "predecessor-session", [
      {
        type: "session",
        id: "predecessor-session",
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:00:00.000Z",
        message: {
          role: "human",
          content: "We need temporal recall for prior sessions.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:01:00.000Z",
        message: {
          role: "assistant",
          content: "We should store episodes separately from semantic entries.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:02:00.000Z",
        message: {
          role: "human",
          content: "Let us wire the OpenClaw writer in the background.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:03:00.000Z",
        message: {
          role: "assistant",
          content: "Agreed. The predecessor episode can be generated without blocking prompt build.",
        },
      },
    ]);
    const logger = createLogger();
    const episodeRunner = createRunner({
      text: JSON.stringify({
        summary:
          "We designed episodic recall for prior sessions and agreed to keep episode storage separate from semantic entries. The session decided to write predecessor episodes in the background so prompt build stays fast. The work centered on OpenClaw integration for agenr.",
        tags: ["openclaw", "agenr", "episodic-memory"],
        activityLevel: "substantial",
        project: "agenr",
      }),
    });

    await writeOpenClawPredecessorEpisode({
      ctx: {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:tui-current",
      },
      predecessor: {
        sessionId: "predecessor-session",
        sessionFile,
      },
      services: createServices(database, episodeRunner),
      logger,
    });

    const stored = await database.getEpisodeBySourceId("openclaw", "predecessor-session");

    expect(stored).not.toBeNull();
    expect(stored?.sourceRef).toBe(sessionFile);
    expect(stored?.transcriptHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(stored?.startedAt).toBe("2026-03-28T10:00:00.000Z");
    expect(stored?.endedAt).toBe("2026-03-28T10:03:00.000Z");
    expect(stored?.messageCount).toBe(4);
    expect(stored?.genVersion).toBe("openclaw-episodic-summary-v1");
    expect(stored?.genModel).toBe("openai/gpt-5.4-mini");
    expect(stored?.tags).toEqual(["agenr", "episodic-memory", "openclaw"]);
    expect(episodeRunner).toHaveBeenCalledTimes(1);
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        `[agenr] session-start predecessor episode write triggered for session=current-session key=agent:main:tui-current predecessor=${sessionFile}`,
        expect.stringContaining(
          `[agenr] session-start predecessor episode write written for session=current-session key=agent:main:tui-current predecessor=${sessionFile} episode=`,
        ),
      ]),
    );
  });

  it("skips generation when the predecessor episode already exists", async () => {
    const database = await createTestDatabase(databases, tempPaths);
    const sessionFile = await writeSessionFile(tempPaths, "existing-session", [
      {
        type: "session",
        id: "existing-session",
      },
    ]);
    await database.upsertEpisode({
      source: "openclaw",
      sourceId: "existing-session",
      sourceRef: sessionFile,
      transcriptHash: "existing-hash",
      startedAt: "2026-03-28T10:00:00.000Z",
      endedAt: "2026-03-28T10:05:00.000Z",
      summary: "An existing episode row is already present.",
      tags: ["existing"],
      activityLevel: "minimal",
    });
    const logger = createLogger();
    const episodeRunner = createRunner({
      text: JSON.stringify({
        summary: "This should never run.",
        tags: ["nope"],
        activityLevel: "none",
        project: null,
      }),
    });

    await writeOpenClawPredecessorEpisode({
      ctx: {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:tui-current",
      },
      predecessor: {
        sessionId: "existing-session",
        sessionFile,
      },
      services: createServices(database, episodeRunner),
      logger,
    });

    expect(episodeRunner).not.toHaveBeenCalled();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          `[agenr] session-start predecessor episode write skipped for session=current-session key=agent:main:tui-current predecessor=${sessionFile} reason=already_exists`,
        ),
      ]),
    );
  });

  it("skips short predecessor transcripts without invoking the model", async () => {
    const database = await createTestDatabase(databases, tempPaths);
    const sessionFile = await writeSessionFile(tempPaths, "short-session", [
      {
        type: "session",
        id: "short-session",
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:00:00.000Z",
        message: {
          role: "human",
          content: "Short session.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:01:00.000Z",
        message: {
          role: "assistant",
          content: "Too short for an episode.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:02:00.000Z",
        message: {
          role: "human",
          content: "Skip it.",
        },
      },
    ]);
    const logger = createLogger();
    const episodeRunner = createRunner({
      text: JSON.stringify({
        summary: "This should never run.",
        tags: ["short"],
        activityLevel: "none",
        project: null,
      }),
    });

    await writeOpenClawPredecessorEpisode({
      ctx: {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:tui-current",
      },
      predecessor: {
        sessionId: "short-session",
        sessionFile,
      },
      services: createServices(database, episodeRunner),
      logger,
    });

    expect(await database.getEpisodeBySourceId("openclaw", "short-session")).toBeNull();
    expect(episodeRunner).not.toHaveBeenCalled();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        `[agenr] session-start predecessor episode write skipped for session=current-session key=agent:main:tui-current predecessor=${sessionFile} reason=too_short cleanedMessages=3`,
      ]),
    );
  });

  it("logs model failures and does not persist an episode", async () => {
    const database = await createTestDatabase(databases, tempPaths);
    const sessionFile = await writeStandardSession(tempPaths, "failure-session");
    const logger = createLogger();
    const episodeRunner = createRunner({
      implementation: async () => {
        throw new Error("episode backend exploded");
      },
    });

    await writeOpenClawPredecessorEpisode({
      ctx: {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:tui-current",
      },
      predecessor: {
        sessionId: "failure-session",
        sessionFile,
      },
      services: createServices(database, episodeRunner),
      logger,
    });

    expect(await database.getEpisodeBySourceId("openclaw", "failure-session")).toBeNull();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        `[agenr] session-start predecessor episode write failed for session=current-session key=agent:main:tui-current predecessor=${sessionFile} reason=episode backend exploded`,
      ]),
    );
  });

  it("logs timeouts and does not persist an episode", async () => {
    vi.useFakeTimers();

    const database = await createTestDatabase(databases, tempPaths);
    const sessionFile = await writeStandardSession(tempPaths, "timeout-session");
    const logger = createLogger();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const episodeRunner = createRunner({
      implementation: async () => {
        markStarted?.();
        await new Promise((resolve) => {
          setTimeout(resolve, 60_000);
        });
        return {
          payloads: [
            {
              text: JSON.stringify({
                summary: "Too late.",
                tags: ["late"],
                activityLevel: "minimal",
                project: null,
              }),
            },
          ],
        };
      },
    });

    const writePromise = writeOpenClawPredecessorEpisode({
      ctx: {
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:tui-current",
      },
      predecessor: {
        sessionId: "timeout-session",
        sessionFile,
      },
      services: createServices(database, episodeRunner),
      logger,
    });

    await started;
    await vi.advanceTimersByTimeAsync(20_000);
    await writePromise;

    expect(await database.getEpisodeBySourceId("openclaw", "timeout-session")).toBeNull();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        `[agenr] session-start predecessor episode write timed_out for session=current-session key=agent:main:tui-current predecessor=${sessionFile} timeoutMs=20000`,
      ]),
    );
  });
});

function createServices(database: SqlDatabase, runEmbeddedPiAgent: AgenrOpenClawHost["runtime"]["agent"]["runEmbeddedPiAgent"]): AgenrOpenClawServices {
  const embedding: EmbeddingPort = {
    async embed(): Promise<number[][]> {
      throw new Error("Embeddings unavailable in this test.");
    },
  };
  const recall: RecallPorts = {
    async embed(): Promise<number[]> {
      throw new Error("Recall should not run in episode writer tests.");
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
  };

  return {
    openClaw: createOpenClawHost(runEmbeddedPiAgent),
    config: {
      dbPath: "test.db",
    },
    agenrConfig: {},
    dbPath: "test.db",
    database,
    embedding,
    recall,
    embeddingStatus: {
      available: false,
      provider: "unconfigured",
      requestedProvider: "openai",
      model: "text-embedding-3-small",
      error: "Embedding API key is required.",
    },
    async close() {
      await database.close();
    },
  };
}

function createOpenClawHost(runEmbeddedPiAgent: AgenrOpenClawHost["runtime"]["agent"]["runEmbeddedPiAgent"]): AgenrOpenClawHost {
  const workspaceDir = path.join(os.tmpdir(), "agenr-openclaw-episode-test-workspace");
  const agentDir = path.join(os.tmpdir(), "agenr-openclaw-episode-test-agent");
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
        runEmbeddedPiAgent,
      },
      state: {
        resolveStateDir: () => path.join(os.tmpdir(), ".openclaw"),
      },
    },
  };
}

function createRunner(options: { implementation?: AgenrOpenClawHost["runtime"]["agent"]["runEmbeddedPiAgent"]; text?: string }) {
  return vi.fn(
    options.implementation ??
      (async () => {
        return {
          payloads: [{ text: options.text ?? "" }],
        };
      }),
  ) as unknown as ReturnType<typeof vi.fn> & AgenrOpenClawHost["runtime"]["agent"]["runEmbeddedPiAgent"];
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

async function createTestDatabase(databases: SqlDatabase[], tempPaths: string[]): Promise<SqlDatabase> {
  const databasePath = path.join(os.tmpdir(), `agenr-openclaw-episode-${randomUUID()}.sqlite`);
  tempPaths.push(databasePath);

  const database = await createDatabase(databasePath);
  databases.push(database);
  return database;
}

async function writeStandardSession(tempPaths: string[], sessionId: string): Promise<string> {
  return writeSessionFile(tempPaths, sessionId, [
    {
      type: "session",
      id: sessionId,
    },
    {
      type: "message",
      timestamp: "2026-03-28T10:00:00.000Z",
      message: {
        role: "human",
        content: "We need episodic recall for prior work.",
      },
    },
    {
      type: "message",
      timestamp: "2026-03-28T10:01:00.000Z",
      message: {
        role: "assistant",
        content: "A separate episodes table should handle temporal recall.",
      },
    },
    {
      type: "message",
      timestamp: "2026-03-28T10:02:00.000Z",
      message: {
        role: "human",
        content: "The OpenClaw hook should write episodes in the background.",
      },
    },
    {
      type: "message",
      timestamp: "2026-03-28T10:03:00.000Z",
      message: {
        role: "assistant",
        content: "Then prompt build can continue even when the summary call is slow.",
      },
    },
  ]);
}

async function writeSessionFile(tempPaths: string[], sessionId: string, lines: object[]): Promise<string> {
  const sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "agenr-openclaw-episode-session-"));
  tempPaths.push(sandboxRoot);
  const sessionsDir = path.join(sandboxRoot, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
  await writeFile(sessionFile, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return sessionFile;
}
