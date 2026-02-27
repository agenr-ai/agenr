import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../../src/db/client.js";
import {
  decayCoRecallEdges,
  getCoRecallNeighbors,
  getTopCoRecallEdges,
  strengthenCoRecallEdges,
} from "../../src/db/co-recall.js";

describe("co-recall edges", () => {
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

  async function insertEntry(client: Client, id: string): Promise<void> {
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
          created_at,
          updated_at
        )
        VALUES (?, 'fact', ?, ?, 5, 'temporary', 'private', 'co-recall.test.jsonl', 'test', ?, ?)
      `,
      args: [
        id,
        `subject-${id}`,
        `content-${id}`,
        "2026-02-27T00:00:00.000Z",
        "2026-02-27T00:00:00.000Z",
      ],
    });
  }

  async function countEdges(client: Client): Promise<number> {
    const result = await client.execute("SELECT COUNT(*) AS count FROM co_recall_edges");
    return Number((result.rows[0] as { count?: unknown } | undefined)?.count ?? 0);
  }

  it("creates one edge from two used entries", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, "a");
    await insertEntry(client, "b");

    await strengthenCoRecallEdges(client, ["a", "b"], "2026-02-27T00:00:00.000Z");

    const result = await client.execute("SELECT weight, session_count FROM co_recall_edges");
    expect(result.rows).toHaveLength(1);
    expect(Number((result.rows[0] as { weight?: unknown }).weight)).toBeCloseTo(0.1, 6);
    expect(Number((result.rows[0] as { session_count?: unknown }).session_count)).toBe(1);
  });

  it("creates all pairs from three used entries", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, "a");
    await insertEntry(client, "b");
    await insertEntry(client, "c");

    await strengthenCoRecallEdges(client, ["a", "b", "c"], "2026-02-27T00:00:00.000Z");

    expect(await countEdges(client)).toBe(3);
  });

  it("creates nothing for one or zero used entries", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, "a");

    await strengthenCoRecallEdges(client, ["a"], "2026-02-27T00:00:00.000Z");
    await strengthenCoRecallEdges(client, [], "2026-02-27T00:00:00.000Z");

    expect(await countEdges(client)).toBe(0);
  });

  it("increments weight and session_count on repeated strengthening", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, "a");
    await insertEntry(client, "b");

    await strengthenCoRecallEdges(client, ["a", "b"], "2026-02-27T00:00:00.000Z");
    await strengthenCoRecallEdges(client, ["b", "a"], "2026-02-27T01:00:00.000Z");

    const result = await client.execute("SELECT weight, session_count FROM co_recall_edges");
    expect(Number((result.rows[0] as { weight?: unknown }).weight)).toBeCloseTo(0.2, 6);
    expect(Number((result.rows[0] as { session_count?: unknown }).session_count)).toBe(2);
  });

  it("caps weight at 1.0", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, "a");
    await insertEntry(client, "b");

    for (let i = 0; i < 20; i += 1) {
      await strengthenCoRecallEdges(client, ["a", "b"], `2026-02-27T${String(i).padStart(2, "0")}:00:00.000Z`);
    }

    const result = await client.execute("SELECT weight FROM co_recall_edges");
    expect(Number((result.rows[0] as { weight?: unknown }).weight)).toBeCloseTo(1.0, 6);
  });

  it("enforces normalized order entry_a < entry_b", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, "entry-z");
    await insertEntry(client, "entry-a");

    await strengthenCoRecallEdges(client, ["entry-z", "entry-a"], "2026-02-27T00:00:00.000Z");

    const result = await client.execute("SELECT entry_a, entry_b FROM co_recall_edges");
    expect((result.rows[0] as { entry_a?: unknown }).entry_a).toBe("entry-a");
    expect((result.rows[0] as { entry_b?: unknown }).entry_b).toBe("entry-z");
  });

  it("decays weights and prunes edges below threshold", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, "a");
    await insertEntry(client, "b");

    await strengthenCoRecallEdges(client, ["a", "b"], "2026-02-27T00:00:00.000Z");
    const pruned = await decayCoRecallEdges(client, 0.4);

    expect(pruned).toBe(1);
    expect(await countEdges(client)).toBe(0);
  });

  it("returns neighbors sorted by weight desc", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, "a");
    await insertEntry(client, "b");
    await insertEntry(client, "c");

    await strengthenCoRecallEdges(client, ["a", "b"], "2026-02-27T00:00:00.000Z");
    await strengthenCoRecallEdges(client, ["a", "c"], "2026-02-27T01:00:00.000Z");
    await strengthenCoRecallEdges(client, ["a", "c"], "2026-02-27T02:00:00.000Z");

    const neighbors = await getCoRecallNeighbors(client, "a");
    expect(neighbors.map((item) => item.entryId)).toEqual(["c", "b"]);
  });

  it("respects minWeight filter", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, "a");
    await insertEntry(client, "b");
    await insertEntry(client, "c");

    await strengthenCoRecallEdges(client, ["a", "b"], "2026-02-27T00:00:00.000Z");
    await strengthenCoRecallEdges(client, ["a", "c"], "2026-02-27T01:00:00.000Z");
    await strengthenCoRecallEdges(client, ["a", "c"], "2026-02-27T02:00:00.000Z");

    const neighbors = await getCoRecallNeighbors(client, "a", 0.2);
    expect(neighbors.map((item) => item.entryId)).toEqual(["c"]);
  });

  it("respects neighbor limit", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, "a");
    await insertEntry(client, "b");
    await insertEntry(client, "c");

    await strengthenCoRecallEdges(client, ["a", "b", "c"], "2026-02-27T00:00:00.000Z");

    const neighbors = await getCoRecallNeighbors(client, "a", 0.1, 1);
    expect(neighbors).toHaveLength(1);
  });

  it("getTopCoRecallEdges returns edges sorted by weight desc", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, "a");
    await insertEntry(client, "b");
    await insertEntry(client, "c");

    await strengthenCoRecallEdges(client, ["a", "b"], "2026-02-27T00:00:00.000Z");
    await strengthenCoRecallEdges(client, ["a", "c"], "2026-02-27T01:00:00.000Z");
    await strengthenCoRecallEdges(client, ["a", "c"], "2026-02-27T02:00:00.000Z");

    const edges = await getTopCoRecallEdges(client);
    expect(edges).toHaveLength(2);
    expect(edges[0]?.entryA).toBe("a");
    expect(edges[0]?.entryB).toBe("c");
    expect(edges[0]?.weight).toBeGreaterThanOrEqual(edges[1]?.weight ?? 0);
  });

  it("getTopCoRecallEdges respects limit", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, "a");
    await insertEntry(client, "b");
    await insertEntry(client, "c");

    await strengthenCoRecallEdges(client, ["a", "b", "c"], "2026-02-27T00:00:00.000Z");
    const edges = await getTopCoRecallEdges(client, 2);
    expect(edges).toHaveLength(2);
  });

  it("caps pair generation at 20 used entries", async () => {
    const client = makeClient();
    await initDb(client);
    const used: string[] = [];
    for (let i = 1; i <= 25; i += 1) {
      const id = `e${String(i).padStart(2, "0")}`;
      await insertEntry(client, id);
      used.push(id);
    }

    await strengthenCoRecallEdges(client, used, "2026-02-27T00:00:00.000Z");

    // C(20, 2) = 190 edges max from the first 20 entries.
    expect(await countEdges(client)).toBe(190);

    const outOfCap = await client.execute({
      sql: `
        SELECT COUNT(*) AS count
        FROM co_recall_edges
        WHERE entry_a = 'e21' OR entry_b = 'e21'
      `,
      args: [],
    });
    expect(Number((outOfCap.rows[0] as { count?: unknown } | undefined)?.count ?? 0)).toBe(0);
  });
});
