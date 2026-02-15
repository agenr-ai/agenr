import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runDbCheckCommand,
  runDbExportCommand,
  runDbPathCommand,
  runDbRebuildIndexCommand,
  runDbResetCommand,
  runDbStatsCommand,
} from "../../src/commands/db.js";
import { initDb } from "../../src/db/client.js";
import { hashText, storeEntries } from "../../src/db/store.js";
import type { KnowledgeEntry } from "../../src/types.js";

function makeDeps(client: Client) {
  return {
    readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } })),
    getDbFn: vi.fn(() => client),
    initDbFn: vi.fn(async () => undefined),
    closeDbFn: vi.fn(() => undefined),
  };
}

function to512(head: number[]): number[] {
  return [...head, ...Array.from({ length: 509 }, () => 0)];
}

function vectorForText(text: string): number[] {
  if (text.includes("vec-a")) return to512([1, 0, 0]);
  if (text.includes("vec-b")) return to512([0.9, 0.1, 0]);
  return to512([0.2, 0.2, 0.9]);
}

async function mockEmbed(texts: string[]): Promise<number[][]> {
  return texts.map((text) => vectorForText(text));
}

function makeEntry(content: string): KnowledgeEntry {
  return {
    type: "fact",
    subject: "Jim",
    content,
    confidence: "high",
    expiry: "temporary",
    tags: ["test"],
    source: {
      file: "db-command.test.ts",
      context: "unit test",
    },
  };
}

async function seedEntry(client: Client, params: {
  id: string;
  type: string;
  subject: string;
  content: string;
  tag?: string;
  supersededBy?: string | null;
}): Promise<void> {
  const now = "2026-02-14T00:00:00.000Z";
  await client.execute({
    sql: `
      INSERT INTO entries (
        id, type, subject, content, confidence, expiry, scope, source_file, source_context, created_at, updated_at, superseded_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      params.id,
      params.type,
      params.subject,
      params.content,
      "high",
      "temporary",
      "private",
      "seed.jsonl",
      "test",
      now,
      now,
      params.supersededBy ?? null,
    ],
  });

  if (params.tag) {
    await client.execute({
      sql: "INSERT INTO tags (entry_id, tag) VALUES (?, ?)",
      args: [params.id, params.tag],
    });
  }
}

describe("db command", () => {
  const clients: Client[] = [];

  afterEach(() => {
    while (clients.length > 0) {
      clients.pop()?.close();
    }
    vi.restoreAllMocks();
  });

  function createTestClient(): Client {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    return client;
  }

  it("reports stats for populated database", async () => {
    const client = createTestClient();
    await initDb(client);
    await seedEntry(client, { id: "a", type: "fact", subject: "Jim", content: "A", tag: "alpha" });
    await seedEntry(client, { id: "b", type: "decision", subject: "Jim", content: "B", tag: "beta" });

    const stats = await runDbStatsCommand({}, makeDeps(client));
    expect(stats.total).toBe(2);
    expect(stats.byType.some((row) => row.type === "fact" && row.count === 1)).toBe(true);
    expect(stats.topTags.some((row) => row.tag === "alpha")).toBe(true);
    expect(stats.oldest).toBeTruthy();
    expect(stats.newest).toBeTruthy();
  });

  it("reports zero stats for empty database", async () => {
    const client = createTestClient();
    await initDb(client);

    const stats = await runDbStatsCommand({}, makeDeps(client));
    expect(stats.total).toBe(0);
    expect(stats.byType).toEqual([]);
    expect(stats.topTags).toEqual([]);
  });

  it("requires --confirm for reset", async () => {
    const client = createTestClient();
    await initDb(client);
    await expect(runDbResetCommand({ confirm: false }, makeDeps(client))).rejects.toThrow("--confirm");
  });

  it("exports only non-superseded entries as json and markdown", async () => {
    const client = createTestClient();
    await initDb(client);
    await seedEntry(client, { id: "active-1", type: "fact", subject: "Jim", content: "Keep me", tag: "keep" });
    await seedEntry(client, {
      id: "old-1",
      type: "fact",
      subject: "Jim",
      content: "Superseded",
      tag: "drop",
      supersededBy: "active-1",
    });

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const jsonEntries = await runDbExportCommand({ json: true }, makeDeps(client));
    expect(jsonEntries).toHaveLength(1);
    expect(jsonEntries[0]?.id).toBe("active-1");

    const jsonOutput = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(jsonOutput).toContain("Keep me");
    expect(jsonOutput).not.toContain("Superseded");

    stdoutSpy.mockClear();
    await runDbExportCommand({ md: true }, makeDeps(client));
    const mdOutput = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(mdOutput).toContain("# Agenr Knowledge Export");
    expect(mdOutput).toContain("Keep me");
    expect(mdOutput).not.toContain("Superseded");
  });

  it("prints resolved db path", async () => {
    const client = createTestClient();
    await initDb(client);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const dbPath = await runDbPathCommand({}, makeDeps(client));
    expect(dbPath).toBe(":memory:");
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it("rebuild-index recreates missing vector index", async () => {
    const client = createTestClient();
    await initDb(client);

    await storeEntries(client, [makeEntry("Item A vec-a"), makeEntry("Item B vec-b")], "sk-test", {
      sourceFile: "db-command.test.ts",
      ingestContentHash: hashText("rebuild-index"),
      embedFn: mockEmbed,
      force: true,
    });

    await client.execute("DROP INDEX IF EXISTS idx_entries_embedding");
    await expect(
      client.execute(`
        SELECT count(*) AS count
        FROM vector_top_k(
          'idx_entries_embedding',
          (SELECT embedding FROM entries WHERE embedding IS NOT NULL LIMIT 1),
          1
        )
      `),
    ).rejects.toBeTruthy();

    const result = await runDbRebuildIndexCommand({}, makeDeps(client));
    expect(result.entriesIndexed).toBe(2);

    const verify = await client.execute(`
      SELECT count(*) AS count
      FROM vector_top_k(
        'idx_entries_embedding',
        (SELECT embedding FROM entries WHERE embedding IS NOT NULL LIMIT 1),
        1
      )
    `);
    expect(Number((verify.rows[0] as { count?: unknown } | undefined)?.count)).toBe(1);
  });

  it("db check passes on healthy database", async () => {
    const client = createTestClient();
    await initDb(client);

    await storeEntries(client, [makeEntry("Item A vec-a")], "sk-test", {
      sourceFile: "db-command.test.ts",
      ingestContentHash: hashText("check-ok"),
      embedFn: mockEmbed,
      force: true,
    });

    const result = await runDbCheckCommand({}, makeDeps(client));
    expect(result.quickCheckOk).toBe(true);
    expect(result.vectorOk).toBe(true);
    expect(result.entriesWithEmbedding).toBe(1);
  });

  it("db check fails when vector index is missing", async () => {
    const client = createTestClient();
    await initDb(client);

    await storeEntries(client, [makeEntry("Item A vec-a")], "sk-test", {
      sourceFile: "db-command.test.ts",
      ingestContentHash: hashText("check-missing"),
      embedFn: mockEmbed,
      force: true,
    });

    await client.execute("DROP INDEX IF EXISTS idx_entries_embedding");
    await expect(runDbCheckCommand({}, makeDeps(client))).rejects.toThrow(/vector/i);
  });

  it("db check succeeds on empty database", async () => {
    const client = createTestClient();
    await initDb(client);

    const result = await runDbCheckCommand({}, makeDeps(client));
    expect(result.quickCheckOk).toBe(true);
    expect(result.vectorOk).toBe(true);
    expect(result.entriesWithEmbedding).toBe(0);
  });
});
