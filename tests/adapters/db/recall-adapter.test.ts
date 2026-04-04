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

  it("returns claim_key on recall candidates when present and leaves it undefined otherwise", async () => {
    const database = await createTestDatabase();
    const adapter = createRecallAdapter(database, createEmbeddingPort());
    const withClaimKey = createEntry({
      id: "vite-packaging",
      subject: "deployment packaging",
      content: "Use Vite for deployment packaging.",
      claim_key: "deployments/packaging",
    });
    const withoutClaimKey = createEntry({
      id: "webpack-fallback",
      subject: "deployment packaging fallback",
      content: "Keep webpack as the fallback packager.",
    });

    await database.insertEntry(withClaimKey, createEmbedding(0, 1), "packaging-current");
    await database.insertEntry(withoutClaimKey, createEmbedding(1, 1), "packaging-fallback");

    const vectorCandidates = await adapter.vectorSearch({
      embedding: Array.from({ length: 1024 }, (_, index) => (index < 2 ? 1 : 0)),
      limit: 5,
    });
    const lexicalWithClaim = await adapter.ftsSearch({
      text: "vite packaging",
      limit: 5,
    });
    const lexicalWithoutClaim = await adapter.ftsSearch({
      text: "webpack fallback",
      limit: 5,
    });

    expect(vectorCandidates.find((candidate) => candidate.entry.id === withClaimKey.id)?.entry.claim_key).toBe("deployments/packaging");
    expect(vectorCandidates.find((candidate) => candidate.entry.id === withoutClaimKey.id)?.entry.claim_key).toBeUndefined();
    expect(lexicalWithClaim[0]?.entry.claim_key).toBe("deployments/packaging");
    expect(lexicalWithoutClaim[0]?.entry.claim_key).toBeUndefined();
  });

  it("fetches direct predecessors, same-claim-key lineage siblings, and retired same-subject fallbacks", async () => {
    const database = await createTestDatabase();
    const adapter = createRecallAdapter(database, createEmbeddingPort());
    const currentWorkflow = createEntry({
      id: "dev-recall-command",
      subject: "local recall eval workflow",
      content: "Use the repo-owned dev recall command to serve the seam locally.",
      claim_key: "recall_eval/local_workflow",
      created_at: "2026-03-01T00:00:00.000Z",
    });
    const priorWorkflow = createEntry({
      id: "manual-http-shim",
      subject: "local recall eval workflow",
      content: "Run local recall evals with an ad hoc HTTP shim before each debugging session.",
      claim_key: "recall_eval/local_workflow",
      created_at: "2026-01-12T00:00:00.000Z",
      superseded_by: currentWorkflow.id,
    });
    const retiredBridge = createEntry({
      id: "express-proxy-bridge",
      subject: "HTTP bridge workaround",
      content: "Retire the local express proxy bridge for recall evals.",
      claim_key: "recall_eval/local_workflow",
      created_at: "2026-01-02T00:00:00.000Z",
      retired: true,
      retired_at: "2026-01-20T00:00:00.000Z",
      retired_reason: "replaced by the manual shim",
    });
    const activeSibling = createEntry({
      id: "cli-wrapper",
      subject: "repo CLI wrapper",
      content: "Wrap the recall eval seam in a repo-owned CLI command.",
      claim_key: "recall_eval/local_workflow",
      created_at: "2026-02-05T00:00:00.000Z",
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
    await database.insertEntry(retiredBridge, createEmbedding(0, 0.85), "workflow-retired-bridge");
    await database.insertEntry(activeSibling, createEmbedding(0, 0.8), "workflow-active-sibling");
    await database.insertEntry(currentTracking, createEmbedding(1, 1), "tracking-current");
    await database.insertEntry(retiredTracking, createEmbedding(1, 0.9), "tracking-retired");
    await database.insertEntry(unrelated, createEmbedding(2, 1), "artifact");

    const predecessors = await adapter.fetchPredecessors!({
      activeEntryIds: [currentWorkflow.id, currentTracking.id],
    });

    expect(predecessors.map((entry) => entry.id)).toEqual(["manual-http-shim", "express-proxy-bridge", "cli-wrapper", "kanban-tracking"]);
    expect(predecessors.map((entry) => entry.retired)).toEqual([false, true, false, true]);
    expect(predecessors[0]?.superseded_by).toBe("dev-recall-command");
    expect(predecessors[0]?.claim_key).toBe("recall_eval/local_workflow");
    expect(predecessors[1]?.claim_key).toBe("recall_eval/local_workflow");
    expect(predecessors[2]?.claim_key).toBe("recall_eval/local_workflow");
    expect(predecessors[3]?.claim_key).toBeUndefined();
  });

  it("keeps claim-key predecessor expansion bounded", async () => {
    const database = await createTestDatabase();
    const adapter = createRecallAdapter(database, createEmbeddingPort());
    const current = createEntry({
      id: "current-entry",
      subject: "memory slot current",
      content: "Use the current memory slot value.",
      claim_key: "memory/slot",
      created_at: "2026-03-20T00:00:00.000Z",
    });

    await database.insertEntry(current, createEmbedding(0, 1), "current-entry");

    for (let index = 0; index < 12; index += 1) {
      await database.insertEntry(
        createEntry({
          id: `older-entry-${index.toString().padStart(2, "0")}`,
          subject: `memory slot revision ${index}`,
          content: `Earlier memory slot revision ${index}.`,
          claim_key: "memory/slot",
          created_at: `2026-03-${(index + 1).toString().padStart(2, "0")}T00:00:00.000Z`,
        }),
        createEmbedding(0, 0.8),
        `older-entry-${index}`,
      );
    }

    const predecessors = await adapter.fetchPredecessors!({
      activeEntryIds: [current.id],
    });

    expect(predecessors).toHaveLength(8);
    expect(predecessors.map((entry) => entry.id)).toEqual([
      "older-entry-00",
      "older-entry-01",
      "older-entry-02",
      "older-entry-03",
      "older-entry-04",
      "older-entry-05",
      "older-entry-06",
      "older-entry-07",
    ]);
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
