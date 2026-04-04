import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { createRecallAdapter } from "../../../src/adapters/db/recall-adapter.js";
import type { Entry } from "../../../src/core/types.js";

const databases: SqlDatabase[] = [];
const databasePaths: string[] = [];

describe("createRecallAdapter historical expansion", () => {
  afterEach(async () => {
    while (databases.length > 0) {
      await databases.pop()?.close();
    }

    while (databasePaths.length > 0) {
      await rm(databasePaths.pop() ?? "", { force: true });
    }
  });

  it("fetches direct superseded predecessors and retired same-subject entries", async () => {
    const database = await createTestDatabase();
    const adapter = createRecallAdapter(database, createEmbeddingPort());
    const currentWorkflow = createEntry({
      id: "dev-recall-command",
      subject: "local recall eval workflow",
      content: "Use the repo-owned dev recall command to serve the seam locally.",
      created_at: "2026-03-01T00:00:00.000Z",
    });
    const priorWorkflow = createEntry({
      id: "manual-http-shim",
      subject: "local recall eval workflow",
      content: "Run local recall evals with an ad hoc HTTP shim before each debugging session.",
      created_at: "2026-01-12T00:00:00.000Z",
      superseded_by: currentWorkflow.id,
    });
    const currentTracking = createEntry({
      id: "github-issues-tracking",
      subject: "memory freshness work tracking",
      content: "Track memory freshness eval work in GitHub issues.",
      created_at: "2026-02-10T00:00:00.000Z",
    });
    const retiredTracking = createEntry({
      id: "kanban-tracking",
      subject: "memory freshness work tracking",
      content: "Track memory freshness eval work on the kanban board.",
      created_at: "2026-01-05T00:00:00.000Z",
      retired: true,
      retired_at: "2026-02-10T00:00:00.000Z",
      retired_reason: "superseded by GitHub issues",
    });
    const unrelated = createEntry({
      id: "artifact-inspection",
      subject: "recall artifact inspection",
      content: "Inspect normalized artifacts after each recall eval run.",
      created_at: "2026-02-27T00:00:00.000Z",
    });

    await database.insertEntry(currentWorkflow, createEmbedding(0, 1), "workflow-current");
    await database.insertEntry(priorWorkflow, createEmbedding(0, 0.9), "workflow-prior");
    await database.insertEntry(currentTracking, createEmbedding(1, 1), "tracking-current");
    await database.insertEntry(retiredTracking, createEmbedding(1, 0.9), "tracking-retired");
    await database.insertEntry(unrelated, createEmbedding(2, 1), "artifact");

    const predecessors = await adapter.fetchPredecessors!({
      activeEntryIds: [currentWorkflow.id, currentTracking.id],
    });

    expect(predecessors.map((entry) => entry.id)).toEqual(["kanban-tracking", "manual-http-shim"]);
    expect(predecessors.map((entry) => entry.retired)).toEqual([true, false]);
    expect(predecessors[1]?.superseded_by).toBe("dev-recall-command");
  });

  it("hydrates inactive historical entries by id", async () => {
    const database = await createTestDatabase();
    const adapter = createRecallAdapter(database, createEmbeddingPort());
    const current = createEntry({
      id: "github-issues-tracking",
      subject: "memory freshness work tracking",
      content: "Track work in GitHub issues.",
    });
    const retired = createEntry({
      id: "kanban-tracking",
      subject: "memory freshness work tracking",
      content: "Track work on the kanban board.",
      retired: true,
      retired_at: "2026-02-10T00:00:00.000Z",
      retired_reason: "superseded by GitHub issues",
    });

    await database.insertEntry(current, createEmbedding(0, 1), "tracking-current");
    await database.insertEntry(retired, createEmbedding(0, 0.8), "tracking-retired");

    const hydrated = await adapter.hydrateEntries([retired.id, current.id]);

    expect(hydrated.map((entry) => entry.id)).toEqual(expect.arrayContaining([retired.id, current.id]));
    expect(hydrated.find((entry) => entry.id === retired.id)?.retired).toBe(true);
  });
});

async function createTestDatabase(): Promise<SqlDatabase> {
  const databasePath = path.join(os.tmpdir(), `agenr-recall-db-${randomUUID()}.sqlite`);
  databasePaths.push(databasePath);

  const database = await createDatabase(databasePath);
  databases.push(database);
  return database;
}

function createEntry(overrides: Partial<Entry> = {}): Entry {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? randomUUID(),
    type: overrides.type ?? "decision",
    subject: overrides.subject ?? "batch lookup",
    content: overrides.content ?? "Chunk hash lookups to avoid parameter pressure.",
    importance: overrides.importance ?? 7,
    expiry: overrides.expiry ?? "permanent",
    tags: overrides.tags ?? ["db"],
    source_file: overrides.source_file,
    source_context: overrides.source_context,
    embedding: overrides.embedding,
    content_hash: overrides.content_hash,
    norm_content_hash: overrides.norm_content_hash,
    quality_score: overrides.quality_score ?? 0.5,
    recall_count: overrides.recall_count ?? 0,
    last_recalled_at: overrides.last_recalled_at,
    superseded_by: overrides.superseded_by,
    valid_from: overrides.valid_from,
    valid_to: overrides.valid_to,
    claim_key: overrides.claim_key,
    supersession_kind: overrides.supersession_kind,
    supersession_reason: overrides.supersession_reason,
    cluster_id: overrides.cluster_id,
    user_id: overrides.user_id,
    project: overrides.project,
    retired: overrides.retired ?? false,
    retired_at: overrides.retired_at,
    retired_reason: overrides.retired_reason,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? overrides.created_at ?? now,
  };
}

function createEmbedding(index: number, value: number): number[] {
  const vector = Array.from({ length: 1024 }, () => 0);
  vector[index] = value;
  return vector;
}

function createEmbeddingPort() {
  return {
    embed: async (texts: string[]): Promise<number[][]> => texts.map((_, index) => createEmbedding(index, 1)),
  };
}
