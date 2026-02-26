import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { handleConflictsUiRequest } from "../../src/commands/conflicts-ui.js";
import { initDb } from "../../src/db/client.js";

interface EntrySeed {
  id: string;
  type: string;
  subject: string;
  content: string;
  importance?: number;
  subjectKey?: string | null;
  createdAt?: string;
}

interface ConflictSeed {
  id: string;
  entryA: string;
  entryB: string;
  relation: string;
  confidence?: number;
  resolution: string;
  createdAt?: string;
  resolvedAt?: string | null;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

describe("conflicts-ui command API routes", () => {
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

  async function seedEntry(db: Client, seed: EntrySeed): Promise<void> {
    const createdAt = seed.createdAt ?? "2026-02-26T00:00:00.000Z";
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
          subject_key,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        seed.id,
        seed.type,
        seed.subject,
        seed.content,
        seed.importance ?? 6,
        "permanent",
        "private",
        "conflicts-ui.test",
        "test",
        seed.subjectKey ?? null,
        createdAt,
        createdAt,
      ],
    });
  }

  async function seedConflict(db: Client, seed: ConflictSeed): Promise<void> {
    await db.execute({
      sql: `
        INSERT INTO conflict_log (
          id,
          entry_a,
          entry_b,
          relation,
          confidence,
          resolution,
          resolved_at,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        seed.id,
        seed.entryA,
        seed.entryB,
        seed.relation,
        seed.confidence ?? 0.8,
        seed.resolution,
        seed.resolvedAt ?? null,
        seed.createdAt ?? "2026-02-26T00:00:00.000Z",
      ],
    });
  }

  async function handleRequest(
    db: Client,
    method: string,
    routePath: string,
    body?: unknown,
  ): Promise<{ status: number; data: unknown }> {
    const response = await handleConflictsUiRequest(
      db,
      method,
      routePath,
      body === undefined ? undefined : JSON.stringify(body),
    );
    const contentType = response.headers["content-type"] ?? "";
    if (contentType.includes("application/json")) {
      return {
        status: response.status,
        data: JSON.parse(response.body) as unknown,
      };
    }
    return {
      status: response.status,
      data: response.body,
    };
  }

  it("GET /api/conflicts returns pending conflicts with entry data", async () => {
    const db = makeClient();
    await initDb(db);

    await seedEntry(db, {
      id: "entry-a",
      type: "fact",
      subject: "A",
      content: "Alpha fact",
      importance: 7,
      subjectKey: "alpha/key",
      createdAt: "2026-02-26T01:00:00.000Z",
    });
    await seedEntry(db, {
      id: "entry-b",
      type: "fact",
      subject: "B",
      content: "Beta fact",
      importance: 6,
      subjectKey: "beta/key",
      createdAt: "2026-02-26T02:00:00.000Z",
    });
    await seedEntry(db, {
      id: "entry-c",
      type: "fact",
      subject: "C",
      content: "Gamma fact",
      importance: 5,
      createdAt: "2026-02-26T03:00:00.000Z",
    });

    await seedConflict(db, {
      id: "pending-1",
      entryA: "entry-a",
      entryB: "entry-b",
      relation: "contradicts",
      resolution: "pending",
    });
    await seedConflict(db, {
      id: "resolved-1",
      entryA: "entry-c",
      entryB: "entry-b",
      relation: "coexists",
      resolution: "coexist",
      resolvedAt: "2026-02-26T04:00:00.000Z",
    });

    const response = await handleRequest(db, "GET", "/api/conflicts");
    expect(response.status).toBe(200);
    expect(response.data).toEqual([
      {
        id: "pending-1",
        entryA: {
          id: "entry-a",
          type: "fact",
          subject: "A",
          content: "Alpha fact",
          importance: 7,
          subjectKey: "alpha/key",
          createdAt: "2026-02-26T01:00:00.000Z",
        },
        entryB: {
          id: "entry-b",
          type: "fact",
          subject: "B",
          content: "Beta fact",
          importance: 6,
          subjectKey: "beta/key",
          createdAt: "2026-02-26T02:00:00.000Z",
        },
        relation: "contradicts",
        confidence: 0.8,
        resolution: "pending",
        createdAt: "2026-02-26T00:00:00.000Z",
      },
    ]);
  });

  it("GET /api/conflicts returns empty array when none pending", async () => {
    const db = makeClient();
    await initDb(db);

    await seedEntry(db, { id: "entry-a", type: "fact", subject: "A", content: "A" });
    await seedEntry(db, { id: "entry-b", type: "fact", subject: "B", content: "B" });
    await seedConflict(db, {
      id: "resolved-only",
      entryA: "entry-a",
      entryB: "entry-b",
      relation: "coexists",
      resolution: "coexist",
      resolvedAt: "2026-02-26T01:00:00.000Z",
    });

    const response = await handleRequest(db, "GET", "/api/conflicts");
    expect(response.status).toBe(200);
    expect(response.data).toEqual([]);
  });

  it("GET /api/stats returns correct counts", async () => {
    const db = makeClient();
    await initDb(db);

    await seedEntry(db, { id: "entry-a", type: "fact", subject: "A", content: "A" });
    await seedEntry(db, { id: "entry-b", type: "fact", subject: "B", content: "B" });
    await seedEntry(db, { id: "entry-c", type: "fact", subject: "C", content: "C" });
    await seedEntry(db, { id: "entry-d", type: "fact", subject: "D", content: "D" });

    await seedConflict(db, {
      id: "c1",
      entryA: "entry-a",
      entryB: "entry-b",
      relation: "contradicts",
      resolution: "pending",
    });
    await seedConflict(db, {
      id: "c2",
      entryA: "entry-a",
      entryB: "entry-c",
      relation: "supersedes",
      resolution: "auto-superseded",
      resolvedAt: "2026-02-26T01:00:00.000Z",
    });
    await seedConflict(db, {
      id: "c3",
      entryA: "entry-a",
      entryB: "entry-d",
      relation: "contradicts",
      resolution: "keep-old",
      resolvedAt: "2026-02-26T02:00:00.000Z",
    });

    const response = await handleRequest(db, "GET", "/api/stats");
    expect(response.status).toBe(200);
    expect(response.data).toEqual({
      total: 3,
      pending: 1,
      autoResolved: 1,
      userResolved: 1,
    });
  });

  it("POST /api/conflicts/:id/resolve with keep-new retires entry_a", async () => {
    const db = makeClient();
    await initDb(db);

    await seedEntry(db, { id: "entry-a", type: "fact", subject: "A", content: "A" });
    await seedEntry(db, { id: "entry-b", type: "fact", subject: "B", content: "B" });
    await seedConflict(db, {
      id: "conflict-1",
      entryA: "entry-a",
      entryB: "entry-b",
      relation: "contradicts",
      resolution: "pending",
    });

    const response = await handleRequest(db, "POST", "/api/conflicts/conflict-1/resolve", {
      resolution: "keep-new",
    });
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true });

    const entries = await db.execute({
      sql: "SELECT id, retired FROM entries WHERE id IN (?, ?) ORDER BY id ASC",
      args: ["entry-a", "entry-b"],
    });
    expect(entries.rows.map((row) => ({ id: String(row.id), retired: toNumber(row.retired) }))).toEqual([
      { id: "entry-a", retired: 1 },
      { id: "entry-b", retired: 0 },
    ]);
  });

  it("POST /api/conflicts/:id/resolve with keep-old retires entry_b", async () => {
    const db = makeClient();
    await initDb(db);

    await seedEntry(db, { id: "entry-a", type: "fact", subject: "A", content: "A" });
    await seedEntry(db, { id: "entry-b", type: "fact", subject: "B", content: "B" });
    await seedConflict(db, {
      id: "conflict-2",
      entryA: "entry-a",
      entryB: "entry-b",
      relation: "contradicts",
      resolution: "pending",
    });

    const response = await handleRequest(db, "POST", "/api/conflicts/conflict-2/resolve", {
      resolution: "keep-old",
    });
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true });

    const entries = await db.execute({
      sql: "SELECT id, retired FROM entries WHERE id IN (?, ?) ORDER BY id ASC",
      args: ["entry-a", "entry-b"],
    });
    expect(entries.rows.map((row) => ({ id: String(row.id), retired: toNumber(row.retired) }))).toEqual([
      { id: "entry-a", retired: 0 },
      { id: "entry-b", retired: 1 },
    ]);
  });

  it("POST /api/conflicts/:id/resolve with keep-both keeps both entries", async () => {
    const db = makeClient();
    await initDb(db);

    await seedEntry(db, { id: "entry-a", type: "fact", subject: "A", content: "A" });
    await seedEntry(db, { id: "entry-b", type: "fact", subject: "B", content: "B" });
    await seedConflict(db, {
      id: "conflict-3",
      entryA: "entry-a",
      entryB: "entry-b",
      relation: "coexists",
      resolution: "pending",
    });

    const response = await handleRequest(db, "POST", "/api/conflicts/conflict-3/resolve", {
      resolution: "keep-both",
    });
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true });

    const entries = await db.execute({
      sql: "SELECT id, retired FROM entries WHERE id IN (?, ?) ORDER BY id ASC",
      args: ["entry-a", "entry-b"],
    });
    expect(entries.rows.map((row) => ({ id: String(row.id), retired: toNumber(row.retired) }))).toEqual([
      { id: "entry-a", retired: 0 },
      { id: "entry-b", retired: 0 },
    ]);
  });

  it("POST /api/conflicts/:id/resolve updates conflict_log resolution", async () => {
    const db = makeClient();
    await initDb(db);

    await seedEntry(db, { id: "entry-a", type: "fact", subject: "A", content: "A" });
    await seedEntry(db, { id: "entry-b", type: "fact", subject: "B", content: "B" });
    await seedConflict(db, {
      id: "conflict-4",
      entryA: "entry-a",
      entryB: "entry-b",
      relation: "coexists",
      resolution: "pending",
    });

    const response = await handleRequest(db, "POST", "/api/conflicts/conflict-4/resolve", {
      resolution: "keep-both",
    });
    expect(response.status).toBe(200);

    const row = await db.execute({
      sql: "SELECT resolution, resolved_at FROM conflict_log WHERE id = ?",
      args: ["conflict-4"],
    });
    expect(String(row.rows[0]?.resolution)).toBe("keep-both");
    expect(String(row.rows[0]?.resolved_at ?? "")).not.toBe("");
  });

  it("POST /api/conflicts/:id/resolve returns 404 for unknown conflict id", async () => {
    const db = makeClient();
    await initDb(db);

    const response = await handleRequest(db, "POST", "/api/conflicts/missing-id/resolve", {
      resolution: "keep-new",
    });
    expect(response.status).toBe(404);
    expect(response.data).toEqual({ error: "Conflict not found" });
  });

  it("GET /api/history returns resolved conflicts ordered by resolved_at desc", async () => {
    const db = makeClient();
    await initDb(db);

    await seedEntry(db, { id: "entry-a", type: "fact", subject: "A", content: "A" });
    await seedEntry(db, { id: "entry-b", type: "fact", subject: "B", content: "B" });
    await seedEntry(db, { id: "entry-c", type: "fact", subject: "C", content: "C" });

    await seedConflict(db, {
      id: "history-oldest",
      entryA: "entry-a",
      entryB: "entry-b",
      relation: "contradicts",
      resolution: "keep-old",
      resolvedAt: "2026-02-26T01:00:00.000Z",
    });
    await seedConflict(db, {
      id: "history-newest",
      entryA: "entry-b",
      entryB: "entry-c",
      relation: "supersedes",
      resolution: "keep-new",
      resolvedAt: "2026-02-26T03:00:00.000Z",
    });
    await seedConflict(db, {
      id: "history-middle",
      entryA: "entry-a",
      entryB: "entry-c",
      relation: "coexists",
      resolution: "keep-both",
      resolvedAt: "2026-02-26T02:00:00.000Z",
    });
    await seedConflict(db, {
      id: "pending-ignore",
      entryA: "entry-a",
      entryB: "entry-c",
      relation: "contradicts",
      resolution: "pending",
    });

    const response = await handleRequest(db, "GET", "/api/history");
    expect(response.status).toBe(200);
    const history = response.data as Array<{ id: string }>;
    expect(history.map((item) => item.id)).toEqual([
      "history-newest",
      "history-middle",
      "history-oldest",
    ]);
  });

  it("GET / returns HTML content", async () => {
    const db = makeClient();
    await initDb(db);

    const response = await handleRequest(db, "GET", "/");
    expect(response.status).toBe(200);
    expect(typeof response.data).toBe("string");
    const html = String(response.data);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("agenr - Conflict Review");
  });
});
