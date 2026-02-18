import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initDb } from "../../src/db/client.js";
import { computeBudgetSplit, sessionStartRecall } from "../../src/db/session-start.js";
import { storeEntries } from "../../src/db/store.js";
import type { KnowledgeEntry, RecallResult } from "../../src/types.js";

async function mockEmbed(texts: string[]): Promise<number[][]> {
  return texts.map(() => Array.from({ length: 1024 }, () => 0));
}

function makeEntry(params: { content: string; type?: KnowledgeEntry["type"]; importance?: KnowledgeEntry["importance"] }): KnowledgeEntry {
  return {
    type: params.type ?? "fact",
    subject: "Jim",
    content: params.content,
    importance: params.importance ?? 7,
    expiry: "temporary",
    tags: [],
    source: { file: "session-start-test.jsonl", context: "unit test" },
  };
}

describe("db session-start", () => {
  const clients: Client[] = [];

  afterEach(() => {
    vi.useRealTimers();
    while (clients.length > 0) {
      clients.pop()?.close();
    }
  });

  function makeClient(): Client {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    return client;
  }

  it("session-start uses a 30-day window for permanent entries and shorter window for temporary entries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-15T12:00:00.000Z"));

    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [
        { ...makeEntry({ content: "Permanent item", type: "fact" }), expiry: "permanent" },
        { ...makeEntry({ content: "Temporary item", type: "fact" }), expiry: "temporary" },
      ],
      "sk-test",
      {
        sourceFile: "session-start-test.jsonl",
        ingestContentHash: "hash-session-start-since",
        embedFn: mockEmbed,
        force: true,
      },
    );

    const allRows = await client.execute("SELECT id, content FROM entries ORDER BY created_at ASC");
    const byContent = new Map<string, string>();
    for (const row of allRows.rows) {
      byContent.set(String(row.content), String(row.id));
    }
    const permanentId = byContent.get("Permanent item");
    const temporaryId = byContent.get("Temporary item");
    expect(permanentId).toBeTruthy();
    expect(temporaryId).toBeTruthy();

    // created_at drives the --since cutoff, but updated_at drives session candidate selection.
    await client.execute({
      sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE id = ?",
      args: ["2026-02-07T12:00:00.000Z", "2026-02-15T12:00:00.000Z", permanentId as string],
    });
    await client.execute({
      sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE id = ?",
      args: ["2026-01-15T12:00:00.000Z", "2026-02-15T12:00:00.000Z", temporaryId as string],
    });

    const result = await sessionStartRecall(client, {
      query: { text: "" },
      apiKey: "sk-test",
      nonCoreLimit: 50,
    });

    const contents = result.results.map((item) => item.entry.content);
    expect(contents).toContain("Permanent item");
    expect(contents).not.toContain("Temporary item");
  });

  it("session-start respects explicit --since and does not override default windows", async () => {
    const seen: Array<{ expiry: string | string[] | undefined; since: string | undefined }> = [];
    const recallFn: NonNullable<Parameters<typeof sessionStartRecall>[1]["recallFn"]> = async (_db, query, _apiKey) => {
      seen.push({ expiry: query.expiry, since: query.since });
      return [];
    };

    await sessionStartRecall({} as unknown as Client, {
      query: { text: "", since: "30d" },
      apiKey: "sk-test",
      nonCoreLimit: 10,
      recallFn,
    });

    expect(seen.length).toBe(2);
    expect(seen.some((call) => call.expiry === "core" && call.since === "30d")).toBe(true);
    const nonCoreCall = seen.find((call) => Array.isArray(call.expiry));
    expect(nonCoreCall?.since).toBe("30d");
    expect(Array.isArray(nonCoreCall?.expiry) ? [...nonCoreCall.expiry].sort().join(",") : "").toBe("permanent,temporary");
  });

  it("dynamic budget allocation: zero todos yields zero active budget", () => {
    const split = computeBudgetSplit({ active: 0, preferences: 20, recent: 80 }, 1000);
    expect(split.activeBudget).toBe(0);
    expect(split.activeBudget + split.preferencesBudget + split.recentBudget).toBe(1000);
  });

  it("dynamic budget allocation: all todos caps active at 30% of total", () => {
    const split = computeBudgetSplit({ active: 100, preferences: 0, recent: 0 }, 1000);
    expect(split.activeBudget).toBe(300);
    expect(split.activeBudget + split.preferencesBudget + split.recentBudget).toBe(1000);
  });

  it("dynamic budget allocation: mixed counts stay within min/max bounds and fully allocate", () => {
    const split = computeBudgetSplit({ active: 5, preferences: 25, recent: 70 }, 1000);
    expect(split.activeBudget).toBeGreaterThanOrEqual(100);
    expect(split.activeBudget).toBeLessThanOrEqual(300);
    expect(split.preferencesBudget).toBeGreaterThanOrEqual(200);
    expect(split.preferencesBudget).toBeLessThanOrEqual(400);
    expect(split.activeBudget + split.preferencesBudget + split.recentBudget).toBe(1000);
  });

  it("empty and single-entry DB do not crash on session-start", async () => {
    const empty = makeClient();
    await initDb(empty);
    const emptyResult = await sessionStartRecall(empty, {
      query: { text: "" },
      apiKey: "sk-test",
      nonCoreLimit: 10,
    });
    expect(emptyResult.results).toHaveLength(0);

    const single = makeClient();
    await initDb(single);
    await storeEntries(single, [makeEntry({ content: "Only item", type: "event" })], "sk-test", {
      sourceFile: "session-start-test.jsonl",
      ingestContentHash: "hash-session-start-single",
      embedFn: mockEmbed,
      force: true,
    });
    const singleResult = await sessionStartRecall(single, {
      query: { text: "" },
      apiKey: "sk-test",
      nonCoreLimit: 10,
    });
    expect(singleResult.results.map((item) => item.entry.content)).toContain("Only item");
  });

  it("all-todos DB still returns results (penalized, not eliminated)", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      Array.from({ length: 8 }, (_, idx) => makeEntry({ content: `Todo ${idx}`, type: "todo" })),
      "sk-test",
      {
        sourceFile: "session-start-test.jsonl",
        ingestContentHash: "hash-session-start-all-todos",
        embedFn: mockEmbed,
        force: true,
      },
    );

    const result = await sessionStartRecall(client, {
      query: { text: "" },
      apiKey: "sk-test",
      nonCoreLimit: 20,
    });

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.every((item) => item.category === "active")).toBe(true);
  });
});
