import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { buildClusters } from "../src/consolidate/cluster.js";
import { initDb } from "../src/db/client.js";
import { hashText, insertEntry } from "../src/db/store.js";
import type { KnowledgeEntry } from "../src/types.js";

function vectorFromAngle(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180;
  const head = [Math.cos(radians), Math.sin(radians), 0];
  return [...head, ...Array.from({ length: 1021 }, () => 0)];
}

function makeEntry(type: KnowledgeEntry["type"], subject: string, content: string): KnowledgeEntry {
  return {
    type,
    subject,
    content,
    importance: 6,
    expiry: "permanent",
    tags: [],
    source: {
      file: "cluster.test.jsonl",
      context: "cluster test",
    },
  };
}

describe("consolidate cluster", () => {
  const clients: Client[] = [];

  afterEach(() => {
    while (clients.length > 0) {
      clients.pop()?.close();
    }
  });

  async function makeDb(): Promise<Client> {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    await initDb(client);
    return client;
  }

  async function seed(
    db: Client,
    params: {
      type: KnowledgeEntry["type"];
      subject: string;
      content: string;
      angle: number;
      confirmations?: number;
      recallCount?: number;
      mergedFrom?: number;
      consolidatedAt?: string;
    },
  ): Promise<string> {
    const id = await insertEntry(
      db,
      makeEntry(params.type, params.subject, params.content),
      vectorFromAngle(params.angle),
      hashText(`${params.type}:${params.subject}:${params.content}:${params.angle}`),
    );

    await db.execute({
      sql: `
        UPDATE entries
        SET confirmations = ?,
            recall_count = ?,
            merged_from = ?,
            consolidated_at = ?
        WHERE id = ?
      `,
      args: [
        params.confirmations ?? 0,
        params.recallCount ?? 0,
        params.mergedFrom ?? 0,
        params.consolidatedAt ?? null,
        id,
      ],
    });

    return id;
  }

  it("clusters entries above threshold into one group", async () => {
    const db = await makeDb();
    await seed(db, { type: "fact", subject: "Jim", content: "a", angle: 0 });
    await seed(db, { type: "fact", subject: "Jim", content: "b", angle: 10 });
    await seed(db, { type: "fact", subject: "Jim", content: "c", angle: 15 });

    const clusters = await buildClusters(db, { simThreshold: 0.85, minCluster: 3 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.entries).toHaveLength(3);
  });

  it("excludes retired entries from cluster candidates", async () => {
    const db = await makeDb();
    await seed(db, { type: "fact", subject: "Retired filter", content: "a", angle: 0 });
    await seed(db, { type: "fact", subject: "Retired filter", content: "b", angle: 8 });
    const retiredId = await seed(db, { type: "fact", subject: "Retired filter", content: "c", angle: 10 });

    await db.execute({
      sql: "UPDATE entries SET retired = 1, retired_at = ? WHERE id = ?",
      args: [new Date().toISOString(), retiredId],
    });

    const clusters = await buildClusters(db, { simThreshold: 0.85, minCluster: 3 });
    expect(clusters).toHaveLength(0);
  });

  it("respects diameter cap and rejects chained clusters below floor", async () => {
    const db = await makeDb();
    await seed(db, { type: "fact", subject: "Chain", content: "a", angle: 0, confirmations: 3 });
    await seed(db, { type: "fact", subject: "Chain", content: "b", angle: 20, confirmations: 2 });
    await seed(db, { type: "fact", subject: "Chain", content: "c", angle: 40, confirmations: 1 });

    const clusters = await buildClusters(db, { simThreshold: 0.85, minCluster: 3 });
    expect(clusters).toHaveLength(0);
  });

  it("caps cluster size at maxClusterSize by trimming lowest average similarity", async () => {
    const db = await makeDb();
    const keepA = await seed(db, { type: "fact", subject: "Cap", content: "a", angle: 0 });
    const keepB = await seed(db, { type: "fact", subject: "Cap", content: "b", angle: 5 });
    const keepC = await seed(db, { type: "fact", subject: "Cap", content: "c", angle: 10 });
    const trim = await seed(db, { type: "fact", subject: "Cap", content: "d", angle: 30 });

    const clusters = await buildClusters(db, {
      simThreshold: 0.85,
      minCluster: 3,
      maxClusterSize: 3,
    });

    expect(clusters).toHaveLength(1);
    const ids = new Set(clusters[0]?.entries.map((entry) => entry.id));
    expect(ids.has(keepA)).toBe(true);
    expect(ids.has(keepB)).toBe(true);
    expect(ids.has(keepC)).toBe(true);
    expect(ids.has(trim)).toBe(false);
  });

  it("supports cross-type clustering when subject matches and similarity exceeds 0.89", async () => {
    const db = await makeDb();
    await seed(db, { type: "fact", subject: "Shared Subject", content: "a", angle: 0 });
    await seed(db, { type: "preference", subject: "Shared Subject", content: "b", angle: 15 });
    await seed(db, { type: "fact", subject: "Shared Subject", content: "c", angle: 12 });

    const clusters = await buildClusters(db, { simThreshold: 0.85, minCluster: 3 });
    expect(clusters).toHaveLength(1);
    const types = new Set(clusters[0]?.entries.map((entry) => entry.type));
    expect(types.has("fact")).toBe(true);
    expect(types.has("preference")).toBe(true);
  });

  it("skips recently consolidated merged entries via idempotency guard", async () => {
    const db = await makeDb();
    const recent = new Date().toISOString();
    await seed(db, {
      type: "fact",
      subject: "Guard",
      content: "recent",
      angle: 0,
      mergedFrom: 2,
      consolidatedAt: recent,
    });
    await seed(db, { type: "fact", subject: "Guard", content: "b", angle: 8 });
    await seed(db, { type: "fact", subject: "Guard", content: "c", angle: 10 });

    const clusters = await buildClusters(db, { simThreshold: 0.85, minCluster: 3, idempotencyDays: 7 });
    expect(clusters).toHaveLength(0);
  });

  it("includes merged entries when consolidated_at is older than idempotency window", async () => {
    const db = await makeDb();
    const older = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await seed(db, {
      type: "fact",
      subject: "Guard",
      content: "old",
      angle: 0,
      mergedFrom: 2,
      consolidatedAt: older,
    });
    await seed(db, { type: "fact", subject: "Guard", content: "b", angle: 8 });
    await seed(db, { type: "fact", subject: "Guard", content: "c", angle: 10 });

    const clusters = await buildClusters(db, { simThreshold: 0.85, minCluster: 3, idempotencyDays: 7 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.entries).toHaveLength(3);
  });

  it("supports type filtering", async () => {
    const db = await makeDb();
    await seed(db, { type: "fact", subject: "Filter", content: "a", angle: 0 });
    await seed(db, { type: "fact", subject: "Filter", content: "b", angle: 8 });
    await seed(db, { type: "preference", subject: "Filter", content: "c", angle: 0 });
    await seed(db, { type: "preference", subject: "Filter", content: "d", angle: 8 });

    const clusters = await buildClusters(db, { minCluster: 2, typeFilter: "fact" });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.entries.every((entry) => entry.type === "fact")).toBe(true);
  });

  it("returns empty when no clusters meet minCluster", async () => {
    const db = await makeDb();
    await seed(db, { type: "fact", subject: "Small", content: "a", angle: 0 });
    await seed(db, { type: "fact", subject: "Small", content: "b", angle: 8 });

    const clusters = await buildClusters(db, { minCluster: 3 });
    expect(clusters).toHaveLength(0);
  });

  it("uses minCluster=2 by default so similar pairs can cluster", async () => {
    const db = await makeDb();
    await seed(db, { type: "fact", subject: "Pair", content: "a", angle: 0 });
    await seed(db, { type: "fact", subject: "Pair", content: "b", angle: 8 });

    const clusters = await buildClusters(db);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.entries).toHaveLength(2);
  });
});
