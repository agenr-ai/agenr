import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runDbCheckCommand,
  runDbExportCommand,
  runDbPathCommand,
  runDbRebuildIndexCommand,
  runDbResetCommand,
  runDbStatsCommand,
  runDbVersionCommand,
} from "../../src/commands/db.js";
import { initDb } from "../../src/db/client.js";
import { APP_VERSION } from "../../src/version.js";

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
        id, type, subject, content, importance, expiry, scope, source_file, source_context, created_at, updated_at, superseded_by
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
  const embedding = Array.from({ length: 1024 }, (_, i) => (i % 97) / 97);

  await client.execute({
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
    expect(stats.byPlatform.some((row) => row.platform === "(untagged)" && row.count === 2)).toBe(true);
    expect(stats.topTags.some((row) => row.tag === "alpha")).toBe(true);
    expect(stats.oldest).toBeTruthy();
    expect(stats.newest).toBeTruthy();
  });

  it("reports platform breakdown in stats", async () => {
    const client = createTestClient();
    await initDb(client);
    await seedEntry(client, { id: "a", type: "fact", subject: "Jim", content: "A", tag: "alpha" });
    await seedEntry(client, { id: "b", type: "decision", subject: "Jim", content: "B", tag: "beta" });
    await client.execute({ sql: "UPDATE entries SET platform = ? WHERE id = ?", args: ["openclaw", "a"] });

    const stats = await runDbStatsCommand({}, makeDeps(client));
    expect(stats.byPlatform.some((row) => row.platform === "openclaw" && row.count === 1)).toBe(true);
    expect(stats.byPlatform.some((row) => row.platform === "(untagged)" && row.count === 1)).toBe(true);
  });

  it("reports project breakdown in stats", async () => {
    const client = createTestClient();
    await initDb(client);
    await seedEntry(client, { id: "a", type: "fact", subject: "Jim", content: "A", tag: "alpha" });
    await seedEntry(client, { id: "b", type: "decision", subject: "Jim", content: "B", tag: "beta" });
    await client.execute({ sql: "UPDATE entries SET project = ? WHERE id = ?", args: ["agenr", "a"] });

    const stats = await runDbStatsCommand({}, makeDeps(client));
    expect(stats.byProject.some((row) => row.project === "agenr" && row.count === 1)).toBe(true);
    expect(stats.byProject.some((row) => row.project === "(untagged)" && row.count === 1)).toBe(true);
  });

  it("db stats supports --platform filter", async () => {
    const client = createTestClient();
    await initDb(client);
    await seedEntry(client, { id: "open-1", type: "fact", subject: "Jim", content: "OpenClaw", tag: "openclaw-tag" });
    await seedEntry(client, { id: "codex-1", type: "decision", subject: "Jim", content: "Codex", tag: "codex-tag" });
    await seedEntry(client, { id: "untagged-1", type: "fact", subject: "Jim", content: "Untagged", tag: "untagged-tag" });
    await client.execute({ sql: "UPDATE entries SET platform = ? WHERE id = ?", args: ["openclaw", "open-1"] });
    await client.execute({ sql: "UPDATE entries SET platform = ? WHERE id = ?", args: ["codex", "codex-1"] });

    const stats = await runDbStatsCommand({ platform: "openclaw" }, makeDeps(client));
    expect(stats.total).toBe(1);
    expect(stats.byType).toEqual([{ type: "fact", count: 1 }]);
    expect(stats.byPlatform).toHaveLength(3);
    expect(stats.byPlatform).toEqual(
      expect.arrayContaining([
        { platform: "openclaw", count: 1 },
        { platform: "codex", count: 1 },
        { platform: "(untagged)", count: 1 },
      ]),
    );
    expect(stats.topTags).toEqual([{ tag: "openclaw-tag", count: 1 }]);
  });

  it("db stats supports --project filter (includes NULL entries by default)", async () => {
    const client = createTestClient();
    await initDb(client);
    await seedEntry(client, { id: "agenr-1", type: "fact", subject: "Jim", content: "Agenr", tag: "agenr-tag" });
    await seedEntry(client, { id: "openclaw-1", type: "fact", subject: "Jim", content: "OpenClaw", tag: "openclaw-tag" });
    await seedEntry(client, { id: "untagged-1", type: "fact", subject: "Jim", content: "Untagged", tag: "untagged-tag" });
    await client.execute({ sql: "UPDATE entries SET project = ? WHERE id = ?", args: ["agenr", "agenr-1"] });
    await client.execute({ sql: "UPDATE entries SET project = ? WHERE id = ?", args: ["openclaw", "openclaw-1"] });

    const stats = await runDbStatsCommand({ project: "agenr" }, makeDeps(client));
    expect(stats.total).toBe(2);
    expect(stats.byType).toEqual([{ type: "fact", count: 2 }]);
    expect(stats.topTags).toEqual(
      expect.arrayContaining([
        { tag: "agenr-tag", count: 1 },
        { tag: "untagged-tag", count: 1 },
      ]),
    );
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

  it("resets DB by dropping data and reinitializing schema", async () => {
    const client = createTestClient();
    await initDb(client);
    await seedEntry(client, { id: "a", type: "fact", subject: "Jim", content: "A", tag: "alpha" });

    await runDbResetCommand({ confirm: true }, makeDeps(client));

    const entriesResult = await client.execute("SELECT COUNT(*) AS count FROM entries");
    expect(Number((entriesResult.rows[0] as { count?: unknown } | undefined)?.count ?? 0)).toBe(0);

    const schemaResult = await client.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)",
      args: ["entries", "ingest_log", "entry_sources"],
    });
    expect(schemaResult.rows.map((row) => String((row as { name?: unknown }).name)).sort()).toEqual([
      "entries",
      "entry_sources",
      "ingest_log",
    ]);
  });

  it("keeps full reset in dry-run mode when --confirm-reset is not provided", async () => {
    const client = createTestClient();
    await initDb(client);
    const backupDbFn = vi.fn(async () => "/tmp/knowledge.db.backup");
    const resetDbFn = vi.fn(async () => undefined);

    const result = await runDbResetCommand(
      { full: true, confirm: true },
      { ...makeDeps(client), backupDbFn, resetDbFn },
    );

    expect(result.exitCode).toBe(0);
    expect(backupDbFn).not.toHaveBeenCalled();
    expect(resetDbFn).not.toHaveBeenCalled();
  });

  it("uses injected resetDbFn for non-full reset", async () => {
    const client = createTestClient();
    await initDb(client);
    await seedEntry(client, { id: "inject-1", type: "fact", subject: "Jim", content: "A", tag: "alpha" });
    const resetDbFn = vi.fn(async () => undefined);

    const result = await runDbResetCommand({ confirm: true }, { ...makeDeps(client), resetDbFn });

    expect(result.exitCode).toBe(0);
    expect(resetDbFn).toHaveBeenCalledTimes(1);
    expect(resetDbFn).toHaveBeenCalledWith(client);

    const entriesResult = await client.execute("SELECT COUNT(*) AS count FROM entries");
    expect(Number((entriesResult.rows[0] as { count?: unknown } | undefined)?.count ?? 0)).toBe(1);
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

  it("db export supports --platform filter", async () => {
    const client = createTestClient();
    await initDb(client);
    await seedEntry(client, { id: "open-1", type: "fact", subject: "Jim", content: "OpenClaw", tag: "keep" });
    await seedEntry(client, { id: "codex-1", type: "fact", subject: "Jim", content: "Codex", tag: "keep" });
    await client.execute({ sql: "UPDATE entries SET platform = ? WHERE id = ?", args: ["openclaw", "open-1"] });
    await client.execute({ sql: "UPDATE entries SET platform = ? WHERE id = ?", args: ["codex", "codex-1"] });

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exported = await runDbExportCommand({ json: true, platform: "openclaw" }, makeDeps(client));

    expect(exported).toHaveLength(1);
    expect(exported[0]?.content).toBe("OpenClaw");

    const jsonOutput = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(jsonOutput).toContain("OpenClaw");
    expect(jsonOutput).not.toContain("Codex");
  });

  it("prints resolved db path", async () => {
    const client = createTestClient();
    await initDb(client);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const dbPath = await runDbPathCommand({}, makeDeps(client));
    expect(dbPath).toBe(":memory:");
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it("prints db version info when _meta exists", async () => {
    const client = createTestClient();
    await initDb(client);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const info = await runDbVersionCommand({}, makeDeps(client));
    const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");

    expect(info.schemaVersion).toBe(APP_VERSION);
    expect(output).toContain(`agenr v${APP_VERSION}`);
    expect(output).toContain(`Database schema version: ${APP_VERSION}`);
    expect(output).toContain("Database created:");
    expect(output).toContain("Last migration:");
  });

  it("prints unknown version for pre-0.4.0 DB without _meta", async () => {
    const client = createTestClient();
    await client.execute(`
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        subject TEXT NOT NULL,
        content TEXT NOT NULL,
        importance INTEGER NOT NULL,
        expiry TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const info = await runDbVersionCommand({}, makeDeps(client));
    const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");

    expect(info.schemaVersion).toBeNull();
    expect(output).toContain("Database schema version: unknown (pre-0.4.0)");

    const master = await client.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_meta' LIMIT 1",
      args: [],
    });
    expect(master.rows.length).toBe(0);
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
