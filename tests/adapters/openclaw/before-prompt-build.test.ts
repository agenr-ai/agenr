import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { handleAgenrBeforePromptBuild } from "../../../src/adapters/openclaw/hooks/before-prompt-build.js";
import { createSessionStartTracker } from "../../../src/adapters/openclaw/session/state.js";
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

describe("handleAgenrBeforePromptBuild", () => {
  it("injects session-start memory once per session even without embeddings", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
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
        servicesPromise: Promise.resolve(createServices(database)),
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
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
      },
    );

    expect(result?.prependContext).toContain("Agenr Session Recall");
    expect(result?.prependContext).toContain("master branch workflow");
    expect(result?.prependContext).toContain("latest plugin work");
    expect(secondResult).toBeUndefined();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] session-start recall for session=session-1 key=agent:main:webchat:test",
        "[agenr] session-start recall skipped (already ran) for session=session-1 key=agent:main:webchat:test",
        "[agenr] session tracker: first start for session=session-1 key=agent:main:webchat:test",
        "[agenr] session tracker: duplicate start blocked for session=session-1 key=agent:main:webchat:test",
        "[agenr] session tracker: now tracking 1 active sessions",
      ]),
    );
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("logs detailed session-start recall facts for core, handoff, relevant, and recent entries", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const coreEntry = createEntry({
      type: "decision",
      subject: "session isolation rule",
      content: "Keep each TUI session pinned to its own session key and handoff chain.",
      expiry: "core",
      importance: 10,
    });
    const handoffEntry = createEntry({
      type: "reflection",
      subject: "session handoff - openclaw recall verification",
      content: "Carry forward the last verified handoff summary and confirm it matches the active session key.",
      expiry: "temporary",
      importance: 8,
      tags: ["handoff"],
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
    await database.insertEntry(handoffEntry, createEmbedding(1, 1), "handoff-workflow");
    await database.insertEntry(relevantEntry, createEmbedding(2, 1), "relevant-workflow");
    await database.insertEntry(recentEntry, createEmbedding(3, 1), "recent-workflow");

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Verify each TUI session stays isolated and the right handoff was injected.",
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
            recall: createRelevantRecallPorts(relevantEntry),
          }),
        ),
        tracker: createSessionStartTracker(),
      },
    );

    expect(result?.prependContext).toContain("Core Memory");
    expect(result?.prependContext).toContain("Recent Handoffs");
    expect(result?.prependContext).toContain("Relevant Recall");
    expect(result?.prependContext).toContain("Recent Context");
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] session-start recall: 1 core, 1 handoffs, 1 relevant, 1 recent entries for session=session-2 key=agent:main:webchat:isolated",
        expect.stringContaining(
          '[agenr] session-start relevant query for session=session-2 key=agent:main:webchat:isolated: "Verify each TUI session stays isolated and the right handoff was injected."',
        ),
        expect.stringContaining(
          `[agenr] session-start core entries for session=session-2 key=agent:main:webchat:isolated: ${coreEntry.subject} [${coreEntry.id}]`,
        ),
        expect.stringContaining(
          `[agenr] session-start handoff entries for session=session-2 key=agent:main:webchat:isolated: ${handoffEntry.subject} [${handoffEntry.id}]`,
        ),
        expect.stringContaining(`[agenr] session-start relevant entries for session=session-2 key=agent:main:webchat:isolated: `),
        expect.stringContaining(`${relevantEntry.subject} [${relevantEntry.id}]`),
        expect.stringContaining(
          `[agenr] session-start recent entries for session=session-2 key=agent:main:webchat:isolated: ${recentEntry.subject} [${recentEntry.id}]`,
        ),
        expect.stringContaining("[agenr] session-start prependContext length for session=session-2 key=agent:main:webchat:isolated: "),
      ]),
    );
    expect(logger.debug).not.toHaveBeenCalled();
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
        "[agenr] session-start recall: 0 core, 0 handoffs, 0 relevant, 0 recent entries for session=session-empty key=agent:main:webchat:empty",
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
    async close() {
      await database.close();
    },
  };
}

function createRelevantRecallPorts(entry: Entry): RecallPorts {
  return {
    async embed(): Promise<number[]> {
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
      return;
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

async function createTestDatabase(): Promise<SqlDatabase> {
  const databasePath = path.join(os.tmpdir(), `agenr-openclaw-${randomUUID()}.sqlite`);
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
