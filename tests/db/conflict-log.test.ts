import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../../src/db/client.js";
import {
  getConflictStats,
  getPendingConflicts,
  logConflict,
  resolveConflictLog,
} from "../../src/db/conflict-log.js";

function toStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

describe("conflict-log", () => {
  const clients: Client[] = [];

  afterEach(() => {
    while (clients.length > 0) {
      clients.pop()?.close();
    }
  });

  function makeClient(): Client {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    return client;
  }

  it("logConflict inserts a row and returns a UUID", async () => {
    const client = makeClient();
    await initDb(client);

    const id = await logConflict(client, "entry-new", "entry-old", "contradicts", 0.82, "pending");
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const row = await client.execute({
      sql: "SELECT entry_a, entry_b, relation, confidence, resolution, resolved_at FROM conflict_log WHERE id = ?",
      args: [id],
    });

    expect(toStringValue(row.rows[0]?.entry_a)).toBe("entry-new");
    expect(toStringValue(row.rows[0]?.entry_b)).toBe("entry-old");
    expect(toStringValue(row.rows[0]?.relation)).toBe("contradicts");
    expect(Number(row.rows[0]?.confidence)).toBeCloseTo(0.82);
    expect(toStringValue(row.rows[0]?.resolution)).toBe("pending");
    expect(row.rows[0]?.resolved_at).toBeNull();
  });

  it("getPendingConflicts returns only resolution=pending entries", async () => {
    const client = makeClient();
    await initDb(client);

    const pendingA = await logConflict(client, "entry-1", "entry-2", "contradicts", 0.8, "pending");
    await logConflict(client, "entry-3", "entry-4", "coexists", 0.9, "coexist");
    const pendingB = await logConflict(client, "entry-5", "entry-6", "supersedes", 0.91, "pending");

    await client.execute({
      sql: "UPDATE conflict_log SET created_at = ? WHERE id = ?",
      args: ["2026-02-26T01:00:00.000Z", pendingA],
    });
    await client.execute({
      sql: "UPDATE conflict_log SET created_at = ? WHERE id = ?",
      args: ["2026-02-26T03:00:00.000Z", pendingB],
    });

    const pending = await getPendingConflicts(client);
    expect(pending.map((entry) => entry.id)).toEqual([pendingB, pendingA]);
    expect(pending.every((entry) => entry.resolution === "pending")).toBe(true);
  });

  it("getPendingConflicts returns empty array when none pending", async () => {
    const client = makeClient();
    await initDb(client);

    await logConflict(client, "entry-1", "entry-2", "coexists", 0.7, "coexist");

    const pending = await getPendingConflicts(client);
    expect(pending).toEqual([]);
  });

  it("resolveConflictLog updates resolution and sets resolved_at", async () => {
    const client = makeClient();
    await initDb(client);

    const id = await logConflict(client, "entry-1", "entry-2", "contradicts", 0.71, "pending");
    await resolveConflictLog(client, id, "keep-new");

    const row = await client.execute({
      sql: "SELECT resolution, resolved_at FROM conflict_log WHERE id = ?",
      args: [id],
    });

    expect(toStringValue(row.rows[0]?.resolution)).toBe("keep-new");
    expect(toStringValue(row.rows[0]?.resolved_at)).not.toBe("");
  });

  it("getConflictStats returns correct counts", async () => {
    const client = makeClient();
    await initDb(client);

    await logConflict(client, "entry-1", "entry-2", "supersedes", 0.92, "auto-superseded");
    await logConflict(client, "entry-3", "entry-4", "coexists", 0.9, "coexist");
    await logConflict(client, "entry-5", "entry-6", "contradicts", 0.7, "pending");
    await logConflict(client, "entry-7", "entry-8", "contradicts", 0.74, "keep-old");

    const stats = await getConflictStats(client);
    expect(stats).toEqual({
      total: 4,
      pending: 1,
      autoResolved: 2,
      userResolved: 1,
    });
  });

  it("multiple conflicts with mixed resolutions return correct stats", async () => {
    const client = makeClient();
    await initDb(client);

    await logConflict(client, "a1", "b1", "supersedes", 0.95, "auto-superseded");
    await logConflict(client, "a2", "b2", "coexists", 0.88, "coexist");
    await logConflict(client, "a3", "b3", "contradicts", 0.73, "pending");
    await logConflict(client, "a4", "b4", "contradicts", 0.7, "pending");
    await logConflict(client, "a5", "b5", "contradicts", 0.84, "keep-new");
    await logConflict(client, "a6", "b6", "contradicts", 0.84, "keep-old");
    await logConflict(client, "a7", "b7", "contradicts", 0.84, "keep-both");

    const stats = await getConflictStats(client);
    expect(stats).toEqual({
      total: 7,
      pending: 2,
      autoResolved: 2,
      userResolved: 3,
    });
  });
});
