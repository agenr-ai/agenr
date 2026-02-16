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

function makeDeps(client: Client) {
  return {
    readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } })),
    getDbFn: vi.fn(() => client),
    initDbFn: vi.fn(async () => undefined),
    closeDbFn: vi.fn(() => undefined),
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

async function seedEmbeddingEntry(client: Client, params: {
  id: string;
  type: string;
  subject: string;
  content: string;
}): Promise<void> {
  const now = "2026-02-14T00:00:00.000Z";
  const embedding = Array.from({ length: 512 }, (_, i) => (i % 97) / 97);

  await client.execute({
    sql: `
      INSERT INTO entries (
        id,
        type,
        subject,
        content,
        confidence,
        expiry,
        scope,
        source_file,
        source_context,
        embedding,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, vector32(?), ?, ?)
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
      JSON.stringify(embedding),
      now,
      now,
    ],
  });
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

  it("rebuild-index recreates a dropped index and returns embedding count", async () => {
    const client = createTestClient();
    await initDb(client);
    await seedEmbeddingEntry(client, { id: "e1", type: "fact", subject: "S", content: "A" });
    await seedEmbeddingEntry(client, { id: "e2", type: "fact", subject: "S", content: "B" });

    await client.execute("DROP INDEX IF EXISTS idx_entries_embedding");

    const before = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_entries_embedding'",
    );
    expect(before.rows).toHaveLength(0);

    const result = await runDbRebuildIndexCommand({}, makeDeps(client));
    expect(result.exitCode).toBe(0);
    expect(result.embeddingCount).toBe(2);

    const after = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_entries_embedding'",
    );
    expect(after.rows).toHaveLength(1);

    const verify = await client.execute(`
      SELECT count(*) AS count
      FROM vector_top_k(
        'idx_entries_embedding',
        (SELECT embedding FROM entries WHERE embedding IS NOT NULL LIMIT 1),
        1
      )
    `);
    const count = Number((verify.rows[0] as { count?: unknown } | undefined)?.count ?? 0);
    expect(count).toBe(1);
  });

  it("db check passes on healthy DB", async () => {
    const client = createTestClient();
    await initDb(client);
    await seedEmbeddingEntry(client, { id: "e1", type: "fact", subject: "S", content: "A" });

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const result = await runDbCheckCommand({}, makeDeps(client));
    expect(result.exitCode).toBe(0);
    expect(result.embeddingCount).toBe(1);
    expect(stdoutSpy.mock.calls.map((call) => String(call[0])).join("")).toContain("DB check ok (1 entries with embeddings)");
  });

  it("db check fails when index is dropped", async () => {
    const client = createTestClient();
    await initDb(client);
    await seedEmbeddingEntry(client, { id: "e1", type: "fact", subject: "S", content: "A" });

    await client.execute("DROP INDEX IF EXISTS idx_entries_embedding");

    const result = await runDbCheckCommand({}, makeDeps(client));
    expect(result.exitCode).toBe(1);
  });

  it("db check succeeds on empty DB", async () => {
    const client = createTestClient();
    await initDb(client);

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const result = await runDbCheckCommand({}, makeDeps(client));
    expect(result.exitCode).toBe(0);
    expect(result.embeddingCount).toBe(0);
    expect(stdoutSpy.mock.calls.map((call) => String(call[0])).join("")).toContain("DB check ok (empty)");
  });

  it("db check filters libsql vector index false positives in quick_check", async () => {
    const fakeClient = {
      execute: vi.fn(async (arg: unknown) => {
        const sql = typeof arg === "string" ? arg : String((arg as { sql?: unknown } | undefined)?.sql ?? "");
        if (sql.includes("PRAGMA quick_check")) {
          return {
            rows: [{ quick_check: "wrong # of entries in index idx_entries_embedding" }, { quick_check: "ok" }],
          };
        }
        if (sql.includes("SELECT COUNT(*) AS count FROM entries WHERE embedding IS NOT NULL")) {
          return { rows: [{ count: 0 }] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    } as unknown as Client;

    const deps = {
      readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } })),
      getDbFn: vi.fn(() => fakeClient),
      initDbFn: vi.fn(async () => undefined),
      closeDbFn: vi.fn(() => undefined),
    };

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const result = await runDbCheckCommand({}, deps);
    expect(result.exitCode).toBe(0);
    expect(stdoutSpy.mock.calls.map((call) => String(call[0])).join("")).toContain("DB check ok (empty)");
  });
});
