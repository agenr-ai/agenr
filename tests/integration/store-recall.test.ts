import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../../src/db/client.js";
import { recall } from "../../src/db/recall.js";
import { storeEntries } from "../../src/db/store.js";
import type { KnowledgeEntry } from "../../src/types.js";

function to512(head: number[]): number[] {
  return [...head, ...Array.from({ length: 509 }, () => 0)];
}

function vectorForText(text: string): number[] {
  if (text.includes("vec-work-strong")) return to512([1, 0, 0]);
  if (text.includes("vec-work-mid")) return to512([0.85, 0.2, 0]);
  if (text.includes("vec-health")) return to512([0, 1, 0]);
  if (text.includes("work")) return to512([1, 0, 0]);
  if (text.includes("health")) return to512([0, 1, 0]);
  return to512([0.1, 0.1, 0.98]);
}

async function mockEmbed(texts: string[]): Promise<number[][]> {
  return texts.map((text) => vectorForText(text));
}

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

function makeEntry(content: string, tags: string[]): KnowledgeEntry {
  return {
    type: "fact",
    subject: "Jim",
    content,
    confidence: "high",
    expiry: "temporary",
    tags,
    source: {
      file: "integration.jsonl",
      context: "integration test",
    },
  };
}

describe("integration: store + recall", () => {
  const clients: Client[] = [];

  afterEach(() => {
    while (clients.length > 0) {
      clients.pop()?.close();
    }
  });

  function createTestClient(): Client {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    return client;
  }

  it("round-trips stored entries and returns the top relevant recall result", async () => {
    const client = createTestClient();
    await initDb(client);

    await storeEntries(
      client,
      [
        makeEntry("Building recall CLI vec-work-strong", ["work"]),
        makeEntry("Planning roadmap vec-work-mid", ["work"]),
        makeEntry("Diet preference vec-health", ["health"]),
      ],
      "sk-test",
      {
        sourceFile: "integration.jsonl",
        ingestContentHash: "ingest-1",
        embedFn: mockEmbed,
        force: true,
      },
    );

    const results = await recall(
      client,
      {
        text: "work",
        limit: 3,
      },
      "sk-test",
      {
        embedFn: mockEmbed,
        now: new Date("2026-02-15T00:00:00.000Z"),
      },
    );

    expect(results).toHaveLength(3);
    expect(results[0]?.entry.content).toContain("vec-work-strong");
  });

  it("does not duplicate entries in recall results after duplicate store attempts", async () => {
    const client = createTestClient();
    await initDb(client);

    const seedEntries = [makeEntry("Primary item vec-work-strong", ["work"]), makeEntry("Secondary item vec-work-mid", ["work"])];
    await storeEntries(client, seedEntries, "sk-test", {
      sourceFile: "integration.jsonl",
      ingestContentHash: "ingest-2",
      embedFn: mockEmbed,
      force: true,
    });
    await storeEntries(client, seedEntries, "sk-test", {
      sourceFile: "integration.jsonl",
      ingestContentHash: "ingest-3",
      embedFn: mockEmbed,
    });

    const results = await recall(
      client,
      {
        text: "work",
        limit: 10,
      },
      "sk-test",
      {
        embedFn: mockEmbed,
        now: new Date("2026-02-15T00:00:00.000Z"),
      },
    );

    const ids = results.map((item) => item.entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("updates recall_count across repeated recalls and respects noUpdate mode", async () => {
    const client = createTestClient();
    await initDb(client);

    await storeEntries(client, [makeEntry("Count me vec-work-strong", ["work"])], "sk-test", {
      sourceFile: "integration.jsonl",
      ingestContentHash: "ingest-4",
      embedFn: mockEmbed,
      force: true,
    });

    const first = await recall(
      client,
      {
        text: "work",
        limit: 1,
      },
      "sk-test",
      {
        embedFn: mockEmbed,
        now: new Date("2026-02-15T00:00:00.000Z"),
      },
    );
    const id = first[0]?.entry.id;
    expect(id).toBeTruthy();

    await recall(
      client,
      {
        text: "work",
        limit: 1,
      },
      "sk-test",
      {
        embedFn: mockEmbed,
        now: new Date("2026-02-16T00:00:00.000Z"),
      },
    );

    const afterSecond = await client.execute({
      sql: "SELECT recall_count FROM entries WHERE id = ?",
      args: [id as string],
    });
    expect(asNumber(afterSecond.rows[0]?.recall_count)).toBe(2);

    await recall(
      client,
      {
        text: "work",
        limit: 1,
        noUpdate: true,
      },
      "sk-test",
      {
        embedFn: mockEmbed,
        now: new Date("2026-02-17T00:00:00.000Z"),
      },
    );

    const afterNoUpdate = await client.execute({
      sql: "SELECT recall_count FROM entries WHERE id = ?",
      args: [id as string],
    });
    expect(asNumber(afterNoUpdate.rows[0]?.recall_count)).toBe(2);
  });
});
