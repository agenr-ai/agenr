import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../../src/db/client.js";
import {
  freshnessBoost,
  importanceScore,
  recall,
  recallStrength,
  recency,
  scoreEntry,
  scoreEntryWithBreakdown,
  todoStaleness,
} from "../../src/db/recall.js";
import { storeEntries } from "../../src/db/store.js";
import type { KnowledgeEntry, StoredEntry } from "../../src/types.js";

function to512(head: number[]): number[] {
  return [...head, ...Array.from({ length: 1021 }, () => 0)];
}

function vectorForText(text: string): number[] {
  if (text.includes("vec-work-strong")) return to512([1, 0, 0]);
  if (text.includes("vec-work-mid")) return to512([0.9, 0.2, 0]);
  if (text.includes("vec-work-low")) return to512([0.7, 0.4, 0]);
  if (text.includes("vec-health")) return to512([0, 1, 0]);
  if (text.includes("vec-random")) return to512([0, 0, 1]);
  if (text.includes("[topic:")) return to512([1, 0, 0]);
  if (text.includes("work")) return to512([1, 0, 0]);
  if (text.includes("health")) return to512([0, 1, 0]);
  return to512([0.2, 0.2, 0.9]);
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

function makeEntry(params: {
  content: string;
  type?: KnowledgeEntry["type"];
  tags?: string[];
  importance?: KnowledgeEntry["importance"];
  expiry?: KnowledgeEntry["expiry"];
}): KnowledgeEntry {
  return {
    type: params.type ?? "fact",
    subject: "Jim",
    content: params.content,
    importance: params.importance ?? 8,
    expiry: params.expiry ?? "temporary",
    tags: params.tags ?? [],
    source: {
      file: "recall-test.jsonl",
      context: "unit test",
    },
  };
}

function makeStoredEntry(overrides: Partial<StoredEntry> = {}): StoredEntry {
  return {
    id: "entry-1",
    type: "fact",
    subject: "Jim",
    content: "Test content",
    importance: 8,
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

describe("db recall", () => {
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

  it("recency keeps core at 1.0 and decays temporary faster than permanent", () => {
    expect(recency(0, "core")).toBe(1);
    expect(recency(5000, "core")).toBe(1);

    const temporary = recency(10, "temporary");
    const permanent = recency(10, "permanent");
    expect(temporary).toBeLessThan(1);
    expect(temporary).toBeLessThan(permanent);
  });

  it("importanceScore maps 1-10 to a bounded multiplier", () => {
    expect(importanceScore(1)).toBeCloseTo(0.55, 5);
    expect(importanceScore(10)).toBeCloseTo(1, 5);
    expect(importanceScore(8)).toBeGreaterThan(importanceScore(5));
    expect(importanceScore(5)).toBeGreaterThan(importanceScore(2));
  });

  it("recallStrength is zero for never recalled and has diminishing returns", () => {
    expect(recallStrength(0, 2, "temporary")).toBe(0);
    const one = recallStrength(1, 1, "temporary");
    const four = recallStrength(4, 1, "temporary");
    const sixteen = recallStrength(16, 1, "temporary");
    expect(four).toBeGreaterThan(one);
    expect(four / one).toBeLessThan(4);
    expect(sixteen / four).toBeLessThan(4);
  });

  it("freshnessBoost gates on importance and boosts very recent entries", () => {
    const now = new Date("2026-02-15T00:00:00.000Z");
    const hourMs = 60 * 60 * 1000;
    const isoHoursAgo = (hours: number) => new Date(now.getTime() - hours * hourMs).toISOString();

    expect(freshnessBoost(makeStoredEntry({ importance: 5, created_at: isoHoursAgo(0.1) }), now)).toBe(1.0);
    expect(freshnessBoost(makeStoredEntry({ importance: 5, created_at: isoHoursAgo(100) }), now)).toBe(1.0);

    expect(freshnessBoost(makeStoredEntry({ importance: 6, created_at: isoHoursAgo(0.5) }), now)).toBe(1.5);
    expect(freshnessBoost(makeStoredEntry({ importance: 6, created_at: isoHoursAgo(2) }), now)).toBe(1.25);
    expect(freshnessBoost(makeStoredEntry({ importance: 6, created_at: isoHoursAgo(12) }), now)).toBe(1.1);
    expect(freshnessBoost(makeStoredEntry({ importance: 6, created_at: isoHoursAgo(30) }), now)).toBe(1.0);
  });

  it("todoStaleness decays smoothly with half-life 7 days (with floors)", () => {
    const now = new Date("2026-02-15T00:00:00.000Z");
    const dayMs = 24 * 60 * 60 * 1000;
    const isoDaysAgo = (days: number) => new Date(now.getTime() - days * dayMs).toISOString();

    const base = makeStoredEntry({ type: "todo", importance: 7 });
    expect(todoStaleness({ ...base, updated_at: isoDaysAgo(0) }, now)).toBeCloseTo(1.0, 8);
    expect(todoStaleness({ ...base, updated_at: isoDaysAgo(3) }, now)).toBeCloseTo(Math.pow(0.5, 3 / 7), 8);
    expect(todoStaleness({ ...base, updated_at: isoDaysAgo(7) }, now)).toBeCloseTo(0.5, 8);
    expect(todoStaleness({ ...base, updated_at: isoDaysAgo(14) }, now)).toBeCloseTo(0.25, 8);
    expect(todoStaleness({ ...base, updated_at: isoDaysAgo(30) }, now)).toBeCloseTo(0.10, 8);
    expect(todoStaleness({ ...base, updated_at: isoDaysAgo(60) }, now)).toBeCloseTo(0.10, 8);

    const highImportance = makeStoredEntry({ type: "todo", importance: 8 });
    expect(todoStaleness({ ...highImportance, updated_at: isoDaysAgo(60) }, now)).toBeCloseTo(0.40, 8);

    let prev = todoStaleness({ ...base, updated_at: isoDaysAgo(0) }, now);
    for (let day = 1; day <= 60; day += 1) {
      const next = todoStaleness({ ...base, updated_at: isoDaysAgo(day) }, now);
      expect(Math.abs(prev - next)).toBeLessThanOrEqual(0.10 + 1e-9);
      prev = next;
    }
  });

  it("session-start scoring penalizes stale todos but not other types", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [
        makeEntry({ content: "Old todo vec-work-low", type: "todo", importance: 8 }),
        makeEntry({ content: "Old fact vec-work-low", type: "fact", importance: 8 }),
      ],
      "sk-test",
      {
        sourceFile: "recall-test.jsonl",
        ingestContentHash: "hash-session-todo-penalty",
        embedFn: mockEmbed,
        force: true,
      },
    );

    const allRows = await client.execute("SELECT id, content FROM entries ORDER BY created_at ASC");
    const byContent = new Map<string, string>();
    for (const row of allRows.rows) {
      byContent.set(String(row.content), String(row.id));
    }

    const todoId = byContent.get("Old todo vec-work-low");
    const factId = byContent.get("Old fact vec-work-low");
    expect(todoId).toBeTruthy();
    expect(factId).toBeTruthy();

    await client.execute({
      sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE id IN (?, ?)",
      args: ["2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", todoId as string, factId as string],
    });

    const now = new Date("2026-02-15T00:00:00.000Z");
    const results = await recall(
      client,
      {
        text: "",
        context: "session-start",
        limit: 10,
      },
      "sk-test",
      { now },
    );

    const todo = results.find((item) => item.entry.id === todoId);
    const fact = results.find((item) => item.entry.id === factId);
    expect(todo).toBeTruthy();
    expect(fact).toBeTruthy();
    expect(fact!.score).toBeGreaterThan(todo!.score);
  });

  it("a stale importance-9 todo scores lower than a fresh importance-7 event in session-start", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [
        makeEntry({ content: "Stale todo vec-work-low", type: "todo", importance: 9 }),
        makeEntry({ content: "Fresh event vec-work-low", type: "event", importance: 7 }),
      ],
      "sk-test",
      {
        sourceFile: "recall-test.jsonl",
        ingestContentHash: "hash-session-stale-vs-fresh",
        embedFn: mockEmbed,
        force: true,
      },
    );

    const allRows = await client.execute("SELECT id, content FROM entries ORDER BY created_at ASC");
    const byContent = new Map<string, string>();
    for (const row of allRows.rows) {
      byContent.set(String(row.content), String(row.id));
    }

    const staleTodoId = byContent.get("Stale todo vec-work-low");
    const freshEventId = byContent.get("Fresh event vec-work-low");
    expect(staleTodoId).toBeTruthy();
    expect(freshEventId).toBeTruthy();

    await client.execute({
      sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE id = ?",
      args: ["2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", staleTodoId as string],
    });
    await client.execute({
      sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE id = ?",
      args: ["2026-02-14T00:00:00.000Z", "2026-02-14T00:00:00.000Z", freshEventId as string],
    });

    const now = new Date("2026-02-15T00:00:00.000Z");
    const results = await recall(
      client,
      {
        text: "",
        context: "session-start",
        limit: 10,
      },
      "sk-test",
      { now },
    );

    const todoIndex = results.findIndex((item) => item.entry.id === staleTodoId);
    const eventIndex = results.findIndex((item) => item.entry.id === freshEventId);
    expect(todoIndex).toBeGreaterThanOrEqual(0);
    expect(eventIndex).toBeGreaterThanOrEqual(0);
    expect(eventIndex).toBeLessThan(todoIndex);
  });

  it("filters session-start candidates by platform when provided", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [
        { ...makeEntry({ content: "OpenClaw fact vec-work-strong" }), platform: "openclaw" as const },
        { ...makeEntry({ content: "Codex fact vec-work-strong" }), platform: "codex" as const },
      ],
      "sk-test",
      {
        sourceFile: "recall-test.jsonl",
        ingestContentHash: "hash-platform-filter",
        embedFn: mockEmbed,
        force: true,
      },
    );

    const now = new Date("2026-02-15T00:00:00.000Z");
    const openclawOnly = await recall(
      client,
      {
        text: "",
        context: "session-start",
        limit: 10,
        platform: "openclaw",
      },
      "sk-test",
      { now },
    );

    expect(openclawOnly.length).toBe(1);
    expect(openclawOnly[0]?.entry.content).toContain("OpenClaw fact");

    const all = await recall(
      client,
      {
        text: "",
        context: "session-start",
        limit: 10,
      },
      "sk-test",
      { now },
    );

    expect(all.length).toBe(2);
    expect(all.map((row) => row.entry.content).sort()).toEqual(["Codex fact vec-work-strong", "OpenClaw fact vec-work-strong"]);
  });

  it("excludes entries suppressed for session-start context", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [
        makeEntry({ content: "Visible session entry vec-work-strong" }),
        makeEntry({ content: "Hidden session entry vec-work-strong" }),
      ],
      "sk-test",
      {
        sourceFile: "recall-test.jsonl",
        ingestContentHash: "hash-session-suppression",
        embedFn: mockEmbed,
        force: true,
      },
    );

    await client.execute({
      sql: `
        UPDATE entries
        SET suppressed_contexts = json(?)
        WHERE content = ?
      `,
      args: [JSON.stringify(["session-start"]), "Hidden session entry vec-work-strong"],
    });

    const results = await recall(
      client,
      {
        text: "",
        context: "session-start",
        limit: 10,
      },
      "sk-test",
      { now: new Date("2026-02-15T00:00:00.000Z") },
    );

    expect(results.map((result) => result.entry.content)).toContain("Visible session entry vec-work-strong");
    expect(results.map((result) => result.entry.content)).not.toContain("Hidden session entry vec-work-strong");
  });

  it("keeps session-start-suppressed entries available to explicit recall", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [makeEntry({ content: "Explicit-only entry vec-work-strong", type: "fact" })],
      "sk-test",
      {
        sourceFile: "recall-test.jsonl",
        ingestContentHash: "hash-explicit-suppression",
        embedFn: mockEmbed,
        force: true,
      },
    );

    await client.execute({
      sql: "UPDATE entries SET suppressed_contexts = json(?) WHERE content = ?",
      args: [JSON.stringify(["session-start"]), "Explicit-only entry vec-work-strong"],
    });

    const explicitResults = await recall(
      client,
      {
        text: "explicit",
        limit: 10,
      },
      "sk-test",
      { embedFn: mockEmbed, now: new Date("2026-02-15T00:00:00.000Z") },
    );

    expect(explicitResults.some((result) => result.entry.content === "Explicit-only entry vec-work-strong")).toBe(true);
  });

  it("does not hide entries suppressed for other contexts from session-start", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [makeEntry({ content: "Other-context suppressed entry vec-work-strong" })],
      "sk-test",
      {
        sourceFile: "recall-test.jsonl",
        ingestContentHash: "hash-other-context",
        embedFn: mockEmbed,
        force: true,
      },
    );

    await client.execute({
      sql: "UPDATE entries SET suppressed_contexts = json(?) WHERE content = ?",
      args: [JSON.stringify(["other-context"]), "Other-context suppressed entry vec-work-strong"],
    });

    const sessionResults = await recall(
      client,
      {
        text: "",
        context: "session-start",
        limit: 10,
      },
      "sk-test",
      { now: new Date("2026-02-15T00:00:00.000Z") },
    );

    expect(sessionResults.some((result) => result.entry.content === "Other-context suppressed entry vec-work-strong")).toBe(true);
  });

  it("excludes retired entries from session-start and explicit recall", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [
        makeEntry({ content: "Active recall entry vec-work-strong" }),
        makeEntry({ content: "Retired recall entry vec-work-strong" }),
      ],
      "sk-test",
      {
        sourceFile: "recall-test.jsonl",
        ingestContentHash: "hash-retired-recall-filter",
        embedFn: mockEmbed,
        force: true,
      },
    );

    await client.execute({
      sql: "UPDATE entries SET retired = 1, retired_at = ? WHERE content = ?",
      args: ["2026-02-15T00:00:00.000Z", "Retired recall entry vec-work-strong"],
    });

    const sessionResults = await recall(
      client,
      {
        text: "",
        context: "session-start",
        limit: 10,
      },
      "sk-test",
      { now: new Date("2026-02-15T00:00:00.000Z") },
    );

    expect(sessionResults.some((result) => result.entry.content === "Retired recall entry vec-work-strong")).toBe(false);
    expect(sessionResults.some((result) => result.entry.content === "Active recall entry vec-work-strong")).toBe(true);

    const explicitResults = await recall(
      client,
      {
        text: "Retired recall entry",
        limit: 10,
      },
      "sk-test",
      { embedFn: mockEmbed, now: new Date("2026-02-15T00:00:00.000Z") },
    );

    expect(explicitResults.some((result) => result.entry.content === "Retired recall entry vec-work-strong")).toBe(false);
  });

  it("supports month-based since filters", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [
        makeEntry({ content: "Recent month entry vec-work-strong" }),
        makeEntry({ content: "Old month entry vec-work-strong" }),
      ],
      "sk-test",
      {
        sourceFile: "recall-test.jsonl",
        ingestContentHash: "hash-month-since",
        embedFn: mockEmbed,
        force: true,
      },
    );

    await client.execute({
      sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
      args: ["2026-02-05T00:00:00.000Z", "2026-02-05T00:00:00.000Z", "Recent month entry vec-work-strong"],
    });
    await client.execute({
      sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
      args: ["2025-12-15T00:00:00.000Z", "2025-12-15T00:00:00.000Z", "Old month entry vec-work-strong"],
    });

    const results = await recall(
      client,
      {
        text: "",
        context: "session-start",
        limit: 10,
        since: "1m",
      },
      "sk-test",
      { now: new Date("2026-02-15T00:00:00.000Z") },
    );

    expect(results.some((result) => result.entry.content === "Recent month entry vec-work-strong")).toBe(true);
    expect(results.some((result) => result.entry.content === "Old month entry vec-work-strong")).toBe(false);
  });

  describe("until parameter", () => {
    async function setupUntilFixture(): Promise<Client> {
      const client = makeClient();
      await initDb(client);

      await storeEntries(
        client,
        [
          makeEntry({ content: "Window too old vec-work-strong" }),
          makeEntry({ content: "Window since boundary vec-work-strong" }),
          makeEntry({ content: "Window middle vec-work-strong" }),
          makeEntry({ content: "Window until boundary vec-work-strong" }),
          makeEntry({ content: "Window too recent vec-work-strong" }),
        ],
        "sk-test",
        {
          sourceFile: "recall-test.jsonl",
          ingestContentHash: "hash-until-window",
          embedFn: mockEmbed,
          force: true,
        },
      );

      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
        args: ["2026-01-25T00:00:00.000Z", "2026-01-25T00:00:00.000Z", "Window too old vec-work-strong"],
      });
      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
        args: ["2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", "Window since boundary vec-work-strong"],
      });
      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
        args: ["2026-02-05T00:00:00.000Z", "2026-02-05T00:00:00.000Z", "Window middle vec-work-strong"],
      });
      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
        args: ["2026-02-08T00:00:00.000Z", "2026-02-08T00:00:00.000Z", "Window until boundary vec-work-strong"],
      });
      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
        args: ["2026-02-12T00:00:00.000Z", "2026-02-12T00:00:00.000Z", "Window too recent vec-work-strong"],
      });

      return client;
    }

    async function recallWindow(
      client: Client,
      filters: { since?: string; until?: string },
    ): Promise<Set<string>> {
      const results = await recall(
        client,
        {
          text: "",
          context: "session-start",
          limit: 50,
          ...filters,
        },
        "sk-test",
        { now: new Date("2026-02-15T00:00:00.000Z") },
      );
      return new Set(results.map((result) => result.entry.content));
    }

    it("includes entries inside a since/until window", async () => {
      const client = await setupUntilFixture();
      const contents = await recallWindow(client, { since: "14d", until: "7d" });
      expect(contents.has("Window middle vec-work-strong")).toBe(true);
    });

    it("excludes entries that are newer than until", async () => {
      const client = await setupUntilFixture();
      const contents = await recallWindow(client, { since: "14d", until: "7d" });
      expect(contents.has("Window too recent vec-work-strong")).toBe(false);
    });

    it("excludes entries that are older than since", async () => {
      const client = await setupUntilFixture();
      const contents = await recallWindow(client, { since: "14d", until: "7d" });
      expect(contents.has("Window too old vec-work-strong")).toBe(false);
    });

    it("includes older entries when only until is set", async () => {
      const client = await setupUntilFixture();
      const contents = await recallWindow(client, { until: "7d" });
      expect(contents.has("Window too old vec-work-strong")).toBe(true);
    });

    it("excludes newer entries when only until is set", async () => {
      const client = await setupUntilFixture();
      const contents = await recallWindow(client, { until: "7d" });
      expect(contents.has("Window too recent vec-work-strong")).toBe(false);
    });

    it("includes entries exactly at the until ceiling", async () => {
      const client = await setupUntilFixture();
      const contents = await recallWindow(client, { until: "7d" });
      expect(contents.has("Window until boundary vec-work-strong")).toBe(true);
    });

    it("includes entries exactly at the since cutoff", async () => {
      const client = await setupUntilFixture();
      const contents = await recallWindow(client, { since: "14d" });
      expect(contents.has("Window since boundary vec-work-strong")).toBe(true);
    });

    it("supports point windows where since equals until", async () => {
      const client = await setupUntilFixture();
      const contents = await recallWindow(client, { since: "7d", until: "7d" });
      expect(Array.from(contents)).toEqual(["Window until boundary vec-work-strong"]);
    });

    it("throws when since is later than until", async () => {
      const client = await setupUntilFixture();
      await expect(
        recall(
          client,
          {
            text: "",
            context: "session-start",
            limit: 50,
            since: "7d",
            until: "14d",
          },
          "sk-test",
          { now: new Date("2026-02-15T00:00:00.000Z") },
        ),
      ).rejects.toThrow("Invalid date range: since");
    });

    it("throws on invalid until values", async () => {
      const client = await setupUntilFixture();
      await expect(
        recall(
          client,
          {
            text: "",
            context: "session-start",
            limit: 50,
            until: "bad-value",
          },
          "sk-test",
          { now: new Date("2026-02-15T00:00:00.000Z") },
        ),
      ).rejects.toThrow('Invalid until value "bad-value"');
    });
  });

  describe("window-relative recency scoring", () => {
    it("scores the same entry higher when effectiveNow is the ceiling", () => {
      const entry = makeStoredEntry({
        created_at: "2026-02-08T00:00:00.000Z",
        updated_at: "2026-02-08T00:00:00.000Z",
        importance: 6,
        recall_count: 0,
        expiry: "temporary",
      });
      const ceiling = new Date("2026-02-08T00:00:00.000Z");
      const now = new Date("2026-02-15T00:00:00.000Z");

      const relative = scoreEntryWithBreakdown(entry, 0.9, false, ceiling, now);
      const global = scoreEntryWithBreakdown(entry, 0.9, false, now, now);
      expect(relative.score).toBeGreaterThan(global.score);
    });

    it("gives newer-in-window entries higher recency than older-in-window entries", () => {
      const effectiveNow = new Date("2026-02-08T00:00:00.000Z");
      const freshnessNow = new Date("2026-02-15T00:00:00.000Z");
      const atCeiling = makeStoredEntry({
        id: "at-ceiling",
        created_at: "2026-02-08T00:00:00.000Z",
        updated_at: "2026-02-08T00:00:00.000Z",
        importance: 6,
      });
      const atSince = makeStoredEntry({
        id: "at-since",
        created_at: "2026-02-01T00:00:00.000Z",
        updated_at: "2026-02-01T00:00:00.000Z",
        importance: 6,
      });

      const ceilingScore = scoreEntryWithBreakdown(atCeiling, 0.9, false, effectiveNow, freshnessNow);
      const sinceScore = scoreEntryWithBreakdown(atSince, 0.9, false, effectiveNow, freshnessNow);
      expect(ceilingScore.scores.recency).toBeGreaterThan(sinceScore.scores.recency);
      expect(ceilingScore.score).toBeGreaterThan(sinceScore.score);
    });

    it("keeps core-tier recency at 1.0 regardless of effectiveNow", () => {
      const coreEntry = makeStoredEntry({
        expiry: "core",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      });

      const oldAnchor = scoreEntryWithBreakdown(
        coreEntry,
        0.9,
        false,
        new Date("2026-02-08T00:00:00.000Z"),
        new Date("2026-02-15T00:00:00.000Z"),
      );
      const newAnchor = scoreEntryWithBreakdown(
        coreEntry,
        0.9,
        false,
        new Date("2026-02-15T00:00:00.000Z"),
        new Date("2026-02-15T00:00:00.000Z"),
      );

      expect(oldAnchor.scores.recency).toBe(1.0);
      expect(newAnchor.scores.recency).toBe(1.0);
    });

    it("does not apply freshness boost for entries near historical ceiling", () => {
      const ceilingEntry = makeStoredEntry({
        importance: 6,
        created_at: "2026-02-08T00:00:00.000Z",
        updated_at: "2026-02-08T00:00:00.000Z",
      });
      const effectiveNow = new Date("2026-02-08T00:00:00.000Z");
      const realNow = new Date("2026-02-15T00:00:00.000Z");

      const scored = scoreEntryWithBreakdown(ceilingEntry, 0.9, false, effectiveNow, realNow);
      expect(scored.scores.freshness).toBe(1.0);
    });
  });

  it("schema includes retirement and suppression columns", async () => {
    const client = makeClient();
    await initDb(client);

    const info = await client.execute("PRAGMA table_info(entries)");
    const columns = new Set(info.rows.map((row) => String((row as { name?: unknown }).name)));
    expect(columns.has("retired")).toBe(true);
    expect(columns.has("retired_at")).toBe(true);
    expect(columns.has("retired_reason")).toBe(true);
    expect(columns.has("suppressed_contexts")).toBe(true);
  });

  it("filters by project (includes NULL by default, strict excludes NULL)", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [
        { ...makeEntry({ content: "Agenr fact vec-work-strong" }), project: "agenr" },
        { ...makeEntry({ content: "OpenClaw fact vec-work-strong" }), project: "openclaw" },
        makeEntry({ content: "Untagged fact vec-work-strong" }),
      ],
      "sk-test",
      {
        sourceFile: "recall-test.jsonl",
        ingestContentHash: "hash-project-filter",
        embedFn: mockEmbed,
        force: true,
      },
    );

    const now = new Date("2026-02-15T00:00:00.000Z");
    const agenrPlusNull = await recall(
      client,
      {
        text: "",
        context: "session-start",
        limit: 10,
        project: "agenr",
      },
      "sk-test",
      { now },
    );

    expect(agenrPlusNull).toHaveLength(2);
    expect(agenrPlusNull.map((row) => row.entry.content).sort()).toEqual([
      "Agenr fact vec-work-strong",
      "Untagged fact vec-work-strong",
    ]);

    const agenrStrict = await recall(
      client,
      {
        text: "",
        context: "session-start",
        limit: 10,
        project: "agenr",
        projectStrict: true,
      },
      "sk-test",
      { now },
    );

    expect(agenrStrict).toHaveLength(1);
    expect(agenrStrict[0]?.entry.content).toBe("Agenr fact vec-work-strong");
  });

  it("supports multi-project queries and excludeProject", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [
        { ...makeEntry({ content: "Agenr fact vec-work-strong" }), project: "agenr" },
        { ...makeEntry({ content: "OpenClaw fact vec-work-strong" }), project: "openclaw" },
        { ...makeEntry({ content: "Kanban fact vec-work-strong" }), project: "kanban" },
        makeEntry({ content: "Untagged fact vec-work-strong" }),
      ],
      "sk-test",
      {
        sourceFile: "recall-test.jsonl",
        ingestContentHash: "hash-project-multi",
        embedFn: mockEmbed,
        force: true,
      },
    );

    const now = new Date("2026-02-15T00:00:00.000Z");
    const multi = await recall(
      client,
      {
        text: "",
        context: "session-start",
        limit: 10,
        project: "agenr,openclaw",
      },
      "sk-test",
      { now },
    );
    expect(multi.map((row) => row.entry.content).sort()).toEqual([
      "Agenr fact vec-work-strong",
      "OpenClaw fact vec-work-strong",
      "Untagged fact vec-work-strong",
    ]);

    const excluded = await recall(
      client,
      {
        text: "",
        context: "session-start",
        limit: 10,
        excludeProject: "kanban",
      },
      "sk-test",
      { now },
    );
    expect(excluded.map((row) => row.entry.content).sort()).toEqual([
      "Agenr fact vec-work-strong",
      "OpenClaw fact vec-work-strong",
      "Untagged fact vec-work-strong",
    ]);
  });

  it("matches project filters regardless of stored project casing", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [{ ...makeEntry({ content: "Mixed-case project vec-work-strong" }), project: "MyProject" }],
      "sk-test",
      {
        sourceFile: "recall-test.jsonl",
        ingestContentHash: "hash-project-case",
        embedFn: mockEmbed,
        force: true,
      },
    );

    const now = new Date("2026-02-15T00:00:00.000Z");
    const results = await recall(
      client,
      {
        text: "",
        context: "session-start",
        limit: 10,
        project: "myproject",
      },
      "sk-test",
      { now },
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.entry.content).toBe("Mixed-case project vec-work-strong");
  });

  it("scoreEntry uses multiplicative scaling for memory strength", () => {
    const now = new Date("2026-02-15T00:00:00.000Z");
    const highImportance = makeStoredEntry({
      importance: 8,
      confirmations: 3,
      contradictions: 0,
      recall_count: 2,
    });
    const lowImportance = makeStoredEntry({
      importance: 4,
      confirmations: 0,
      contradictions: 4,
      recall_count: 0,
    });

    const highScore = scoreEntry(highImportance, 0.95, false, now);
    const lowScore = scoreEntry(lowImportance, 0.95, false, now);
    expect(highScore).toBeGreaterThan(lowScore);
  });

  it("applies contradiction penalty only when contradictions >= 2", () => {
    const now = new Date("2026-02-15T00:00:00.000Z");
    const base = makeStoredEntry({
      expiry: "core",
      importance: 4,
      confirmations: 0,
      recall_count: 1,
    });

    const score0 = scoreEntry({ ...base, contradictions: 0 }, 0.91, false, now);
    const score1 = scoreEntry({ ...base, contradictions: 1 }, 0.91, false, now);
    const score2 = scoreEntry({ ...base, contradictions: 2 }, 0.91, false, now);
    const score5 = scoreEntry({ ...base, contradictions: 5 }, 0.91, false, now);

    expect(score1).toBeCloseTo(score0, 10);
    expect(score2).toBeCloseTo(score0 * 0.8, 10);
    expect(score5).toBeCloseTo(score0 * 0.8, 10);
  });

  it("recall pipeline ranks, filters, and excludes superseded entries", async () => {
    const client = makeClient();
    await initDb(client);

    const entries: KnowledgeEntry[] = [
      makeEntry({ content: "Project strategy vec-work-strong", type: "decision", tags: ["project"] }),
      makeEntry({ content: "Project note vec-work-mid", type: "fact", tags: ["project"] }),
      makeEntry({ content: "Health note vec-health", type: "fact", tags: ["health"] }),
      makeEntry({ content: "Random note vec-random", type: "event", tags: ["misc"] }),
      makeEntry({ content: "Work backlog vec-work-low", type: "todo", tags: ["project"] }),
      makeEntry({ content: "Another work item vec-work-mid", type: "lesson", tags: ["project", "learn"] }),
      makeEntry({ content: "Private work detail vec-work-strong", type: "fact", tags: ["private"] }),
      makeEntry({ content: "Public work detail vec-work-mid", type: "fact", tags: ["public"] }),
      makeEntry({ content: "Personal work detail vec-work-low", type: "fact", tags: ["personal"] }),
      makeEntry({ content: "Old work detail vec-work-strong", type: "fact", tags: ["old"] }),
    ];

    await storeEntries(client, entries, "sk-test", {
      sourceFile: "recall-test.jsonl",
      ingestContentHash: "hash-1",
      embedFn: mockEmbed,
      force: true,
    });

    const allRows = await client.execute("SELECT id, content FROM entries ORDER BY created_at ASC");
    const byContent = new Map<string, string>();
    for (const row of allRows.rows) {
      byContent.set(String(row.content), String(row.id));
    }

    const oldId = byContent.get("Old work detail vec-work-strong");
    const supersededId = byContent.get("Project note vec-work-mid");
    const replacementId = byContent.get("Project strategy vec-work-strong");
    const privateId = byContent.get("Private work detail vec-work-strong");
    const publicId = byContent.get("Public work detail vec-work-mid");
    const personalId = byContent.get("Personal work detail vec-work-low");

    expect(oldId).toBeTruthy();
    expect(supersededId).toBeTruthy();
    expect(replacementId).toBeTruthy();
    expect(privateId).toBeTruthy();
    expect(publicId).toBeTruthy();
    expect(personalId).toBeTruthy();

    await client.execute({
      sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE id = ?",
      args: ["2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z", oldId as string],
    });
    await client.execute({
      sql: "UPDATE entries SET superseded_by = ? WHERE id = ?",
      args: [replacementId as string, supersededId as string],
    });
    await client.execute({ sql: "UPDATE entries SET scope = 'private' WHERE id = ?", args: [privateId as string] });
    await client.execute({ sql: "UPDATE entries SET scope = 'public' WHERE id = ?", args: [publicId as string] });
    await client.execute({ sql: "UPDATE entries SET scope = 'personal' WHERE id = ?", args: [personalId as string] });

    const now = new Date("2026-02-15T00:00:00.000Z");
    const results = await recall(
      client,
      {
        text: "work",
        limit: 10,
      },
      "sk-test",
      { embedFn: mockEmbed, now },
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
    expect(results.some((item) => item.entry.id === supersededId)).toBe(false);

    const typeFiltered = await recall(
      client,
      {
        text: "work",
        limit: 10,
        types: ["decision"],
      },
      "sk-test",
      { embedFn: mockEmbed, now },
    );
    expect(typeFiltered.every((item) => item.entry.type === "decision")).toBe(true);

    const tagFiltered = await recall(
      client,
      {
        text: "",
        context: "session-start",
        limit: 10,
        tags: ["learn"],
      },
      "sk-test",
      { embedFn: mockEmbed, now },
    );
    expect(tagFiltered.length).toBe(1);
    expect(tagFiltered[0]?.entry.content).toContain("Another work item");

    const sinceFiltered = await recall(
      client,
      {
        text: "",
        context: "session-start",
        limit: 10,
        since: "7d",
      },
      "sk-test",
      { embedFn: mockEmbed, now },
    );
    expect(sinceFiltered.some((item) => item.entry.id === oldId)).toBe(false);

    const scopedPersonal = await recall(
      client,
      {
        text: "",
        context: "session-start",
        limit: 10,
        scope: "personal",
      },
      "sk-test",
      { embedFn: mockEmbed, now },
    );
    expect(scopedPersonal.some((item) => item.entry.scope === "private")).toBe(false);
    expect(scopedPersonal.some((item) => item.entry.scope === "public")).toBe(true);
    expect(scopedPersonal.some((item) => item.entry.scope === "personal")).toBe(true);
  });

  it("increments recall metadata on active recall and skips with noUpdate", async () => {
    const client = makeClient();
    await initDb(client);
    await storeEntries(
      client,
      [makeEntry({ content: "Active recall vec-work-strong", type: "fact", tags: ["active"] })],
      "sk-test",
      {
        sourceFile: "recall-test.jsonl",
        ingestContentHash: "hash-2",
        embedFn: mockEmbed,
      },
    );

    const now = new Date("2026-02-15T00:00:00.000Z");
    const first = await recall(client, { text: "work", limit: 1 }, "sk-test", {
      embedFn: mockEmbed,
      now,
    });

    const firstId = first[0]?.entry.id;
    expect(firstId).toBeTruthy();

    const afterFirst = await client.execute({
      sql: "SELECT recall_count, last_recalled_at FROM entries WHERE id = ?",
      args: [firstId as string],
    });
    expect(asNumber(afterFirst.rows[0]?.recall_count)).toBe(1);
    expect(typeof afterFirst.rows[0]?.last_recalled_at).toBe("string");

    await recall(
      client,
      {
        text: "work",
        limit: 1,
        noUpdate: true,
      },
      "sk-test",
      { embedFn: mockEmbed, now: new Date("2026-02-16T00:00:00.000Z") },
    );

    const afterPassive = await client.execute({
      sql: "SELECT recall_count FROM entries WHERE id = ?",
      args: [firstId as string],
    });
    expect(asNumber(afterPassive.rows[0]?.recall_count)).toBe(1);
  });

  it("updates returned entry recall_intervals in-memory after active recall", async () => {
    const client = makeClient();
    await initDb(client);
    await storeEntries(
      client,
      [makeEntry({ content: "Interval append vec-work-strong", type: "fact", tags: ["intervals"] })],
      "sk-test",
      {
        sourceFile: "recall-test.jsonl",
        ingestContentHash: "hash-interval-append",
        embedFn: mockEmbed,
      },
    );

    const row = await client.execute({
      sql: "SELECT id FROM entries WHERE content = ?",
      args: ["Interval append vec-work-strong"],
    });
    const entryId = String(row.rows[0]?.id ?? "");
    expect(entryId).toBeTruthy();

    const existingIntervals = [1700000000, 1700600000];
    await client.execute({
      sql: "UPDATE entries SET recall_intervals = json(?), recall_count = ?, last_recalled_at = ? WHERE id = ?",
      args: [JSON.stringify(existingIntervals), 2, "2026-02-10T00:00:00.000Z", entryId],
    });

    const now = new Date();
    const results = await recall(
      client,
      { text: "work", limit: 1 },
      "sk-test",
      {
        embedFn: mockEmbed,
        now,
      },
    );

    const updatedIntervals = results[0]?.entry.recall_intervals ?? [];
    expect(updatedIntervals).toHaveLength(existingIntervals.length + 1);
    const expectedEpochSecs = Math.round(Date.now() / 1000);
    expect(Math.abs((updatedIntervals.at(-1) ?? 0) - expectedEpochSecs)).toBeLessThanOrEqual(2);
  });

  it("supports no-boost raw vector ranking", async () => {
    const client = makeClient();
    await initDb(client);
    await storeEntries(
      client,
      [
        makeEntry({ content: "Top vector vec-work-strong", tags: ["vector"] }),
        makeEntry({ content: "Mid vector vec-work-mid", tags: ["vector"] }),
        makeEntry({ content: "Low vector vec-work-low", tags: ["vector"] }),
      ],
      "sk-test",
      {
        sourceFile: "recall-test.jsonl",
        ingestContentHash: "hash-3",
        embedFn: mockEmbed,
        force: true,
      },
    );

    const results = await recall(
      client,
      {
        text: "work",
        limit: 3,
        noBoost: true,
      },
      "sk-test",
      { embedFn: mockEmbed, now: new Date("2026-02-15T00:00:00.000Z") },
    );

    expect(results).toHaveLength(3);
    expect(results[0]?.entry.content).toContain("Top vector");
    expect(results[2]?.entry.content).toContain("Low vector");
    expect(results.every((item) => item.scores.fts === 0)).toBe(true);
    expect(results.every((item) => item.scores.spacing === 1.0)).toBe(true);
  });

  it(
    "keeps vector recall under 5s with many embedded entries",
    async () => {
      const client = makeClient();
      await initDb(client);

      const nowIso = "2026-02-15T00:00:00.000Z";
      const totalEntries = 6000;
      await client.execute("BEGIN");
      try {
        for (let i = 0; i < totalEntries; i += 1) {
          const angle = (i % 360) * (Math.PI / 180);
          const radial = ((i % 17) - 8) / 8;
          const embedding = to512([Math.cos(angle), Math.sin(angle), radial]);
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
              `perf-${i}`,
              "fact",
              "Perf",
              `Perf entry ${i}`,
              8,
              "temporary",
              "private",
              "perf.jsonl",
              "regression",
              JSON.stringify(embedding),
              nowIso,
              nowIso,
            ],
          });
        }
        await client.execute("COMMIT");
      } catch (error) {
        await client.execute("ROLLBACK");
        throw error;
      }

      const startMs = Date.now();
      const results = await recall(
        client,
        {
          text: "work",
          limit: 20,
        },
        "sk-test",
        { embedFn: mockEmbed, now: new Date(nowIso) },
      );
      const elapsedMs = Date.now() - startMs;

      expect(results.length).toBeGreaterThan(0);
      expect(elapsedMs).toBeLessThan(5000);
    },
    120000,
  );
});
