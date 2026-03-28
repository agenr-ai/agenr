import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
        logger: createLogger(),
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
        logger: createLogger(),
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
      },
    );

    expect(result?.prependContext).toContain("Agenr Session Recall");
    expect(result?.prependContext).toContain("master branch workflow");
    expect(result?.prependContext).toContain("latest plugin work");
    expect(secondResult).toBeUndefined();
  });
});

function createServices(database: SqlDatabase): AgenrOpenClawServices {
  const embedding: EmbeddingPort = {
    async embed(): Promise<number[][]> {
      throw new Error("Embeddings unavailable in this test.");
    },
  };
  const recall: RecallPorts = {
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
  };

  return {
    config: {},
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

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
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
