import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const openClawLlmClientMocks = vi.hoisted(() => ({
  createOpenClawLlmClient: vi.fn(),
}));

vi.mock("../../../../src/adapters/openclaw/llm/openclaw-llm-client.js", () => ({
  createOpenClawLlmClient: openClawLlmClientMocks.createOpenClawLlmClient,
}));

import { createDatabase, type SqlDatabase } from "../../../../src/adapters/db/client.js";
import { createDreamPort } from "../../../../src/adapters/db/dreaming-port.js";
import { createMemoryRepository } from "../../../../src/adapters/db/memory-repository.js";
import { createSessionStartRepository } from "../../../../src/adapters/db/session-start-repository.js";
import { writeOpenClawSessionEndEpisode } from "../../../../src/adapters/openclaw/episode/episode-writer.js";
import { createNoopAgenrDebugSink } from "../../../../src/adapters/openclaw/debug/index.js";
import { createStubAgenrHostMemorySurface } from "../../../helpers/host-memory-stubs.js";
import type { AgenrOpenClawHost, AgenrOpenClawServices } from "../../../../src/adapters/openclaw/types.js";
import type { EmbeddingPort, LlmPort, RecallPorts } from "../../../../src/core/ports.js";

describe("writeOpenClawSessionEndEpisode", () => {
  const databases: SqlDatabase[] = [];
  const tempPaths: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    openClawLlmClientMocks.createOpenClawLlmClient.mockReset();

    while (databases.length > 0) {
      await databases.pop()?.close();
    }

    while (tempPaths.length > 0) {
      await rm(tempPaths.pop() ?? "", { force: true, recursive: true });
    }
  });

  it("writes the current session episode at session end when phase 4 thresholds pass", async () => {
    const database = await createTestDatabase(databases, tempPaths);
    const sessionFile = await writeStandardSession(tempPaths, "current-session-end");
    const logger = createLogger();
    const episodeRunner = createRunner({
      text: JSON.stringify({
        summary: "We wrote the current session episode at session end so dreaming has fresh evidence before the next session starts.",
        tags: ["session-end", "episodic-memory"],
        activityLevel: "substantial",
        project: "agenr",
      }),
    });

    await writeOpenClawSessionEndEpisode({
      ctx: {
        agentId: "main",
        sessionId: "current-session-end",
        sessionKey: "agent:main:tui-current",
      },
      target: {
        sessionId: "current-session-end",
        sessionFile,
      },
      services: createServices(database, episodeRunner),
      logger,
    });

    const stored = await database.getEpisodeBySourceId("openclaw", "current-session-end");
    expect(stored).not.toBeNull();
    expect(stored?.sourceRef).toBe(sessionFile);
    expect(stored?.surface).toBe("tui");
    expect(episodeRunner).toHaveBeenCalledTimes(1);
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([`[agenr] session-end episode write triggered for session=current-session-end key=agent:main:tui-current file=${sessionFile}`]),
    );
  });

  it("skips short sessions below the shared phase 4 thresholds", async () => {
    const database = await createTestDatabase(databases, tempPaths);
    const sessionFile = await writeShortSession(tempPaths, "short-session-end");
    const logger = createLogger();
    const episodeRunner = createRunner({
      text: JSON.stringify({
        summary: "Should not be written.",
        tags: ["session-end"],
        activityLevel: "light",
      }),
    });

    await writeOpenClawSessionEndEpisode({
      ctx: {
        agentId: "main",
        sessionId: "short-session-end",
      },
      target: {
        sessionId: "short-session-end",
        sessionFile,
      },
      services: createServices(database, episodeRunner),
      logger,
    });

    expect(await database.getEpisodeBySourceId("openclaw", "short-session-end")).toBeNull();
    expect(episodeRunner).not.toHaveBeenCalled();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([expect.stringContaining("[agenr] session-end episode write skipped for session=short-session-end")]),
    );
  });
});

function createServices(
  database: SqlDatabase,
  llmComplete: LlmPort["complete"],
  options: {
    embeddingAvailable?: boolean;
    embeddingImplementation?: EmbeddingPort["embed"];
    pluginConfig?: AgenrOpenClawServices["pluginConfig"];
    runEmbeddedPiAgent?: AgenrOpenClawHost["runtime"]["agent"]["runEmbeddedPiAgent"];
  } = {},
): AgenrOpenClawServices {
  const openClaw = createOpenClawHost(
    options.runEmbeddedPiAgent ??
      (vi.fn(async () => {
        throw new Error("Embedded agent runner should not be used in episode writer tests.");
      }) as unknown as AgenrOpenClawHost["runtime"]["agent"]["runEmbeddedPiAgent"]),
  );
  openClawLlmClientMocks.createOpenClawLlmClient.mockResolvedValue(createLlmPort(llmComplete));

  const embedding: EmbeddingPort = {
    async embed(texts): Promise<number[][]> {
      if (options.embeddingImplementation) {
        return await options.embeddingImplementation(texts);
      }

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
    async hydrateDurables() {
      return [];
    },
    async recordRecallEvents() {
      return;
    },
  };

  return {
    openClaw,
    config: {
      dbPath: "test.db",
      configPath: "test-config.json",
    },
    pluginConfig: options.pluginConfig ?? {},
    agenrConfig: {},
    durables: database,
    episodes: database,
    procedures: database,
    memory: createMemoryRepository(database),
    dreaming: createDreamPort(database),
    sessionStart: {
      repository: createSessionStartRepository(database),
      recall,
    },
    beforeTurn: {
      recall,
      procedures: database,
      ...(options.embeddingAvailable === true
        ? {
            embedQuery: async (text: string) => {
              const vectors = await embedding.embed([text]);
              return vectors[0] ?? [];
            },
          }
        : {}),
    },
    embedding,
    recall,
    embeddingStatus: {
      available: options.embeddingAvailable === true,
      provider: options.embeddingAvailable === true ? "openai" : "unconfigured",
      requestedProvider: "openai",
      model: "text-embedding-3-small",
      ...(options.embeddingAvailable === true ? {} : { error: "Embedding API key is required." }),
    },
    debugSink: createNoopAgenrDebugSink(),
    ...createStubAgenrHostMemorySurface(),
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

function createRunner(options: { implementation?: LlmPort["complete"]; text?: string }) {
  return vi.fn(
    options.implementation ??
      (async () => {
        return options.text ?? "";
      }),
  ) as unknown as ReturnType<typeof vi.fn> & LlmPort["complete"];
}

function createLlmPort(complete: LlmPort["complete"]): LlmPort {
  return {
    complete,
    completeJson: async <T>(systemPrompt: string, userMessage: string): Promise<T> => {
      return JSON.parse(await complete(systemPrompt, userMessage)) as T;
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

async function createTestDatabase(databases: SqlDatabase[], tempPaths: string[]): Promise<SqlDatabase> {
  const databasePath = path.join(os.tmpdir(), `agenr-openclaw-episode-${randomUUID()}.sqlite`);
  tempPaths.push(databasePath);

  const database = await createDatabase(databasePath);
  databases.push(database);
  return database;
}

async function writeShortSession(tempPaths: string[], sessionId: string): Promise<string> {
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
        content: "Short session.",
      },
    },
    {
      type: "message",
      timestamp: "2026-03-28T10:01:00.000Z",
      message: {
        role: "assistant",
        content: "Acknowledged.",
      },
    },
  ]);
}

async function writeStandardSession(tempPaths: string[], sessionId: string): Promise<string> {
  const lines: object[] = [
    {
      type: "session",
      id: sessionId,
    },
  ];

  for (let index = 0; index < 8; index += 1) {
    const timestamp = index === 7 ? "2026-03-28T10:20:00.000Z" : "2026-03-28T10:00:00.000Z";
    lines.push(
      {
        type: "message",
        timestamp,
        message: {
          role: "human",
          content: `User turn ${index + 1}`,
        },
      },
      {
        type: "message",
        timestamp,
        message: {
          role: "assistant",
          content: `Assistant turn ${index + 1}`,
        },
      },
    );
  }

  return writeSessionFile(tempPaths, sessionId, lines);
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
