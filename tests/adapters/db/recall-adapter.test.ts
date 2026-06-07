import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { createRecallAdapter } from "../../../src/adapters/db/recall-adapter.js";
import { closeTestDatabases, removeTestPath } from "../../helpers/temp-paths.js";
import type { Durable } from "../../../src/core/types.js";

const databases: SqlDatabase[] = [];
const databasePaths: string[] = [];

describe("createRecallAdapter historical expansion", () => {
  afterEach(async () => {
    await closeTestDatabases(databases);

    while (databasePaths.length > 0) {
      await removeTestPath(databasePaths.pop() ?? "");
    }
  });

  it("returns claim-key lifecycle fields on recall candidates when present and leaves them undefined otherwise", async () => {
    const database = await createTestDatabase();
    const adapter = createRecallAdapter(database, createEmbeddingPort());
    const withClaimKey = createEntry({
      id: "vite-packaging",
      subject: "deployment packaging",
      content: "Use Vite for deployment packaging.",
      claim_key: "deployments/packaging",
      claim_key_status: "trusted",
    });
    const withoutClaimKey = createEntry({
      id: "webpack-fallback",
      subject: "deployment packaging fallback",
      content: "Keep webpack as the fallback packager.",
    });

    await database.insertDurable(withClaimKey, createEmbedding(0, 1), "packaging-current");
    await database.insertDurable(withoutClaimKey, createEmbedding(1, 1), "packaging-fallback");

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

    expect(vectorCandidates.find((candidate) => candidate.durable.id === withClaimKey.id)?.durable.claim_key).toBe("deployments/packaging");
    expect(vectorCandidates.find((candidate) => candidate.durable.id === withClaimKey.id)?.durable.claim_key_status).toBe("trusted");
    expect(vectorCandidates.find((candidate) => candidate.durable.id === withoutClaimKey.id)?.durable.claim_key).toBeUndefined();
    expect(vectorCandidates.find((candidate) => candidate.durable.id === withoutClaimKey.id)?.durable.claim_key_status).toBeUndefined();
    expect(lexicalWithClaim[0]?.durable.claim_key).toBe("deployments/packaging");
    expect(lexicalWithClaim[0]?.durable.claim_key_status).toBe("trusted");
    expect(lexicalWithoutClaim[0]?.durable.claim_key).toBeUndefined();
    expect(lexicalWithoutClaim[0]?.durable.claim_key_status).toBeUndefined();
  });

  it("matches a sentence-final period query whose last token carries trailing punctuation", async () => {
    const database = await createTestDatabase();
    const adapter = createRecallAdapter(database, createEmbeddingPort());
    const entry = createEntry({
      id: "office-hours",
      subject: "office hours schedule",
      content: "Office hours schedule is Monday afternoons.",
    });

    await database.insertDurable(entry, createEmbedding(0, 1), "office-hours");

    // The trailing period would otherwise leave a "schedule." token whose bare
    // FTS5 word form throws "syntax error near ." and silently empties the tier.
    const candidates = await adapter.ftsSearch({ text: "Tell me the office hours schedule.", limit: 5 });

    expect(candidates.map((candidate) => candidate.durable.id)).toContain("office-hours");
  });

  it("excludes expired and not-yet-valid durables when validAsOf is set on filters", async () => {
    const database = await createTestDatabase();
    const adapter = createRecallAdapter(database, createEmbeddingPort());
    const asOf = new Date("2026-03-15T12:00:00.000Z");
    const current = createEntry({
      id: "location-current",
      subject: "home base",
      content: "Currently living in Lisbon.",
      valid_from: "2026-03-01T00:00:00.000Z",
      valid_to: "2026-03-31T00:00:00.000Z",
    });
    const expired = createEntry({
      id: "location-expired",
      subject: "home base",
      content: "Living in Singapore for the contract.",
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_to: "2026-03-10T00:00:00.000Z",
    });
    const future = createEntry({
      id: "location-future",
      subject: "home base",
      content: "Moving to Berlin next month.",
      valid_from: "2026-03-20T00:00:00.000Z",
    });

    await database.insertDurable(current, createEmbedding(0, 1), "location-current");
    await database.insertDurable(expired, createEmbedding(1, 1), "location-expired");
    await database.insertDurable(future, createEmbedding(2, 1), "location-future");

    const vectorCandidates = await adapter.vectorSearch({
      embedding: createEmbedding(0, 1),
      limit: 5,
      filters: { validAsOf: asOf },
    });
    const lexicalCandidates = await adapter.ftsSearch({
      text: "home base",
      limit: 5,
      filters: { validAsOf: asOf },
    });

    expect(vectorCandidates.map((candidate) => candidate.durable.id)).toEqual(["location-current"]);
    expect(lexicalCandidates.map((candidate) => candidate.durable.id)).toEqual(["location-current"]);
  });

  it("matches queries containing dotted or hyphenated tokens without dropping the tier", async () => {
    const database = await createTestDatabase();
    const adapter = createRecallAdapter(database, createEmbeddingPort());
    const entry = createEntry({
      id: "embedding-model",
      subject: "embedding model choice",
      content: "We embed durables with the text embedding 3 small model.",
    });

    await database.insertDurable(entry, createEmbedding(0, 1), "embedding-model");

    // "text-embedding-3-small" tokenizes to a hyphen-bearing token whose bare
    // FTS5 word form throws and would otherwise return nothing for the tier.
    const candidates = await adapter.ftsSearch({ text: "which text-embedding-3-small model do we use", limit: 5 });

    expect(candidates.map((candidate) => candidate.durable.id)).toContain("embedding-model");
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
      valid_to: "2026-01-20T00:00:00.000Z",
      supersession_kind: "stale",
      supersession_reason: "replaced by the manual shim",
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
      valid_to: "2026-02-10T00:00:00.000Z",
      supersession_kind: "stale",
      supersession_reason: "superseded by GitHub issues",
    });
    const unrelated = createEntry({
      id: "artifact-inspection",
      subject: "recall artifact inspection",
      content: "Inspect normalized artifacts after each recall eval run.",
      created_at: "2026-02-27T00:00:00.000Z",
    });

    await database.insertDurable(currentWorkflow, createEmbedding(0, 1), "workflow-current");
    await database.insertDurable(priorWorkflow, createEmbedding(0, 0.9), "workflow-prior");
    await database.insertDurable(retiredBridge, createEmbedding(0, 0.85), "workflow-retired-bridge");
    await database.insertDurable(activeSibling, createEmbedding(0, 0.8), "workflow-active-sibling");
    await database.insertDurable(currentTracking, createEmbedding(1, 1), "tracking-current");
    await database.insertDurable(retiredTracking, createEmbedding(1, 0.9), "tracking-retired");
    await database.insertDurable(unrelated, createEmbedding(2, 1), "artifact");

    const predecessors = await adapter.expandNeighborhood!({
      seedIds: [currentWorkflow.id, currentTracking.id],
      budget: 40,
      families: ["supersession_chain", "claim_key_sibling", "topic_family"],
      includeHistorical: true,
    });

    expect(predecessors.map((entry) => entry.id)).toEqual(["manual-http-shim", "express-proxy-bridge", "cli-wrapper", "kanban-tracking"]);
    expect(predecessors.map((entry) => entry.valid_to !== undefined)).toEqual([false, true, false, true]);
    expect(predecessors[0]?.superseded_by).toBe("dev-recall-command");
    expect(predecessors[0]?.claim_key).toBe("recall_eval/local_workflow");
    expect(predecessors[1]?.claim_key).toBe("recall_eval/local_workflow");
    expect(predecessors[2]?.claim_key).toBe("recall_eval/local_workflow");
    expect(predecessors[3]?.claim_key).toBeUndefined();
  });

  it("prefers trusted same-claim-key siblings ahead of tentative ones during predecessor expansion", async () => {
    const database = await createTestDatabase();
    const adapter = createRecallAdapter(database, createEmbeddingPort());
    const current = createEntry({
      id: "current-entry",
      subject: "deployment packaging",
      content: "Use Vite for deployment packaging.",
      claim_key: "deployments/packaging",
      claim_key_status: "trusted",
      created_at: "2026-03-10T00:00:00.000Z",
    });
    const tentativeOlder = createEntry({
      id: "tentative-older",
      subject: "deployment packaging fallback",
      content: "Maybe webpack was still the deployment packager.",
      claim_key: "deployments/packaging",
      claim_key_status: "tentative",
      created_at: "2026-01-10T00:00:00.000Z",
    });
    const trustedOlder = createEntry({
      id: "trusted-older",
      subject: "deployment packaging legacy",
      content: "Webpack handled deployment packaging before Vite.",
      claim_key: "deployments/packaging",
      claim_key_status: "trusted",
      created_at: "2026-02-10T00:00:00.000Z",
    });

    await database.insertDurable(current, createEmbedding(0, 1), "packaging-current");
    await database.insertDurable(tentativeOlder, createEmbedding(0, 0.9), "packaging-tentative");
    await database.insertDurable(trustedOlder, createEmbedding(0, 0.85), "packaging-trusted");

    const predecessors = await adapter.expandNeighborhood!({
      seedIds: [current.id],
      budget: 40,
      families: ["supersession_chain", "claim_key_sibling", "topic_family"],
      includeHistorical: true,
    });

    expect(predecessors.map((entry) => entry.id)).toEqual(["trusted-older", "tentative-older"]);
    expect(predecessors.map((entry) => entry.claim_key_status)).toEqual(["trusted", "tentative"]);
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

    await database.insertDurable(current, createEmbedding(0, 1), "current-entry");

    for (let index = 0; index < 12; index += 1) {
      await database.insertDurable(
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

    const predecessors = await adapter.expandNeighborhood!({
      seedIds: [current.id],
      budget: 40,
      families: ["supersession_chain", "claim_key_sibling", "topic_family"],
      includeHistorical: true,
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
      valid_to: "2026-02-10T00:00:00.000Z",
      supersession_kind: "stale",
      supersession_reason: "superseded by GitHub issues",
    });

    await database.insertDurable(current, createEmbedding(0, 1), "tracking-current");
    await database.insertDurable(retired, createEmbedding(0, 0.8), "tracking-retired");

    const hydrated = await adapter.hydrateDurables([retired.id, current.id]);

    expect(hydrated.map((entry) => entry.id)).toEqual(expect.arrayContaining([retired.id, current.id]));
    expect(hydrated.find((entry) => entry.id === retired.id)?.valid_to).toBe("2026-02-10T00:00:00.000Z");
  });
});

async function createTestDatabase(): Promise<SqlDatabase> {
  const databasePath = path.join(os.tmpdir(), `agenr-recall-db-${randomUUID()}.sqlite`);
  databasePaths.push(databasePath);

  const database = await createDatabase(databasePath);
  databases.push(database);
  return database;
}

function createEntry(overrides: Partial<Durable> = {}): Durable {
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
    claim_key_status: overrides.claim_key_status,
    supersession_kind: overrides.supersession_kind,
    supersession_reason: overrides.supersession_reason,
    user_id: overrides.user_id,
    project: overrides.project,
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
