import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consolidateRules } from "../../src/consolidate/rules.js";
import { initDb } from "../../src/db/client.js";
import { createRelation } from "../../src/db/relations.js";
import { hashText, insertEntry } from "../../src/db/store.js";
import type { Expiry, KnowledgeEntry, KnowledgeType } from "../../src/types.js";

function asNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim()) {
    return Number(value);
  }
  return Number.NaN;
}

function asString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function makeDummyEmbedding(seed = 0): number[] {
  const vec = new Array(512).fill(0);
  for (let i = 0; i < 512; i += 1) {
    vec[i] = Math.sin(seed * 0.1 + i * 0.01);
  }
  const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0));
  return vec.map((value) => value / norm);
}

describe("consolidate rules", () => {
  const clients: Client[] = [];
  const tempDirs: string[] = [];
  let client: Client;
  let backupSourcePath: string;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    clients.push(client);
    await initDb(client);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-consolidate-"));
    tempDirs.push(dir);
    backupSourcePath = path.join(dir, "knowledge.db");
    await fs.writeFile(backupSourcePath, "backup-seed", "utf8");
  });

  afterEach(async () => {
    while (clients.length > 0) {
      clients.pop()?.close();
    }
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  async function insertTestEntry(params: {
    type?: KnowledgeType;
    subject?: string;
    content: string;
    expiry?: Expiry;
    confirmations?: number;
    recallCount?: number;
    daysOld?: number;
    seed?: number;
    tags?: string[];
  }): Promise<string> {
    const entry: KnowledgeEntry = {
      type: params.type ?? "fact",
      subject: params.subject ?? "Jim Martin",
      content: params.content,
      importance: 6,
      expiry: params.expiry ?? "permanent",
      tags: params.tags ?? [],
      source: {
        file: "rules.test.jsonl",
        context: "unit test",
      },
    };

    const id = await insertEntry(
      client,
      entry,
      makeDummyEmbedding(params.seed ?? 0),
      hashText(`${params.content}:${randomUUID()}`),
    );

    if ((params.confirmations ?? 0) !== 0 || (params.recallCount ?? 0) !== 0) {
      await client.execute({
        sql: "UPDATE entries SET confirmations = ?, recall_count = ? WHERE id = ?",
        args: [params.confirmations ?? 0, params.recallCount ?? 0, id],
      });
    }

    if (typeof params.daysOld === "number") {
      const createdAt = new Date(Date.now() - params.daysOld * 24 * 60 * 60 * 1000).toISOString();
      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE id = ?",
        args: [createdAt, createdAt, id],
      });
    }

    return id;
  }

  async function insertRawEntry(db: Client, params: { id: string; content: string; createdAt?: string }): Promise<void> {
    const now = params.createdAt ?? new Date().toISOString();
    await db.execute({
      sql: `
        INSERT INTO entries (
          id,
          type,
          subject,
          content,
          importance,
          expiry,
          scope,
          source_file,
          source_context,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        params.id,
        "fact",
        "backup-subject",
        params.content,
        6,
        "permanent",
        "private",
        "rules.test.jsonl",
        "unit test",
        now,
        now,
      ],
    });
  }

  async function getSupersededBy(id: string): Promise<string | null> {
    const result = await client.execute({
      sql: "SELECT superseded_by FROM entries WHERE id = ?",
      args: [id],
    });
    const value = result.rows[0]?.superseded_by;
    const text = asString(value);
    return text.length > 0 ? text : null;
  }

  it("expires temporary entries when heavily decayed", async () => {
    const id = await insertTestEntry({
      content: "stale session note",
      expiry: "temporary",
      daysOld: 60000,
      seed: 1,
    });

    const stats = await consolidateRules(client, backupSourcePath);
    expect(await getSupersededBy(id)).toBe("EXPIRED");
    expect(stats.expiredCount).toBe(1);
  });

  it("does not expire temporary entries younger than 10 days", async () => {
    const id = await insertTestEntry({
      content: "fresh session note",
      expiry: "temporary",
      daysOld: 10,
      seed: 2,
    });

    const stats = await consolidateRules(client, backupSourcePath);
    expect(await getSupersededBy(id)).toBe(null);
    expect(stats.expiredCount).toBe(0);
  });

  it("expires temporary entries older than 150 days", async () => {
    const id = await insertTestEntry({
      content: "stale temporary note",
      expiry: "temporary",
      daysOld: 60000,
      seed: 3,
    });

    await consolidateRules(client, backupSourcePath);
    expect(await getSupersededBy(id)).toBe("EXPIRED");
  });

  it("never expires core or permanent entries", async () => {
    const coreId = await insertTestEntry({
      content: "core memory",
      subject: "Core Subject",
      expiry: "core",
      daysOld: 1000,
      seed: 4,
    });
    const permanentId = await insertTestEntry({
      content: "permanent memory",
      subject: "Permanent Subject",
      expiry: "permanent",
      daysOld: 1000,
      seed: 5,
    });

    const stats = await consolidateRules(client, backupSourcePath);
    expect(await getSupersededBy(coreId)).toBe(null);
    expect(await getSupersededBy(permanentId)).toBe(null);
    expect(stats.expiredCount).toBe(0);
  });

  it("merges near-exact duplicates", async () => {
    const id1 = await insertTestEntry({
      content: "duplicate one",
      subject: "Jim Martin",
      type: "fact",
      confirmations: 1,
      seed: 10,
      tags: ["a"],
    });
    const id2 = await insertTestEntry({
      content: "duplicate two",
      subject: "Jim Martin",
      type: "fact",
      confirmations: 3,
      seed: 10,
      tags: ["b"],
    });
    const id3 = await insertTestEntry({
      content: "duplicate three",
      subject: "Jim Martin",
      type: "fact",
      confirmations: 0,
      seed: 10,
      tags: ["c"],
    });

    const stats = await consolidateRules(client, backupSourcePath);
    expect(stats.mergedCount).toBe(2);

    expect(await getSupersededBy(id1)).toBe(id2);
    expect(await getSupersededBy(id3)).toBe(id2);
    expect(await getSupersededBy(id2)).toBe(null);

    const keeper = await client.execute({
      sql: "SELECT confirmations, merged_from FROM entries WHERE id = ?",
      args: [id2],
    });
    expect(asNumber(keeper.rows[0]?.confirmations)).toBe(4);
    expect(asNumber(keeper.rows[0]?.merged_from)).toBe(2);

    const sourceRows = await client.execute({
      sql: `
        SELECT source_entry_id, original_confirmations, original_recall_count
        FROM entry_sources
        WHERE merged_entry_id = ?
        ORDER BY source_entry_id ASC
      `,
      args: [id2],
    });
    expect(sourceRows.rows).toHaveLength(2);
    const byId = new Map(
      sourceRows.rows.map((row) => [
        asString(row.source_entry_id),
        {
          confirmations: asNumber(row.original_confirmations),
          recallCount: asNumber(row.original_recall_count),
        },
      ]),
    );
    expect(byId.get(id1)?.confirmations).toBe(1);
    expect(byId.get(id3)?.confirmations).toBe(0);
    expect(byId.get(id1)?.recallCount).toBe(0);
    expect(byId.get(id3)?.recallCount).toBe(0);

    const supersedesRelations = await client.execute({
      sql: "SELECT source_id, target_id FROM relations WHERE relation_type = 'supersedes' ORDER BY target_id ASC",
      args: [],
    });
    expect(supersedesRelations.rows).toHaveLength(2);
    expect(supersedesRelations.rows.every((row) => asString(row.source_id) === id2)).toBe(true);
    expect(supersedesRelations.rows.map((row) => asString(row.target_id)).sort()).toEqual([id1, id3].sort());
  });

  it("does not merge entries with different types", async () => {
    const id1 = await insertTestEntry({
      content: "fact variant",
      subject: "Jim Martin",
      type: "fact",
      seed: 20,
    });
    const id2 = await insertTestEntry({
      content: "preference variant",
      subject: "Jim Martin",
      type: "preference",
      seed: 20,
    });

    const stats = await consolidateRules(client, backupSourcePath);
    expect(await getSupersededBy(id1)).toBe(null);
    expect(await getSupersededBy(id2)).toBe(null);
    expect(stats.mergedCount).toBe(0);
  });

  it("does not merge entries with different subjects", async () => {
    const id1 = await insertTestEntry({
      content: "subject A",
      subject: "Jim Martin",
      type: "fact",
      seed: 30,
    });
    const id2 = await insertTestEntry({
      content: "subject B",
      subject: "Jane Martin",
      type: "fact",
      seed: 30,
    });

    const stats = await consolidateRules(client, backupSourcePath);
    expect(await getSupersededBy(id1)).toBe(null);
    expect(await getSupersededBy(id2)).toBe(null);
    expect(stats.mergedCount).toBe(0);
  });

  it("cleans orphaned relations", async () => {
    const id1 = await insertTestEntry({
      content: "relation source",
      subject: "S1",
      seed: 40,
    });
    const id2 = await insertTestEntry({
      content: "relation target",
      subject: "S2",
      seed: 140,
    });
    await createRelation(client, id1, id2, "related");

    await client.execute({
      sql: "UPDATE entries SET superseded_by = ? WHERE id = ?",
      args: [id1, id2],
    });

    const stats = await consolidateRules(client, backupSourcePath);
    const relations = await client.execute("SELECT relation_type FROM relations");
    expect(relations.rows).toHaveLength(0);
    expect(stats.orphanedRelationsCleaned).toBe(1);
  });

  it("preserves supersedes relations during orphan cleanup", async () => {
    const id1 = await insertTestEntry({
      content: "keeper",
      subject: "merge-source",
      seed: 50,
    });
    const id2 = await insertTestEntry({
      content: "superseded",
      subject: "merge-target",
      seed: 150,
    });
    await createRelation(client, id1, id2, "supersedes");

    await client.execute({
      sql: "UPDATE entries SET superseded_by = ? WHERE id = ?",
      args: [id1, id2],
    });

    const stats = await consolidateRules(client, backupSourcePath);
    const relations = await client.execute({
      sql: "SELECT relation_type FROM relations WHERE relation_type = 'supersedes'",
      args: [],
    });
    expect(relations.rows).toHaveLength(1);
    expect(stats.orphanedRelationsCleaned).toBe(0);
  });

  it("dry run makes no changes", async () => {
    const expiredId = await insertTestEntry({
      content: "expired candidate",
      expiry: "temporary",
      daysOld: 60000,
      seed: 60,
    });
    const dupA = await insertTestEntry({
      content: "dry duplicate A",
      type: "fact",
      subject: "Dry Subject",
      confirmations: 1,
      seed: 70,
    });
    const dupB = await insertTestEntry({
      content: "dry duplicate B",
      type: "fact",
      subject: "Dry Subject",
      confirmations: 3,
      seed: 70,
    });

    const stats = await consolidateRules(client, backupSourcePath, { dryRun: true });
    expect(stats.expiredCount).toBeGreaterThan(0);
    expect(stats.mergedCount).toBeGreaterThan(0);
    expect(stats.entriesAfter).toBe(stats.entriesBefore);

    expect(await getSupersededBy(expiredId)).toBe(null);
    expect(await getSupersededBy(dupA)).toBe(null);
    expect(await getSupersededBy(dupB)).toBe(null);

    const entrySources = await client.execute("SELECT COUNT(*) AS count FROM entry_sources");
    expect(asNumber(entrySources.rows[0]?.count)).toBe(0);
  });

  it("creates backup before consolidation", async () => {
    await insertTestEntry({
      content: "backup test entry",
      seed: 80,
    });
    await fs.writeFile(backupSourcePath, "backup-body", "utf8");

    const sourceStat = await fs.stat(backupSourcePath);
    const stats = await consolidateRules(client, backupSourcePath);
    const backupStat = await fs.stat(stats.backupPath);

    expect(stats.backupPath.startsWith(`${backupSourcePath}.pre-consolidate-`)).toBe(true);
    expect(backupStat.size).toBe(sourceStat.size);
  });

  it("creates a self-contained backup when DB uses WAL mode", async () => {
    const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-consolidate-wal-"));
    tempDirs.push(dbDir);
    const dbPath = path.join(dbDir, "knowledge.db");
    const fileClient = createClient({ url: `file:${dbPath}` });
    clients.push(fileClient);
    await initDb(fileClient);
    await fileClient.execute("PRAGMA journal_mode=WAL");

    await insertRawEntry(fileClient, { id: "wal-entry-1", content: "wal backup test 1" });
    await insertRawEntry(fileClient, { id: "wal-entry-2", content: "wal backup test 2" });

    const originalCountResult = await fileClient.execute("SELECT COUNT(*) AS count FROM entries");
    const originalCount = asNumber(originalCountResult.rows[0]?.count);
    expect(originalCount).toBe(2);

    const stats = await consolidateRules(fileClient, dbPath);
    const backupWalPath = `${stats.backupPath}-wal`;
    const backupShmPath = `${stats.backupPath}-shm`;
    await expect(fs.access(backupWalPath)).rejects.toThrow();
    await expect(fs.access(backupShmPath)).rejects.toThrow();

    const backupClient = createClient({ url: `file:${stats.backupPath}` });
    clients.push(backupClient);
    const backupCountResult = await backupClient.execute("SELECT COUNT(*) AS count FROM entries");
    const backupCount = asNumber(backupCountResult.rows[0]?.count);
    expect(backupCount).toBe(originalCount);
  });

  it("keeps vector index queries healthy after consolidation", async () => {
    await insertTestEntry({
      content: "vector dup A",
      subject: "Vector Subject",
      type: "fact",
      seed: 601,
    });
    await insertTestEntry({
      content: "vector dup B",
      subject: "Vector Subject",
      type: "fact",
      seed: 601,
    });
    await insertTestEntry({
      content: "vector stable",
      subject: "Vector Subject",
      type: "fact",
      seed: 602,
    });

    await consolidateRules(client, backupSourcePath);

    const vectorResult = await client.execute(`
      SELECT count(*) AS count
      FROM vector_top_k(
        'idx_entries_embedding',
        (SELECT embedding FROM entries WHERE embedding IS NOT NULL LIMIT 1),
        1
      )
    `);
    expect(asNumber(vectorResult.rows[0]?.count)).toBe(1);

    const shadowColumns = await client.execute("PRAGMA table_info(idx_entries_embedding_shadow)");
    const hasIdColumn = shadowColumns.rows.some((row) => asString(row.name) === "id");
    const countExpression = hasIdColumn ? "COUNT(id)" : "COUNT(rowid)";
    const shadowCounts = await client.execute(`
      SELECT COUNT(*) AS star_count, ${countExpression} AS id_count
      FROM idx_entries_embedding_shadow
    `);
    const starCount = asNumber(shadowCounts.rows[0]?.star_count);
    const idCount = asNumber(shadowCounts.rows[0]?.id_count);
    expect(starCount).toBe(idCount);
  });

  it("keeps only three most recent pre-consolidate backups", async () => {
    const backupDir = path.dirname(backupSourcePath);
    const backupBase = path.basename(backupSourcePath);
    const prefix = `${backupBase}.pre-consolidate-`;
    const staleBackups = [
      `${prefix}2025-01-01T00-00-01`,
      `${prefix}2025-01-01T00-00-02`,
      `${prefix}2025-01-01T00-00-03`,
      `${prefix}2025-01-01T00-00-04`,
      `${prefix}2025-01-01T00-00-05`,
    ];
    for (const fileName of staleBackups) {
      await fs.writeFile(path.join(backupDir, fileName), "stale-backup", "utf8");
    }

    const stats = await consolidateRules(client, backupSourcePath);
    const files = await fs.readdir(backupDir);
    const backups = files.filter((fileName) => fileName.startsWith(prefix)).sort().reverse();

    expect(backups).toHaveLength(3);
    expect(backups).toContain(path.basename(stats.backupPath));
  });

  it("returns correct stats shape", async () => {
    await insertTestEntry({
      content: "expiring entry",
      expiry: "temporary",
      daysOld: 20,
      seed: 90,
    });
    await insertTestEntry({
      content: "merge source A",
      subject: "Stats Subject",
      type: "fact",
      seed: 100,
      confirmations: 1,
    });
    await insertTestEntry({
      content: "merge source B",
      subject: "Stats Subject",
      type: "fact",
      seed: 100,
      confirmations: 2,
    });
    await insertTestEntry({
      content: "stable entry",
      expiry: "core",
      seed: 200,
    });

    const stats = await consolidateRules(client, backupSourcePath);

    expect(typeof stats.entriesBefore).toBe("number");
    expect(typeof stats.entriesAfter).toBe("number");
    expect(typeof stats.expiredCount).toBe("number");
    expect(typeof stats.mergedCount).toBe("number");
    expect(typeof stats.orphanedRelationsCleaned).toBe("number");
    expect(typeof stats.backupPath).toBe("string");
    expect(stats.entriesAfter).toBe(stats.entriesBefore - stats.expiredCount - stats.mergedCount);
  });

  it("JSON output is valid", async () => {
    await insertTestEntry({
      content: "json serializable entry",
      seed: 110,
    });

    const stats = await consolidateRules(client, backupSourcePath);
    const serialized = JSON.stringify(stats);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;

    expect(typeof serialized).toBe("string");
    expect(typeof parsed.entriesBefore).toBe("number");
    expect(typeof parsed.entriesAfter).toBe("number");
    expect(typeof parsed.backupPath).toBe("string");
  });
});
