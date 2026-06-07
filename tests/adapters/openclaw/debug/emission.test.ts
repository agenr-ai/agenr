import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../../src/adapters/db/client.js";
import { createDreamPort } from "../../../../src/adapters/db/dreaming-port.js";
import { createMemoryRepository } from "../../../../src/adapters/db/memory-repository.js";
import { createSessionStartRepository } from "../../../../src/adapters/db/session-start-repository.js";
import { createAgenrDebugSink } from "../../../../src/adapters/openclaw/debug/index.js";
import { handleAgenrBeforePromptBuild } from "../../../../src/adapters/openclaw/hooks/before-prompt-build.js";
import { createSessionStartTracker } from "../../../../src/app/plugin-runtime/session-tracking.js";
import { createAgenrRecallTool } from "../../../../src/adapters/openclaw/tools.js";
import type { AgenrOpenClawHost, AgenrOpenClawServices } from "../../../../src/adapters/openclaw/types.js";
import type { EmbeddingPort, RecallPorts } from "../../../../src/core/ports.js";
import { closeTestDatabases, removeTestPath } from "../../../helpers/temp-paths.js";
import { createStubAgenrHostMemorySurface } from "../../../helpers/host-memory-stubs.js";

const openClawSessionId = "emission-session-1";
const openClawSessionKey = "agent:main:tui:debug-sink";

describe("agenr debug sink event emission", () => {
  let tempRoot: string;
  const databases: SqlDatabase[] = [];

  beforeEach(async () => {
    const fs = await import("node:fs/promises");
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-emission-"));
  });

  afterEach(async () => {
    await closeTestDatabases(databases);
    await removeTestPath(tempRoot);
  });

  it("emits tool_call, tool_result, and unified_recall events for agenr_recall", async () => {
    const database = await createDatabase(":memory:");
    databases.push(database);
    const logPath = path.join(tempRoot, "recall-emit.jsonl");
    const sink = createAgenrDebugSink({
      enabled: true,
      logPath,
      eventLevel: "detailed",
      perSessionFiles: false,
      maxTopCandidates: 5,
    });
    const services = createTestServices(database, {
      recall: createEmptyRecallPorts(),
      debugSink: sink,
    });
    const tool = createAgenrRecallTool(
      {
        sessionId: openClawSessionId,
        sessionKey: openClawSessionKey,
        agentId: "main",
      },
      Promise.resolve(services),
      createSilentLogger(),
    );

    const result = await tool.execute("tool-1", { query: "what are my preferences" });
    await sink.close();

    expect((result.details as { status?: unknown }).status).toBe("ok");
    const lines = (await readFile(logPath, "utf8")).trim().split("\n");
    const events = lines.map((line) => JSON.parse(line));
    const emittedTypes = events.map((event) => event.type);
    expect(emittedTypes).toEqual(["tool_call", "tool_result", "unified_recall"]);
    expect(events[0]).toMatchObject({
      type: "tool_call",
      tool: "agenr_recall",
      sessionId: openClawSessionId,
      sessionKey: openClawSessionKey,
    });
    expect(events[1]).toMatchObject({
      type: "tool_result",
      summary: { routing: { requested: "auto" } },
    });
    expect(events[2]).toMatchObject({
      type: "unified_recall",
      debug: { schemaVersion: "recall-debug-artifact.v1", request: { recallPath: "unified" } },
    });
  });

  it("emits session_start_recall events from session-start", async () => {
    const database = await createDatabase(":memory:");
    databases.push(database);
    const logPath = path.join(tempRoot, "session-start-emit.jsonl");
    const sink = createAgenrDebugSink({
      enabled: true,
      logPath,
      eventLevel: "detailed",
      perSessionFiles: false,
      maxTopCandidates: 3,
    });
    const services = createTestServices(database, {
      recall: createEmptyRecallPorts(),
      debugSink: sink,
    });

    await handleAgenrBeforePromptBuild(
      { prompt: "hello", messages: [] },
      {
        sessionId: openClawSessionId,
        sessionKey: openClawSessionKey,
      },
      {
        logger: createSilentLogger(),
        servicesPromise: Promise.resolve(services),
        tracker: createSessionStartTracker(),
      },
    );
    await sink.close();

    const lines = (await readFile(logPath, "utf8")).trim().split("\n");
    const events = lines.map((line) => JSON.parse(line));
    const emittedTypes = events.map((event) => event.type);
    expect(emittedTypes).toContain("session_start_recall");
    const recall = events.find((event) => event.type === "session_start_recall");
    expect(recall.debug).toMatchObject({
      durableMemoryCount: expect.any(Number),
      selectedEntryIds: expect.any(Array),
      notices: expect.any(Array),
    });
  });

  it("does not write any file when debug sink is disabled", async () => {
    const database = await createDatabase(":memory:");
    databases.push(database);
    const logPath = path.join(tempRoot, "disabled.jsonl");
    const sink = createAgenrDebugSink({
      enabled: false,
      logPath,
      eventLevel: "basic",
      perSessionFiles: false,
      maxTopCandidates: 3,
    });
    const services = createTestServices(database, {
      recall: createEmptyRecallPorts(),
      debugSink: sink,
    });
    const tool = createAgenrRecallTool(
      {
        sessionId: openClawSessionId,
        sessionKey: openClawSessionKey,
        agentId: "main",
      },
      Promise.resolve(services),
      createSilentLogger(),
    );

    await tool.execute("tool-2", { query: "still silent" });
    await sink.close();

    const fs = await import("node:fs/promises");
    await expect(fs.access(logPath)).rejects.toThrow();
  });
});

function createEmptyRecallPorts(): RecallPorts {
  return {
    async embed() {
      return [];
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
}

function createTestServices(
  database: SqlDatabase,
  options: {
    recall: RecallPorts;
    debugSink: AgenrOpenClawServices["debugSink"];
  },
): AgenrOpenClawServices {
  const embedding: EmbeddingPort = {
    async embed(): Promise<number[][]> {
      throw new Error("Embeddings unavailable in this test.");
    },
  };
  const openClaw: AgenrOpenClawHost = {
    config: {} as AgenrOpenClawHost["config"],
    runtime: {
      agent: {
        resolveAgentDir: () => path.join(os.tmpdir(), "agenr-emit-agent"),
        resolveAgentWorkspaceDir: () => path.join(os.tmpdir(), "agenr-emit-workspace"),
        runEmbeddedPiAgent: async () => {
          throw new Error("Embedded agent not available in this test.");
        },
      },
      modelAuth: {
        resolveApiKeyForProvider: async () => ({
          apiKey: undefined,
          source: "none",
          mode: "api-key",
        }),
      },
      state: {
        resolveStateDir: () => path.join(os.tmpdir(), "agenr-emit-state"),
      },
    },
  };

  return {
    openClaw,
    config: {
      dbPath: "test.db",
      configPath: "test-config.json",
    },
    pluginConfig: {},
    agenrConfig: {},
    entries: database,
    episodes: database,
    procedures: database,
    memory: createMemoryRepository(database),
    dreaming: createDreamPort(database),
    sessionStart: {
      repository: createSessionStartRepository(database),
      recall: options.recall,
    },
    beforeTurn: {
      recall: options.recall,
      procedures: database,
    },
    embedding,
    recall: options.recall,
    embeddingStatus: {
      available: false,
      provider: "unconfigured",
      requestedProvider: "openai",
      model: "text-embedding-3-small",
      error: "Embedding API key is required.",
    },
    debugSink: options.debugSink,
    ...createStubAgenrHostMemorySurface(),
    async close() {
      await database.close();
    },
  };
}

function createSilentLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
}
