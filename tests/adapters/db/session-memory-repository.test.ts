import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { createSessionMemoryRepository } from "../../../src/adapters/db/session-memory-repository.js";

describe("createSessionMemoryRepository", () => {
  const databases: SqlDatabase[] = [];

  afterEach(async () => {
    for (const database of databases.splice(0)) {
      await database.close();
    }
  });

  it("persists lineage edges and de-duplicates matching parent references", async () => {
    const database = await createTestDatabase();
    const repository = createSessionMemoryRepository(database);

    const first = await repository.upsertLineageEdge({
      childSessionKey: "skeln:child",
      parentSourceRef: "session-file.jsonl",
      reason: "resume",
      observedAt: "2026-05-30T12:00:00.000Z",
    });
    const second = await repository.upsertLineageEdge({
      childSessionKey: "skeln:child",
      parentSourceRef: "session-file.jsonl",
      reason: "resume",
      observedAt: "2026-05-30T12:01:00.000Z",
    });

    expect(second.id).toBe(first.id);
    await expect(repository.getLatestLineageEdgeForChild("skeln:child")).resolves.toMatchObject({
      id: first.id,
      childSessionKey: "skeln:child",
      parentSourceRef: "session-file.jsonl",
      reason: "resume",
    });
  });

  it("upserts artifacts by kind, source, and source id", async () => {
    const database = await createTestDatabase();
    const repository = createSessionMemoryRepository(database);

    const created = await repository.upsertSessionArtifact({
      kind: "continuity_summary",
      sessionKey: "skeln:parent",
      source: "skeln",
      sourceId: "summary-1",
      sourceRef: "session-file.continuity-summary.md",
      contentHash: "hash-1",
      summary: "The predecessor summary.",
      metadata: { messageCount: 12 },
    });
    const updated = await repository.upsertSessionArtifact({
      kind: "continuity_summary",
      sessionKey: "skeln:parent",
      source: "skeln",
      sourceId: "summary-1",
      sourceRef: "session-file.continuity-summary.md",
      contentHash: "hash-2",
      summary: "The updated predecessor summary.",
      metadata: { messageCount: 13 },
    });

    expect(updated.id).toBe(created.id);
    expect(updated).toMatchObject({
      summary: "The updated predecessor summary.",
      contentHash: "hash-2",
      metadata: { messageCount: 13 },
    });
    expect(updated.createdAt).toBe(created.createdAt);
    await expect(
      repository.listSessionArtifacts({
        sessionKey: "skeln:parent",
        kinds: ["continuity_summary"],
      }),
    ).resolves.toMatchObject([
      {
        id: created.id,
        summary: "The updated predecessor summary.",
      },
    ]);
  });

  it("lists continuity artifacts by source ref", async () => {
    const database = await createTestDatabase();
    const repository = createSessionMemoryRepository(database);

    await repository.upsertSessionArtifact({
      kind: "continuity_summary",
      sessionKey: "skeln:parent",
      source: "skeln",
      sourceId: "summary-1",
      sourceRef: "previous-session.jsonl",
      contentHash: "hash-1",
      summary: "The predecessor summary.",
    });

    await expect(
      repository.listSessionArtifactsBySourceRef({
        sourceRef: "previous-session.jsonl",
        kinds: ["continuity_summary"],
      }),
    ).resolves.toMatchObject([
      {
        summary: "The predecessor summary.",
        sourceRef: "previous-session.jsonl",
      },
    ]);
  });

  it("persists lineage and artifacts atomically from one trigger intake", async () => {
    const database = await createTestDatabase();
    const repository = createSessionMemoryRepository(database);

    const intake = await repository.recordTriggerIntake({
      lineage: {
        childSessionKey: "skeln:child",
        parentSessionKey: "skeln:parent",
        reason: "resume",
        observedAt: "2026-05-30T12:00:00.000Z",
      },
      artifact: {
        kind: "continuity_summary",
        sessionKey: "skeln:parent",
        source: "skeln",
        sourceId: "summary-1",
        contentHash: "hash-1",
        summary: "The predecessor summary.",
      },
    });

    expect(intake.lineageEdge).toMatchObject({
      childSessionKey: "skeln:child",
      parentSessionKey: "skeln:parent",
      reason: "resume",
    });
    expect(intake.artifact).toMatchObject({
      kind: "continuity_summary",
      summary: "The predecessor summary.",
    });
    await expect(repository.getLatestLineageEdgeForChild("skeln:child")).resolves.toMatchObject({
      parentSessionKey: "skeln:parent",
    });
    await expect(
      repository.listSessionArtifacts({
        sessionKey: "skeln:parent",
        kinds: ["continuity_summary"],
      }),
    ).resolves.toMatchObject([
      {
        summary: "The predecessor summary.",
      },
    ]);
  });

  async function createTestDatabase(): Promise<SqlDatabase> {
    const dbPath = path.join(os.tmpdir(), `agenr-session-memory-${randomUUID()}.sqlite`);
    const database = await createDatabase(dbPath);
    databases.push(database);
    return database;
  }
});
