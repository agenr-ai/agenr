import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { findOpenClawEntryBySubject } from "../../../src/adapters/db/openclaw-plugin-queries.js";
import {
  createAgenrRecallTool,
  createAgenrRetireTool,
  createAgenrStoreTool,
  createAgenrTraceTool,
  createAgenrUpdateTool,
} from "../../../src/adapters/openclaw/tools.js";
import type { AgenrOpenClawServices } from "../../../src/adapters/openclaw/types.js";
import type { EmbeddingPort, RecallPorts } from "../../../src/core/ports.js";
import type { Entry } from "../../../src/core/types.js";

const openDatabases: SqlDatabase[] = [];
const tempDatabasePaths: string[] = [];

afterEach(async () => {
  while (openDatabases.length > 0) {
    await openDatabases.pop()?.close();
  }

  while (tempDatabasePaths.length > 0) {
    await rm(tempDatabasePaths.pop() ?? "", { force: true });
  }
});

describe("agenr OpenClaw tools", () => {
  it("stores, updates, traces, and retires entries", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const services = createDatabaseBackedServices(database);
    const storeTool = createAgenrStoreTool(createToolContext(), Promise.resolve(services), logger);
    const updateTool = createAgenrUpdateTool(createToolContext(), Promise.resolve(services), logger);
    const traceTool = createAgenrTraceTool(createToolContext(), Promise.resolve(services), logger);
    const retireTool = createAgenrRetireTool(createToolContext(), Promise.resolve(services), logger);

    const storeResult = await storeTool.execute("tool-1", {
      type: "decision",
      subject: "feature flag policy",
      content: "Gate risky rollout work behind a feature flag until verification is complete.",
      importance: 8,
      expiry: "permanent",
      tags: ["rollout", "policy"],
    });
    const storedEntry = await findOpenClawEntryBySubject(database, "feature flag policy");

    const updateResult = await updateTool.execute("tool-2", {
      id: storedEntry?.id,
      importance: 9,
      expiry: "core",
    });
    const traceResult = await traceTool.execute("tool-3", {
      id: storedEntry?.id,
    });
    const retireResult = await retireTool.execute("tool-4", {
      subject: "feature flag policy",
      reason: "Superseded by rollout checklist v2.",
    });

    expect(storeResult.details).toMatchObject({
      status: "stored",
      subject: "feature flag policy",
    });
    expect(updateResult.details).toMatchObject({
      status: "updated",
      importance: 9,
      expiry: "core",
    });
    expect(traceResult.content[0]?.type).toBe("text");
    expect(traceResult.content[0]?.text).toContain("Trace for");
    expect(retireResult.details).toMatchObject({
      status: "retired",
    });
    expect(storedEntry).not.toBeNull();
    expect(await database.getEntry(storedEntry?.id ?? "")).toBeNull();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        '[agenr] tool=agenr_store session=session-1 key=agent:main:webchat:test store 1 entry subject="feature flag policy" type=decision',
        expect.stringContaining("[agenr] tool=agenr_update session=session-1 key=agent:main:webchat:test target=id:"),
        expect.stringContaining("[agenr] tool=agenr_trace session=session-1 key=agent:main:webchat:test target=id:"),
        '[agenr] tool=agenr_retire session=session-1 key=agent:main:webchat:test target=subject:"feature flag policy"',
      ]),
    );
    const storeParamsMessage = getMessages(logger.info).find((message) => message.includes("tool=agenr_store") && message.includes("params="));
    expect(storeParamsMessage).toContain('"contentLength":77');
    expect(storeParamsMessage).not.toContain("Gate risky rollout work behind a feature flag until verification is complete.");
  });

  it("runs recall through the core pipeline using injected recall ports", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const entry = createEntry({
      subject: "session recall",
      content: "Prompt injection should surface relevant prior context.",
      type: "lesson",
      importance: 8,
      expiry: "permanent",
      tags: ["openclaw"],
    });
    let recordedRecallEvents = 0;
    const services = createServices(database, {
      available: true,
      recall: {
        async embed() {
          return createEmbedding(0, 1);
        },
        async vectorSearch() {
          return [];
        },
        async ftsSearch() {
          return [
            {
              entry: {
                id: entry.id,
                subject: entry.subject,
                content: entry.content,
                importance: entry.importance,
                expiry: entry.expiry,
                created_at: entry.created_at,
                embedding: createEmbedding(0, 1),
              },
              rank: 0,
              tier: "exact",
            },
          ];
        },
        async hydrateEntries(ids) {
          return ids.includes(entry.id) ? [entry] : [];
        },
        async recordRecallEvents() {
          recordedRecallEvents += 1;
        },
      },
    });
    const recallTool = createAgenrRecallTool(createToolContext(), Promise.resolve(services), logger);
    const query = "relevant prior context for the current session so the operator can verify recall isolation across multiple TUI sessions";

    const result = await recallTool.execute("tool-5", {
      query,
      limit: 3,
    });

    expect(result.details).toMatchObject({
      status: "ok",
      count: 1,
    });
    expect(result.content[0]?.text).toContain("session recall");
    expect(recordedRecallEvents).toBe(1);
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          `[agenr] tool=agenr_recall session=session-1 key=agent:main:webchat:test query=${JSON.stringify(truncateForLog(query, 80))} limit=3`,
        ),
        expect.stringContaining(
          '[agenr] tool=agenr_recall session=session-1 key=agent:main:webchat:test params={"query":"relevant prior context for the current session so the operator can verify recall isolation across multiple TUI sessions","limit":3}',
        ),
        '[agenr] tool=agenr_recall session=session-1 key=agent:main:webchat:test result: 1 entries [subjects: "session recall"]',
      ]),
    );
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("logs recall filters and truncates result subjects at info level", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const entries = [
      createEntry({ subject: "session handoff 2026-03-27", type: "decision", tags: ["openclaw", "debugging"] }),
      createEntry({ subject: "agenr logger format", type: "lesson", tags: ["openclaw", "debugging"] }),
      createEntry({ subject: "temporal recall filters", type: "decision", tags: ["openclaw", "debugging"] }),
      createEntry({ subject: "sandbox gateway restart", type: "lesson", tags: ["openclaw", "debugging"] }),
      createEntry({ subject: "prompt build diagnostics", type: "decision", tags: ["openclaw", "debugging"] }),
      createEntry({ subject: "openclaw plugin logger gap", type: "lesson", tags: ["openclaw", "debugging"] }),
    ];
    const services = createServices(database, {
      available: true,
      recall: createVectorRecallPorts(entries),
    });
    const recallTool = createAgenrRecallTool(createToolContext(), Promise.resolve(services), logger);

    const result = await recallTool.execute("tool-9", {
      query: "what was I working on",
      since: "14d",
      until: "3d",
      around: "21d",
      aroundRadius: 4,
      project: "sandbox",
      limit: 6,
      threshold: 0.25,
      types: ["decision", "lesson"],
      tags: ["openclaw", "debugging"],
    });

    expect(result.details).toMatchObject({
      status: "ok",
      count: 6,
    });
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          '[agenr] tool=agenr_recall session=session-1 key=agent:main:webchat:test query="what was I working on" since=14d until=3d around=21d radius=4 project="sandbox" limit=6 types=["decision","lesson"] tags=["openclaw","debugging"]',
        ),
        expect.stringContaining(
          '[agenr] tool=agenr_recall session=session-1 key=agent:main:webchat:test params={"query":"what was I working on","limit":6,"threshold":0.25,"types":["decision","lesson"],"tags":["openclaw","debugging"],"since":"14d","until":"3d","around":"21d","aroundRadius":4,"project":"sandbox"}',
        ),
        expect.stringContaining(
          '[agenr] tool=agenr_recall session=session-1 key=agent:main:webchat:test result: 6 entries [subjects: "session handoff 2026-03-27", "agenr logger format", "temporal recall filters", "sandbox gateway restart", "prompt build diagnostics", ... and 1 more]',
        ),
      ]),
    );
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("traces the most recent entry when last is true", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const services = createDatabaseBackedServices(database);
    const storeTool = createAgenrStoreTool(createToolContext(), Promise.resolve(services), logger);
    const traceTool = createAgenrTraceTool(createToolContext(), Promise.resolve(services), logger);

    await storeTool.execute("tool-6", {
      type: "fact",
      subject: "older memory",
      content: "This was stored first and should not be selected by last.",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await storeTool.execute("tool-7", {
      type: "decision",
      subject: "newest memory",
      content: "This was stored most recently and should be selected by last.",
    });

    const result = await traceTool.execute("tool-8", {
      last: true,
    });

    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("newest memory");
    expect(getMessages(logger.info)).toContain("[agenr] tool=agenr_trace session=session-1 key=agent:main:webchat:test target=last");
  });
});

function createDatabaseBackedServices(database: SqlDatabase): AgenrOpenClawServices {
  return createServices(database, {
    available: true,
    recall: {
      async embed() {
        return createEmbedding(0, 1);
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
    },
  });
}

function createServices(
  database: SqlDatabase,
  options: {
    available: boolean;
    recall: RecallPorts;
  },
): AgenrOpenClawServices {
  const embedding: EmbeddingPort = {
    async embed(texts) {
      return texts.map((text, index) => createEmbedding(index, text.length || 1));
    },
  };

  return {
    config: {
      dbPath: "test.db",
    },
    dbPath: "test.db",
    database,
    embedding,
    recall: options.recall,
    embeddingStatus: {
      available: options.available,
      provider: options.available ? "openai" : "unconfigured",
      requestedProvider: "openai",
      model: "text-embedding-3-small",
      ...(options.available ? {} : { error: "Embedding API key is required." }),
    },
    async close() {
      await database.close();
    },
  };
}

function createVectorRecallPorts(entries: Entry[]): RecallPorts {
  return {
    async embed() {
      return createEmbedding(0, 1);
    },
    async vectorSearch() {
      return entries.map((entry, index) => ({
        entry: {
          id: entry.id,
          subject: entry.subject,
          content: entry.content,
          importance: entry.importance,
          expiry: entry.expiry,
          created_at: entry.created_at,
          embedding: createEmbedding(index, 1),
        },
        vectorSim: 0.95 - index * 0.05,
      }));
    },
    async ftsSearch() {
      return [];
    },
    async hydrateEntries(ids) {
      return entries.filter((entry) => ids.includes(entry.id));
    },
    async recordRecallEvents() {
      return;
    },
  };
}

function createToolContext() {
  return {
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:webchat:test",
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

function truncateForLog(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3).trimEnd()}...`;
}

async function createTestDatabase(): Promise<SqlDatabase> {
  const databasePath = path.join(os.tmpdir(), `agenr-openclaw-tools-${randomUUID()}.sqlite`);
  tempDatabasePaths.push(databasePath);

  const database = await createDatabase(databasePath);
  openDatabases.push(database);
  return database;
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
