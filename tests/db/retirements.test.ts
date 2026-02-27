import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../../src/db/client.js";
import { strengthenCoRecallEdges } from "../../src/db/co-recall.js";
import { appendToLedger, applyLedger, loadLedger, retireEntries } from "../../src/db/retirements.js";
import { storeEntries } from "../../src/db/store.js";
import type { KnowledgeEntry, RetirementRecord } from "../../src/types.js";

const tempDirs: string[] = [];
const clients: Client[] = [];

function vector(): number[] {
  return [1, ...Array.from({ length: 1023 }, () => 0)];
}

async function mockEmbed(texts: string[]): Promise<number[][]> {
  return texts.map(() => vector());
}

async function makeTempDbPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-retirements-test-"));
  tempDirs.push(dir);
  return path.join(dir, "knowledge.db");
}

function makeClient(dbPath: string): Client {
  const client = createClient({ url: `file:${dbPath}` });
  clients.push(client);
  return client;
}

function makeEntry(subject: string, content: string): KnowledgeEntry {
  return {
    type: "fact",
    subject,
    content,
    importance: 6,
    expiry: "temporary",
    tags: [],
    source: {
      file: "retirements.test.jsonl",
      context: "test",
    },
  };
}

function ledgerPathForDb(dbPath: string): string {
  return path.join(path.dirname(dbPath), "retirements.json");
}

function makeRecord(overrides?: Partial<RetirementRecord>): RetirementRecord {
  return {
    id: "ret_test_1",
    created_at: "2026-02-19T00:00:00.000Z",
    subject_pattern: "Dead Project config",
    match_type: "exact",
    suppressed_contexts: ["session-start"],
    ...overrides,
  };
}

afterEach(async () => {
  while (clients.length > 0) {
    clients.pop()?.close();
  }
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("db retirements ledger", () => {
  it("loadLedger returns empty when retirements file is missing", async () => {
    const dbPath = await makeTempDbPath();
    const records = await loadLedger(dbPath);
    expect(records).toEqual([]);
  });

  it("appendToLedger creates file when missing and appends when present", async () => {
    const dbPath = await makeTempDbPath();
    const first = makeRecord({ id: "ret_a" });
    const second = makeRecord({ id: "ret_b", subject_pattern: "Dead Project notes" });

    await appendToLedger(first, dbPath);
    await appendToLedger(second, dbPath);

    const raw = await fs.readFile(ledgerPathForDb(dbPath), "utf8");
    const parsed = JSON.parse(raw) as { retirements?: RetirementRecord[] };
    expect(parsed.retirements?.map((item) => item.id)).toEqual(["ret_a", "ret_b"]);
  });

  it("applyLedger matches exact subject and marks entries retired with suppressed contexts", async () => {
    const dbPath = await makeTempDbPath();
    const client = makeClient(dbPath);
    await initDb(client);

    await storeEntries(
      client,
      [
        makeEntry("Dead Project config", "dead project config A"),
        makeEntry("Dead Project config", "dead project config B"),
      ],
      "sk-test",
      { force: true, embedFn: mockEmbed, dbPath },
    );

    await appendToLedger(makeRecord(), dbPath);
    const updated = await applyLedger(client, dbPath);
    expect(updated).toBe(2);

    const rows = await client.execute({
      sql: "SELECT retired, suppressed_contexts FROM entries WHERE subject = ?",
      args: ["Dead Project config"],
    });
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(Number((row as { retired?: unknown }).retired ?? 0)).toBe(1);
      expect(String((row as { suppressed_contexts?: unknown }).suppressed_contexts ?? "")).toContain("session-start");
    }
  });

  it("applyLedger matches contains subject patterns", async () => {
    const dbPath = await makeTempDbPath();
    const client = makeClient(dbPath);
    await initDb(client);

    await storeEntries(
      client,
      [
        makeEntry("Dead Project config", "dead config"),
        makeEntry("Dead Project notes", "dead notes"),
        makeEntry("Active Project notes", "active notes"),
      ],
      "sk-test",
      { force: true, embedFn: mockEmbed, dbPath },
    );

    await appendToLedger(
      makeRecord({
        match_type: "contains",
        subject_pattern: "Dead Project",
      }),
      dbPath,
    );

    const updated = await applyLedger(client, dbPath);
    expect(updated).toBe(2);

    const deadRows = await client.execute({
      sql: "SELECT COUNT(*) AS count FROM entries WHERE subject LIKE 'Dead Project%' AND retired = 1",
      args: [],
    });
    expect(Number((deadRows.rows[0] as { count?: unknown } | undefined)?.count ?? 0)).toBe(2);

    const activeRows = await client.execute({
      sql: "SELECT retired FROM entries WHERE subject = ?",
      args: ["Active Project notes"],
    });
    expect(Number((activeRows.rows[0] as { retired?: unknown } | undefined)?.retired ?? 0)).toBe(0);
  });

  it("applyLedger returns 0 when no entries match", async () => {
    const dbPath = await makeTempDbPath();
    const client = makeClient(dbPath);
    await initDb(client);

    await storeEntries(client, [makeEntry("Active Project", "still active")], "sk-test", {
      force: true,
      embedFn: mockEmbed,
      dbPath,
    });

    await appendToLedger(makeRecord({ subject_pattern: "No Match Subject" }), dbPath);
    const updated = await applyLedger(client, dbPath);
    expect(updated).toBe(0);
  });

  it("retireEntries by entryId retires one entry and sets suppressed_contexts", async () => {
    const dbPath = await makeTempDbPath();
    const client = makeClient(dbPath);
    await initDb(client);

    await storeEntries(client, [makeEntry("One-off subject", "one-off content")], "sk-test", {
      force: true,
      embedFn: mockEmbed,
      dbPath,
    });

    const row = await client.execute({
      sql: "SELECT id FROM entries WHERE subject = ? LIMIT 1",
      args: ["One-off subject"],
    });
    const entryId = String((row.rows[0] as { id?: unknown } | undefined)?.id ?? "");
    expect(entryId).toBeTruthy();

    const result = await retireEntries({
      entryId,
      reason: "obsolete",
      db: client,
      dbPath,
      writeLedger: false,
    });
    expect(result.count).toBe(1);

    const retired = await client.execute({
      sql: "SELECT retired, suppressed_contexts, retired_reason FROM entries WHERE id = ?",
      args: [entryId],
    });
    expect(Number((retired.rows[0] as { retired?: unknown } | undefined)?.retired ?? 0)).toBe(1);
    expect(String((retired.rows[0] as { suppressed_contexts?: unknown } | undefined)?.suppressed_contexts ?? "")).toContain(
      "session-start",
    );
    expect(String((retired.rows[0] as { retired_reason?: unknown } | undefined)?.retired_reason ?? "")).toBe("obsolete");
  });

  it("retireEntries by subjectPattern bulk-updates matching entries", async () => {
    const dbPath = await makeTempDbPath();
    const client = makeClient(dbPath);
    await initDb(client);

    await storeEntries(
      client,
      [
        makeEntry("Legacy Project", "legacy A"),
        makeEntry("Legacy Project", "legacy B"),
        makeEntry("Current Project", "current"),
      ],
      "sk-test",
      { force: true, embedFn: mockEmbed, dbPath },
    );

    const result = await retireEntries({
      subjectPattern: "Legacy Project",
      matchType: "exact",
      reason: "replaced",
      db: client,
      dbPath,
      writeLedger: false,
    });
    expect(result.count).toBe(2);

    const legacyCount = await client.execute({
      sql: "SELECT COUNT(*) AS count FROM entries WHERE subject = ? AND retired = 1",
      args: ["Legacy Project"],
    });
    expect(Number((legacyCount.rows[0] as { count?: unknown } | undefined)?.count ?? 0)).toBe(2);
  });

  it("retireEntries with writeLedger=true appends to retirements ledger", async () => {
    const dbPath = await makeTempDbPath();
    const client = makeClient(dbPath);
    await initDb(client);

    await storeEntries(client, [makeEntry("Persist Subject", "persist me")], "sk-test", {
      force: true,
      embedFn: mockEmbed,
      dbPath,
    });

    await retireEntries({
      subjectPattern: "Persist Subject",
      matchType: "exact",
      reason: "retired permanently",
      writeLedger: true,
      db: client,
      dbPath,
    });

    const records = await loadLedger(dbPath);
    expect(records).toHaveLength(1);
    expect(records[0]?.subject_pattern).toBe("Persist Subject");
  });

  it("retireEntries with writeLedger=false does not write ledger file", async () => {
    const dbPath = await makeTempDbPath();
    const client = makeClient(dbPath);
    await initDb(client);

    await storeEntries(client, [makeEntry("No Persist Subject", "do not persist")], "sk-test", {
      force: true,
      embedFn: mockEmbed,
      dbPath,
    });

    await retireEntries({
      subjectPattern: "No Persist Subject",
      matchType: "exact",
      reason: "one-off",
      writeLedger: false,
      db: client,
      dbPath,
    });

    await expect(fs.stat(ledgerPathForDb(dbPath))).rejects.toThrow();
  });

  it("retiring an entry deletes co-recall edges referencing that entry", async () => {
    const dbPath = await makeTempDbPath();
    const client = makeClient(dbPath);
    await initDb(client);

    await storeEntries(client, [makeEntry("Edge A", "edge-a"), makeEntry("Edge B", "edge-b")], "sk-test", {
      force: true,
      embedFn: mockEmbed,
      dbPath,
    });

    const entries = await client.execute({
      sql: "SELECT id, subject FROM entries WHERE subject IN (?, ?) ORDER BY subject ASC",
      args: ["Edge A", "Edge B"],
    });
    const edgeAId = String((entries.rows[0] as { id?: unknown } | undefined)?.id ?? "");
    const edgeBId = String((entries.rows[1] as { id?: unknown } | undefined)?.id ?? "");
    expect(edgeAId).toBeTruthy();
    expect(edgeBId).toBeTruthy();

    await strengthenCoRecallEdges(client, [edgeAId, edgeBId], "2026-02-27T00:00:00.000Z");

    const before = await client.execute("SELECT COUNT(*) AS count FROM co_recall_edges");
    expect(Number((before.rows[0] as { count?: unknown } | undefined)?.count ?? 0)).toBe(1);

    const retired = await retireEntries({
      entryId: edgeAId,
      reason: "cleanup",
      writeLedger: false,
      db: client,
      dbPath,
    });
    expect(retired.count).toBe(1);

    const after = await client.execute("SELECT COUNT(*) AS count FROM co_recall_edges");
    expect(Number((after.rows[0] as { count?: unknown } | undefined)?.count ?? 0)).toBe(0);
  });
});
