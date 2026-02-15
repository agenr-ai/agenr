import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { closeDb, getDb, initDb } from "../../src/db/client.js";

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
});

