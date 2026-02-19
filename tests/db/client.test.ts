import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { backupDb, closeDb, getDb, initDb, walCheckpoint } from "../../src/db/client.js";

function readPragmaValue(row: unknown): number {
  if (!row || typeof row !== "object") {
    throw new Error("Expected PRAGMA query to return a row object.");
  }

  const value = Object.values(row as Record<string, unknown>)[0];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  throw new Error(`Expected PRAGMA query to return a numeric value, received: ${String(value)}`);
}

describe("db client", () => {
  const clients: Client[] = [];
  let tempDir: string | null = null;

  afterEach(async () => {
    while (clients.length > 0) {
      const client = clients.pop();
      if (client) {
        closeDb(client);
      }
    }
    vi.restoreAllMocks();

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("enables WAL journal mode for file-backed databases", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "agenr-db-"));
    const dbPath = path.join(tempDir, "knowledge.db");

    const client = getDb(dbPath);
    clients.push(client);
    await initDb(client);

    const result = await client.execute("PRAGMA journal_mode");
    const firstRow = result.rows[0] as Record<string, unknown> | undefined;
    const mode =
      (firstRow?.journal_mode ?? firstRow?.["journal_mode"]) ??
      (firstRow ? Object.values(firstRow)[0] : undefined);

    expect(String(mode).toLowerCase()).toBe("wal");
  });

  it("sets busy_timeout for file-backed databases", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "agenr-db-"));
    const dbPath = path.join(tempDir, "knowledge.db");

    const client = getDb(dbPath);
    clients.push(client);
    await initDb(client);

    const result = await client.execute("PRAGMA busy_timeout");
    const timeoutMs = readPragmaValue(result.rows[0]);
    expect(timeoutMs).toBe(3000);
  });

  it("sets wal_autocheckpoint for file-backed databases during init", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "agenr-db-"));
    const dbPath = path.join(tempDir, "knowledge.db");

    const client = getDb(dbPath);
    clients.push(client);
    await initDb(client);

    const result = await client.execute("PRAGMA wal_autocheckpoint");
    const autoCheckpointPages = readPragmaValue(result.rows[0]);
    expect(autoCheckpointPages).toBe(1000);
  });

  it("does not set busy_timeout for in-memory databases", async () => {
    const client = getDb(":memory:");
    clients.push(client);

    const result = await client.execute("PRAGMA busy_timeout");
    const timeoutMs = readPragmaValue(result.rows[0]);
    expect(timeoutMs).toBe(0);
  });

  it("can run a WAL checkpoint after writes", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "agenr-db-"));
    const dbPath = path.join(tempDir, "knowledge.db");

    const client = getDb(dbPath);
    clients.push(client);
    await initDb(client);

    const modeResult = await client.execute("PRAGMA journal_mode");
    const firstRow = modeResult.rows[0] as Record<string, unknown> | undefined;
    const mode =
      (firstRow?.journal_mode ?? firstRow?.["journal_mode"]) ??
      (firstRow ? Object.values(firstRow)[0] : undefined);
    expect(String(mode).toLowerCase()).toBe("wal");

    await client.execute("CREATE TABLE IF NOT EXISTS wal_checkpoint_test (id INTEGER PRIMARY KEY, value TEXT)");
    await client.execute({ sql: "INSERT INTO wal_checkpoint_test (value) VALUES (?)", args: ["ok"] });

    await expect(walCheckpoint(client)).resolves.toBeUndefined();
  });

  it("fails WAL checkpoint when busy readers never clear", async () => {
    const execute = vi.fn(async () => ({
      rows: [{ busy: 1 }],
    }));
    const fakeClient = { execute } as unknown as Client;

    await expect(walCheckpoint(fakeClient)).rejects.toThrow("busy=1");
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it("creates a pre-reset backup file for file-backed databases", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "agenr-db-"));
    const dbPath = path.join(tempDir, "knowledge.db");

    const client = getDb(dbPath);
    clients.push(client);
    await initDb(client);

    await client.execute({
      sql: `
        INSERT INTO entries (
          id, type, subject, content, importance, expiry, scope, source_file, source_context, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        "entry-1",
        "fact",
        "subject",
        "content",
        5,
        "temporary",
        "private",
        "seed.jsonl",
        "test",
        "2026-02-19T00:00:00.000Z",
        "2026-02-19T00:00:00.000Z",
      ],
    });

    const backupPath = await backupDb(dbPath);
    const backupStat = await stat(backupPath);
    expect(backupStat.isFile()).toBe(true);
    expect(path.dirname(backupPath)).toBe(tempDir);
    expect(path.basename(backupPath)).toMatch(/^knowledge\.db\.backup-pre-reset-.+Z$/);

    const backupClient = getDb(backupPath);
    clients.push(backupClient);
    const rowResult = await backupClient.execute("SELECT COUNT(*) AS count FROM entries");
    const count = Number((rowResult.rows[0] as { count?: unknown } | undefined)?.count ?? 0);
    expect(count).toBe(1);
  });

  it("attempts to copy WAL/SHM sidecars and ignores missing sidecar files", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "agenr-db-"));
    const dbPath = path.join(tempDir, "knowledge.db");

    const client = getDb(dbPath);
    clients.push(client);
    await initDb(client);

    const originalCopyFile = fs.copyFile;
    const copyFileSpy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args: Parameters<typeof fs.copyFile>) => {
      const [source] = args;
      const sourcePath = String(source);
      if (sourcePath.endsWith("-wal") || sourcePath.endsWith("-shm")) {
        const error = new Error("missing sidecar") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      await originalCopyFile(...args);
    });

    const backupPath = await backupDb(dbPath);

    const copyCalls = copyFileSpy.mock.calls.map(([source, destination]) => [String(source), String(destination)]);
    expect(copyCalls).toContainEqual([dbPath, backupPath]);
    expect(copyCalls).toContainEqual([`${dbPath}-wal`, `${backupPath}-wal`]);
    expect(copyCalls).toContainEqual([`${dbPath}-shm`, `${backupPath}-shm`]);
  });

  it("rejects backupDb for in-memory databases", async () => {
    await expect(backupDb(":memory:")).rejects.toThrow("in-memory");
  });
});
