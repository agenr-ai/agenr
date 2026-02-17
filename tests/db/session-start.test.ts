import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initDb } from "../../src/db/client.js";
import { sessionStartRecall, estimateEntryTokens } from "../../src/db/session-start.js";
import { storeEntries } from "../../src/db/store.js";
import type { KnowledgeEntry, RecallResult, StoredEntry } from "../../src/types.js";

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

function makeStoredEntry(overrides: Partial<StoredEntry> = {}): StoredEntry {
  return {
    id: "entry-1",
    type: "fact",
    subject: "Jim",
    content: "Test content",
    importance: 7,
    expiry: "temporary",
    tags: [],
    source: { file: "x", context: "y" },
    created_at: "2026-02-10T00:00:00.000Z",
    updated_at: "2026-02-10T00:00:00.000Z",
    recall_count: 0,
    confirmations: 0,
    contradictions: 0,
    ...overrides,
  };
}

function makeRecallResult(entry: StoredEntry, score: number): RecallResult {
  return {
    entry,
    score,
    scores: {
      vector: 1,
      recency: 1,
      importance: 1,
      recall: 0,
      fts: 0,
    },
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

  it("session-start default since filters out entries older than 7 days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-15T12:00:00.000Z"));

    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [makeEntry({ content: "Old item", type: "fact" }), makeEntry({ content: "New item", type: "fact" })],
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
    const oldId = byContent.get("Old item");
    const newId = byContent.get("New item");
    expect(oldId).toBeTruthy();
    expect(newId).toBeTruthy();

    // created_at drives the --since cutoff, but updated_at drives session candidate selection.
    await client.execute({
      sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE id = ?",
      args: ["2026-02-05T12:00:00.000Z", "2026-02-15T12:00:00.000Z", oldId as string],
    });
    await client.execute({
      sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE id = ?",
      args: ["2026-02-14T12:00:00.000Z", "2026-02-15T12:00:00.000Z", newId as string],
    });

    const result = await sessionStartRecall(client, {
      query: { text: "" },
      apiKey: "sk-test",
      nonCoreLimit: 50,
    });

    const contents = result.results.map((item) => item.entry.content);
    expect(contents).toContain("New item");
    expect(contents).not.toContain("Old item");
  });

  it("session-start respects explicit --since and does not override it with the 7d fallback", async () => {
    const seen: Array<{ expiry: string | undefined; since: string | undefined }> = [];
    const recallFn = async (_db: Client, query: { expiry?: string; since?: string }, _apiKey: string): Promise<RecallResult[]> => {
      seen.push({ expiry: query.expiry, since: query.since });
      return [];
    };

    await sessionStartRecall({} as unknown as Client, {
      query: { text: "", since: "30d" },
      apiKey: "sk-test",
      nonCoreLimit: 10,
      recallFn: recallFn as any,
    });

    expect(seen.length).toBe(2);
    expect(seen.some((call) => call.expiry === "core" && call.since === "30d")).toBe(true);
    expect(seen.some((call) => call.expiry === undefined && call.since === "30d")).toBe(true);
  });

  it("session-start budget allocation is ~20% active, ~30% preferences, ~50% recent", async () => {
    const coreResults: RecallResult[] = [];

    const active = Array.from({ length: 40 }, (_, idx) =>
      makeRecallResult(makeStoredEntry({ id: `active-${idx}`, type: "todo", content: `active ${idx}` }), 1 - idx / 1000),
    );
    const preferences = Array.from({ length: 40 }, (_, idx) =>
      makeRecallResult(
        makeStoredEntry({ id: `pref-${idx}`, type: "decision", content: `pref ${idx}` }),
        1 - idx / 1000,
      ),
    );
    const recent = Array.from({ length: 80 }, (_, idx) =>
      makeRecallResult(makeStoredEntry({ id: `recent-${idx}`, type: "event", content: `recent ${idx}` }), 1 - idx / 1000),
    );

    const sampleTokens = estimateEntryTokens(active[0]!);
    const budget = sampleTokens * 100;

    const recallFn = async (_db: Client, query: { expiry?: string }, _apiKey: string): Promise<RecallResult[]> => {
      if (query.expiry === "core") {
        return coreResults;
      }
      return [...active, ...preferences, ...recent];
    };

    const result = await sessionStartRecall({} as unknown as Client, {
      query: { text: "" },
      apiKey: "sk-test",
      nonCoreLimit: 1000,
      budget,
      recallFn: recallFn as any,
    });

    const activeCount = result.results.filter((item) => item.category === "active").length;
    const preferencesCount = result.results.filter((item) => item.category === "preferences").length;
    const recentCount = result.results.filter((item) => item.category === "recent").length;

    expect(activeCount).toBe(20);
    expect(preferencesCount).toBe(30);
    expect(recentCount).toBe(50);
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
