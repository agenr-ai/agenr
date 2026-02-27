import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initDb } from "../../src/db/client.js";
import {
  freshnessBoost,
  gaussianRecency,
  importanceScore,
  recall,
  recallStrength,
  recency,
  scoreBrowseEntry,
  scoreEntry,
  scoreEntryWithBreakdown,
  todoStaleness,
  updateRecallMetadata,
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
    quality_score: 0.5,
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

  it("gaussianRecency is 1.0 when entry date matches around date", () => {
    const around = new Date("2026-02-15T00:00:00.000Z");
    const entryDate = new Date("2026-02-15T00:00:00.000Z");
    expect(gaussianRecency(entryDate, around, 14)).toBeCloseTo(1, 8);
  });

  it("gaussianRecency decreases as entries move farther from around date", () => {
    const around = new Date("2026-02-15T00:00:00.000Z");
    const near = gaussianRecency(new Date("2026-02-16T00:00:00.000Z"), around, 14);
    const far = gaussianRecency(new Date("2026-02-22T00:00:00.000Z"), around, 14);
    expect(near).toBeGreaterThan(far);
  });

  it("gaussianRecency is symmetric around the target date", () => {
    const around = new Date("2026-02-15T00:00:00.000Z");
    const before = gaussianRecency(new Date("2026-02-10T00:00:00.000Z"), around, 14);
    const after = gaussianRecency(new Date("2026-02-20T00:00:00.000Z"), around, 14);
    expect(before).toBeCloseTo(after, 8);
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

  it("includes quality in score breakdown", () => {
    const now = new Date("2026-02-15T00:00:00.000Z");
    const scored = scoreEntryWithBreakdown(makeStoredEntry({ quality_score: 0.8 }), 0.9, false, now, now);
    expect(scored.scores.quality).toBeCloseTo(0.8, 8);
  });

  it("higher quality entries score higher than lower quality entries", () => {
    const now = new Date("2026-02-15T00:00:00.000Z");
    const high = scoreEntryWithBreakdown(makeStoredEntry({ quality_score: 0.9 }), 0.7, false, now, now);
    const low = scoreEntryWithBreakdown(makeStoredEntry({ quality_score: 0.1 }), 0.7, false, now, now);
    expect(high.score).toBeGreaterThan(low.score);
  });

  it("defaults nullish quality to 0.5", () => {
    const now = new Date("2026-02-15T00:00:00.000Z");
    const scored = scoreEntryWithBreakdown(
      makeStoredEntry({ quality_score: undefined as unknown as number }),
      0.7,
      false,
      now,
      now,
    );
    expect(scored.scores.quality).toBeCloseTo(0.5, 8);
  });

  it("applies quality factor range from 0.7 to 1.3", () => {
    const now = new Date("2026-02-15T00:00:00.000Z");
    const base = makeStoredEntry({ quality_score: 0.5, recall_count: 1, importance: 6 });
    const low = scoreEntryWithBreakdown({ ...base, quality_score: 0 }, 0.6, false, now, now);
    const mid = scoreEntryWithBreakdown({ ...base, quality_score: 0.5 }, 0.6, false, now, now);
    const high = scoreEntryWithBreakdown({ ...base, quality_score: 1 }, 0.6, false, now, now);
    expect(low.score / mid.score).toBeCloseTo(0.7, 6);
    expect(high.score / mid.score).toBeCloseTo(1.3, 6);
  });

  describe("auto-strengthen recall milestones", () => {
    async function insertRecallEntry(
      client: Client,
      params: { id: string; importance: number; recallCount: number },
    ): Promise<void> {
      await client.execute({
        sql: `
          INSERT INTO entries (
            id, type, subject, content, importance, expiry, scope, source_file, source_context,
            created_at, updated_at, recall_count
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          params.id,
          "fact",
          `subject-${params.id}`,
          `content-${params.id}`,
          params.importance,
          "temporary",
          "private",
          "recall-test.jsonl",
          "auto-strengthen",
          "2026-02-10T00:00:00.000Z",
          "2026-02-10T00:00:00.000Z",
          params.recallCount,
        ],
      });
    }

    async function readImportance(client: Client, id: string): Promise<number> {
      const row = await client.execute({
        sql: "SELECT importance FROM entries WHERE id = ?",
        args: [id],
      });
      return Number((row.rows[0] as { importance?: unknown } | undefined)?.importance ?? 0);
    }

    it("bumps importance when recall_count reaches 3", async () => {
      const client = makeClient();
      await initDb(client);
      await insertRecallEntry(client, { id: "milestone-3", importance: 5, recallCount: 2 });

      await updateRecallMetadata(client, ["milestone-3"], new Date("2026-02-15T00:00:00.000Z"));
      expect(await readImportance(client, "milestone-3")).toBe(6);
    });

    it("does not auto-promote beyond importance 9", async () => {
      const client = makeClient();
      await initDb(client);
      await insertRecallEntry(client, { id: "milestone-cap", importance: 9, recallCount: 2 });

      await updateRecallMetadata(client, ["milestone-cap"], new Date("2026-02-15T00:00:00.000Z"));
      expect(await readImportance(client, "milestone-cap")).toBe(9);
    });

    it("does not bump on non-milestone recall counts", async () => {
      const client = makeClient();
      await initDb(client);
      await insertRecallEntry(client, { id: "milestone-non", importance: 5, recallCount: 3 });

      await updateRecallMetadata(client, ["milestone-non"], new Date("2026-02-15T00:00:00.000Z"));
      expect(await readImportance(client, "milestone-non")).toBe(5);
    });

    it("bumps importance at milestones 10 and 25", async () => {
      const client = makeClient();
      await initDb(client);
      await insertRecallEntry(client, { id: "milestone-10", importance: 4, recallCount: 9 });
      await insertRecallEntry(client, { id: "milestone-25", importance: 7, recallCount: 24 });

      await updateRecallMetadata(
        client,
        ["milestone-10", "milestone-25"],
        new Date("2026-02-15T00:00:00.000Z"),
      );
      expect(await readImportance(client, "milestone-10")).toBe(5);
      expect(await readImportance(client, "milestone-25")).toBe(8);
    });
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
      expect(contents.has("Window until boundary vec-work-strong")).toBe(true);
      expect(contents.size).toBe(1);
    });

    it("filters vector path results by until", async () => {
      const client = await setupUntilFixture();
      const results = await recall(
        client,
        {
          text: "Window work",
          limit: 50,
          until: "7d",
        },
        "sk-test",
        {
          embedFn: mockEmbed,
          now: new Date("2026-02-15T00:00:00.000Z"),
        },
      );
      const contents = new Set(results.map((r) => r.entry.content));
      const ceiling = new Date("2026-02-08T00:00:00.000Z").getTime();
      // until must exclude entries newer than ceiling (2026-02-08)
      expect(contents.has("Window too recent vec-work-strong")).toBe(false);
      // every result that DID come back must be within the ceiling bound
      for (const result of results) {
        const created = new Date(result.entry.created_at);
        expect(created.getTime()).toBeLessThanOrEqual(ceiling);
      }
    });

    it("silently excludes entries with corrupt created_at when until is active", async () => {
      const client = await setupUntilFixture();
      await client.execute({
        sql: "UPDATE entries SET created_at = 'not-a-date' WHERE content = ?",
        args: ["Window middle vec-work-strong"],
      });
      const contents = await recallWindow(client, { since: "14d", until: "7d" });
      expect(contents.has("Window middle vec-work-strong")).toBe(false);
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
      // 7 days old with temporary expiry yields recency ≈ 0.97.
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

  describe("around temporal targeting", () => {
    it("throws on invalid around strings", async () => {
      const client = makeClient();
      await initDb(client);

      await expect(
        recall(
          client,
          {
            text: "",
            context: "session-start",
            around: "not-a-date",
            limit: 20,
            noUpdate: true,
          },
          "sk-test",
          { now: new Date("2026-03-01T00:00:00.000Z") },
        ),
      ).rejects.toThrow('Invalid around value "not-a-date"');
    });

    it("throws when aroundRadius is zero or negative", async () => {
      const client = makeClient();
      await initDb(client);

      await expect(
        recall(
          client,
          {
            text: "",
            context: "session-start",
            around: "2026-02-15T00:00:00.000Z",
            aroundRadius: 0,
            limit: 20,
            noUpdate: true,
          },
          "sk-test",
          { now: new Date("2026-03-01T00:00:00.000Z") },
        ),
      ).rejects.toThrow('Invalid around-radius value "0"');

      await expect(
        recall(
          client,
          {
            text: "",
            context: "session-start",
            around: "2026-02-15T00:00:00.000Z",
            aroundRadius: -5,
            limit: 20,
            noUpdate: true,
          },
          "sk-test",
          { now: new Date("2026-03-01T00:00:00.000Z") },
        ),
      ).rejects.toThrow('Invalid around-radius value "-5"');
    });

    it("shifts semantic recall scoring to favor entries near the around date", async () => {
      const client = makeClient();
      await initDb(client);

      await storeEntries(
        client,
        [
          makeEntry({ content: "around-center vec-work-strong", importance: 7 }),
          makeEntry({ content: "around-recent vec-work-strong", importance: 7 }),
          makeEntry({ content: "around-older vec-work-strong", importance: 7 }),
        ],
        "sk-test",
        {
          sourceFile: "recall-around-test.jsonl",
          ingestContentHash: "hash-around-scoring",
          embedFn: mockEmbed,
          force: true,
        },
      );

      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
        args: ["2026-02-15T00:00:00.000Z", "2026-02-15T00:00:00.000Z", "around-center vec-work-strong"],
      });
      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
        args: ["2026-02-26T00:00:00.000Z", "2026-02-26T00:00:00.000Z", "around-recent vec-work-strong"],
      });
      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
        args: ["2026-02-04T00:00:00.000Z", "2026-02-04T00:00:00.000Z", "around-older vec-work-strong"],
      });

      const now = new Date("2026-02-27T00:00:00.000Z");
      const defaultResults = await recall(
        client,
        { text: "work", limit: 3, noUpdate: true },
        "sk-test",
        { embedFn: mockEmbed, now },
      );
      expect(defaultResults[0]?.entry.content).toBe("around-recent vec-work-strong");

      const aroundResults = await recall(
        client,
        { text: "work", around: "2026-02-15T00:00:00.000Z", limit: 3, noUpdate: true },
        "sk-test",
        { embedFn: mockEmbed, now },
      );
      expect(aroundResults[0]?.entry.content).toBe("around-center vec-work-strong");
    });

    it("auto-sets since/until around the target date when not explicitly provided", async () => {
      const client = makeClient();
      await initDb(client);

      await storeEntries(
        client,
        [
          makeEntry({ content: "around-window-old vec-work-strong", importance: 7 }),
          makeEntry({ content: "around-window-low vec-work-strong", importance: 7 }),
          makeEntry({ content: "around-window-center vec-work-strong", importance: 7 }),
          makeEntry({ content: "around-window-high vec-work-strong", importance: 7 }),
          makeEntry({ content: "around-window-new vec-work-strong", importance: 7 }),
        ],
        "sk-test",
        {
          sourceFile: "recall-around-window-test.jsonl",
          ingestContentHash: "hash-around-window-defaults",
          embedFn: mockEmbed,
          force: true,
        },
      );

      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
        args: ["2026-01-20T00:00:00.000Z", "2026-01-20T00:00:00.000Z", "around-window-old vec-work-strong"],
      });
      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
        args: ["2026-02-05T00:00:00.000Z", "2026-02-05T00:00:00.000Z", "around-window-low vec-work-strong"],
      });
      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
        args: ["2026-02-15T00:00:00.000Z", "2026-02-15T00:00:00.000Z", "around-window-center vec-work-strong"],
      });
      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
        args: ["2026-02-28T00:00:00.000Z", "2026-02-28T00:00:00.000Z", "around-window-high vec-work-strong"],
      });
      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
        args: ["2026-03-05T00:00:00.000Z", "2026-03-05T00:00:00.000Z", "around-window-new vec-work-strong"],
      });

      const results = await recall(
        client,
        {
          text: "",
          context: "session-start",
          around: "2026-02-15T00:00:00.000Z",
          limit: 20,
          noUpdate: true,
        },
        "sk-test",
        { now: new Date("2026-03-01T00:00:00.000Z") },
      );

      const contents = new Set(results.map((row) => row.entry.content));
      expect(contents.has("around-window-low vec-work-strong")).toBe(true);
      expect(contents.has("around-window-center vec-work-strong")).toBe(true);
      expect(contents.has("around-window-high vec-work-strong")).toBe(true);
      expect(contents.has("around-window-old vec-work-strong")).toBe(false);
      expect(contents.has("around-window-new vec-work-strong")).toBe(false);
    });

    it("does not auto-set the missing bound when only one explicit date bound is provided", async () => {
      const client = makeClient();
      await initDb(client);

      await storeEntries(
        client,
        [
          makeEntry({ content: "around-partial-before vec-work-strong", importance: 7 }),
          makeEntry({ content: "around-partial-near vec-work-strong", importance: 7 }),
          makeEntry({ content: "around-partial-late vec-work-strong", importance: 7 }),
        ],
        "sk-test",
        {
          sourceFile: "recall-around-partial-window-test.jsonl",
          ingestContentHash: "hash-around-partial-window",
          embedFn: mockEmbed,
          force: true,
        },
      );

      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
        args: ["2026-02-05T00:00:00.000Z", "2026-02-05T00:00:00.000Z", "around-partial-before vec-work-strong"],
      });
      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
        args: ["2026-02-20T00:00:00.000Z", "2026-02-20T00:00:00.000Z", "around-partial-near vec-work-strong"],
      });
      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
        args: ["2026-03-05T00:00:00.000Z", "2026-03-05T00:00:00.000Z", "around-partial-late vec-work-strong"],
      });

      const results = await recall(
        client,
        {
          text: "",
          context: "session-start",
          around: "2026-02-15T00:00:00.000Z",
          since: "2026-02-10T00:00:00.000Z",
          limit: 20,
          noUpdate: true,
        },
        "sk-test",
        { now: new Date("2026-03-10T00:00:00.000Z") },
      );

      const contents = new Set(results.map((row) => row.entry.content));
      expect(contents.has("around-partial-before vec-work-strong")).toBe(false);
      expect(contents.has("around-partial-near vec-work-strong")).toBe(true);
      expect(contents.has("around-partial-late vec-work-strong")).toBe(true);
    });

    it("respects explicit since/until when around is provided", async () => {
      const client = makeClient();
      await initDb(client);

      await storeEntries(
        client,
        [
          makeEntry({ content: "around-explicit-center vec-work-strong", importance: 7 }),
          makeEntry({ content: "around-explicit-in-range vec-work-strong", importance: 7 }),
        ],
        "sk-test",
        {
          sourceFile: "recall-around-explicit-test.jsonl",
          ingestContentHash: "hash-around-explicit-range",
          embedFn: mockEmbed,
          force: true,
        },
      );

      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
        args: ["2026-02-15T00:00:00.000Z", "2026-02-15T00:00:00.000Z", "around-explicit-center vec-work-strong"],
      });
      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
        args: ["2026-02-24T00:00:00.000Z", "2026-02-24T00:00:00.000Z", "around-explicit-in-range vec-work-strong"],
      });

      const results = await recall(
        client,
        {
          text: "",
          context: "session-start",
          around: "2026-02-15T00:00:00.000Z",
          since: "2026-02-20T00:00:00.000Z",
          until: "2026-02-26T00:00:00.000Z",
          limit: 20,
          noUpdate: true,
        },
        "sk-test",
        { now: new Date("2026-03-01T00:00:00.000Z") },
      );

      expect(results.map((row) => row.entry.content)).toEqual(["around-explicit-in-range vec-work-strong"]);
    });

    it("around radius changes both gaussian width and default window size", async () => {
      const around = new Date("2026-02-15T00:00:00.000Z");
      const narrow = gaussianRecency(new Date("2026-02-21T00:00:00.000Z"), around, 6);
      const wide = gaussianRecency(new Date("2026-02-21T00:00:00.000Z"), around, 20);
      expect(wide).toBeGreaterThan(narrow);

      const client = makeClient();
      await initDb(client);
      await storeEntries(
        client,
        [
          makeEntry({ content: "around-radius-center vec-work-strong", importance: 7 }),
          makeEntry({ content: "around-radius-edge vec-work-strong", importance: 7 }),
        ],
        "sk-test",
        {
          sourceFile: "recall-around-radius-test.jsonl",
          ingestContentHash: "hash-around-radius-window",
          embedFn: mockEmbed,
          force: true,
        },
      );

      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
        args: ["2026-02-15T00:00:00.000Z", "2026-02-15T00:00:00.000Z", "around-radius-center vec-work-strong"],
      });
      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
        args: ["2026-02-25T00:00:00.000Z", "2026-02-25T00:00:00.000Z", "around-radius-edge vec-work-strong"],
      });

      const narrowResults = await recall(
        client,
        {
          text: "",
          context: "session-start",
          around: "2026-02-15T00:00:00.000Z",
          aroundRadius: 7,
          limit: 20,
          noUpdate: true,
        },
        "sk-test",
        { now: new Date("2026-03-01T00:00:00.000Z") },
      );
      expect(narrowResults.map((row) => row.entry.content)).toEqual(["around-radius-center vec-work-strong"]);

      const wideResults = await recall(
        client,
        {
          text: "",
          context: "session-start",
          around: "2026-02-15T00:00:00.000Z",
          aroundRadius: 14,
          limit: 20,
          noUpdate: true,
        },
        "sk-test",
        { now: new Date("2026-03-01T00:00:00.000Z") },
      );
      expect(new Set(wideResults.map((row) => row.entry.content))).toEqual(
        new Set(["around-radius-center vec-work-strong", "around-radius-edge vec-work-strong"]),
      );
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
    expect(columns.has("quality_score")).toBe(true);
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

  describe("browse mode", () => {
    let hashCounter = 0;

    async function storeBrowseEntries(client: Client, entries: KnowledgeEntry[]): Promise<void> {
      hashCounter += 1;
      await storeEntries(client, entries, "sk-test", {
        sourceFile: "recall-browse-test.jsonl",
        ingestContentHash: `hash-browse-${hashCounter}`,
        embedFn: mockEmbed,
        force: true,
      });
    }

    async function setCreatedAt(client: Client, content: string, iso: string): Promise<void> {
      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ? WHERE content = ?",
        args: [iso, iso, content],
      });
    }

    it("returns entries sorted by importance descending", async () => {
      const client = makeClient();
      await initDb(client);
      await storeBrowseEntries(client, [
        makeEntry({ content: "browse-imp-9 vec-work-strong", importance: 9 }),
        makeEntry({ content: "browse-imp-7 vec-work-strong", importance: 7 }),
        makeEntry({ content: "browse-imp-5 vec-work-strong", importance: 5 }),
        makeEntry({ content: "browse-imp-8 vec-work-strong", importance: 8 }),
        makeEntry({ content: "browse-imp-3 vec-work-strong", importance: 3 }),
      ]);

      const fixedNow = new Date("2026-02-23T00:00:00.000Z");
      await client.execute({
        sql: "UPDATE entries SET created_at = ?, updated_at = ?",
        args: ["2026-02-22T23:30:00.000Z", "2026-02-22T23:30:00.000Z"],
      });

      const results = await recall(client, { browse: true, limit: 10 }, "", { now: fixedNow });
      expect(results).toHaveLength(5);
      expect(results.map((row) => row.entry.importance)).toEqual([9, 8, 7, 5, 3]);
    });

    it("applies since filter and excludes old entries", async () => {
      const client = makeClient();
      await initDb(client);

      const oldEntries = Array.from({ length: 5 }, (_, index) =>
        makeEntry({ content: `browse-since-old-${index} vec-work-strong`, importance: 6 }),
      );
      const freshEntries = Array.from({ length: 5 }, (_, index) =>
        makeEntry({ content: `browse-since-fresh-${index} vec-work-strong`, importance: 7 }),
      );
      await storeBrowseEntries(client, [...oldEntries, ...freshEntries]);

      for (const entry of oldEntries) {
        await setCreatedAt(client, entry.content, "2026-02-21T23:00:00.000Z");
      }
      for (const entry of freshEntries) {
        await setCreatedAt(client, entry.content, "2026-02-22T23:00:00.000Z");
      }

      const fixedNow = new Date("2026-02-23T00:00:00.000Z");
      const cutoffMs = fixedNow.getTime() - 24 * 60 * 60 * 1000;
      const results = await recall(client, { browse: true, since: "1d", limit: 20 }, "", { now: fixedNow });
      expect(results).toHaveLength(5);
      for (const result of results) {
        expect(new Date(result.entry.created_at).getTime()).toBeGreaterThanOrEqual(cutoffMs);
      }
    });

    it("applies until filter and excludes recent entries", async () => {
      const client = makeClient();
      await initDb(client);
      await storeBrowseEntries(client, [
        makeEntry({ content: "browse-until-old-1 vec-work-strong", importance: 7 }),
        makeEntry({ content: "browse-until-old-2 vec-work-strong", importance: 7 }),
        makeEntry({ content: "browse-until-old-3 vec-work-strong", importance: 7 }),
        makeEntry({ content: "browse-until-new-1 vec-work-strong", importance: 7 }),
        makeEntry({ content: "browse-until-new-2 vec-work-strong", importance: 7 }),
        makeEntry({ content: "browse-until-new-3 vec-work-strong", importance: 7 }),
      ]);

      await setCreatedAt(client, "browse-until-old-1 vec-work-strong", "2026-01-10T00:00:00.000Z");
      await setCreatedAt(client, "browse-until-old-2 vec-work-strong", "2026-01-10T01:00:00.000Z");
      await setCreatedAt(client, "browse-until-old-3 vec-work-strong", "2026-01-10T02:00:00.000Z");
      await setCreatedAt(client, "browse-until-new-1 vec-work-strong", "2026-02-20T00:00:00.000Z");
      await setCreatedAt(client, "browse-until-new-2 vec-work-strong", "2026-02-20T01:00:00.000Z");
      await setCreatedAt(client, "browse-until-new-3 vec-work-strong", "2026-02-20T02:00:00.000Z");

      const results = await recall(
        client,
        { browse: true, until: "2026-01-15T00:00:00.000Z", limit: 20 },
        "",
        { now: new Date("2026-02-23T00:00:00.000Z") },
      );
      expect(results).toHaveLength(3);
      expect(results.every((row) => row.entry.created_at.startsWith("2026-01-10"))).toBe(true);
    });

    it("returns only entries inside a since and until window", async () => {
      const client = makeClient();
      await initDb(client);
      await storeBrowseEntries(client, [
        makeEntry({ content: "browse-window-too-old vec-work-strong", importance: 7 }),
        makeEntry({ content: "browse-window-boundary-low vec-work-strong", importance: 7 }),
        makeEntry({ content: "browse-window-middle vec-work-strong", importance: 7 }),
        makeEntry({ content: "browse-window-boundary-high vec-work-strong", importance: 7 }),
        makeEntry({ content: "browse-window-too-recent vec-work-strong", importance: 7 }),
      ]);

      await setCreatedAt(client, "browse-window-too-old vec-work-strong", "2026-01-25T00:00:00.000Z");
      await setCreatedAt(client, "browse-window-boundary-low vec-work-strong", "2026-02-01T00:00:00.000Z");
      await setCreatedAt(client, "browse-window-middle vec-work-strong", "2026-02-05T00:00:00.000Z");
      await setCreatedAt(client, "browse-window-boundary-high vec-work-strong", "2026-02-08T00:00:00.000Z");
      await setCreatedAt(client, "browse-window-too-recent vec-work-strong", "2026-02-12T00:00:00.000Z");

      const fixedNow = new Date("2026-02-15T00:00:00.000Z");
      const results = await recall(
        client,
        {
          browse: true,
          since: "14d",
          until: "2026-02-09T00:00:00.000Z",
          limit: 20,
        },
        "",
        { now: fixedNow },
      );

      const contents = new Set(results.map((row) => row.entry.content));
      expect(results).toHaveLength(3);
      expect(contents).toEqual(
        new Set([
          "browse-window-boundary-low vec-work-strong",
          "browse-window-middle vec-work-strong",
          "browse-window-boundary-high vec-work-strong",
        ]),
      );
    });

    it("supports around targeting in browse mode", async () => {
      const client = makeClient();
      await initDb(client);
      await storeBrowseEntries(client, [
        makeEntry({ content: "browse-around-before vec-work-strong", importance: 7 }),
        makeEntry({ content: "browse-around-center vec-work-strong", importance: 7 }),
        makeEntry({ content: "browse-around-after vec-work-strong", importance: 7 }),
        makeEntry({ content: "browse-around-too-old vec-work-strong", importance: 7 }),
      ]);

      await setCreatedAt(client, "browse-around-before vec-work-strong", "2026-02-10T00:00:00.000Z");
      await setCreatedAt(client, "browse-around-center vec-work-strong", "2026-02-15T00:00:00.000Z");
      await setCreatedAt(client, "browse-around-after vec-work-strong", "2026-02-20T00:00:00.000Z");
      await setCreatedAt(client, "browse-around-too-old vec-work-strong", "2026-01-20T00:00:00.000Z");

      const results = await recall(
        client,
        {
          browse: true,
          around: "2026-02-15T00:00:00.000Z",
          limit: 10,
        },
        "",
        { now: new Date("2026-02-27T00:00:00.000Z") },
      );

      expect(results.map((row) => row.entry.content)).not.toContain("browse-around-too-old vec-work-strong");
      expect(results[0]?.entry.content).toBe("browse-around-center vec-work-strong");
    });

    it("respects limit in browse mode", async () => {
      const client = makeClient();
      await initDb(client);
      const entries = Array.from({ length: 100 }, (_, index) =>
        makeEntry({ content: `browse-limit-${index} vec-work-strong`, importance: 6 }),
      );
      await storeBrowseEntries(client, entries);
      const results = await recall(client, { browse: true, limit: 5 }, "", { now: new Date("2026-02-23T00:00:00.000Z") });
      expect(results).toHaveLength(5);
    });

    it("returns empty array for an empty browse window", async () => {
      const client = makeClient();
      await initDb(client);
      await storeBrowseEntries(client, [
        makeEntry({ content: "browse-empty-1 vec-work-strong", importance: 7 }),
        makeEntry({ content: "browse-empty-2 vec-work-strong", importance: 7 }),
        makeEntry({ content: "browse-empty-3 vec-work-strong", importance: 7 }),
      ]);
      await setCreatedAt(client, "browse-empty-1 vec-work-strong", "2026-01-01T00:00:00.000Z");
      await setCreatedAt(client, "browse-empty-2 vec-work-strong", "2026-01-01T01:00:00.000Z");
      await setCreatedAt(client, "browse-empty-3 vec-work-strong", "2026-01-01T02:00:00.000Z");

      const results = await recall(
        client,
        { browse: true, since: "1d", limit: 10 },
        "",
        { now: new Date("2026-02-23T00:00:00.000Z") },
      );

      expect(results).toHaveLength(0);
    });

    it("excludes retired entries in browse mode", async () => {
      const client = makeClient();
      await initDb(client);
      await storeBrowseEntries(client, [
        makeEntry({ content: "browse-retired-active-1 vec-work-strong", importance: 7 }),
        makeEntry({ content: "browse-retired-hidden vec-work-strong", importance: 9 }),
        makeEntry({ content: "browse-retired-active-2 vec-work-strong", importance: 8 }),
      ]);
      await client.execute({
        sql: "UPDATE entries SET retired = 1, retired_at = ? WHERE content = ?",
        args: ["2026-02-23T00:00:00.000Z", "browse-retired-hidden vec-work-strong"],
      });

      const results = await recall(client, { browse: true, limit: 10 }, "", { now: new Date("2026-02-23T00:00:00.000Z") });
      expect(results).toHaveLength(2);
      expect(results.some((row) => row.entry.content === "browse-retired-hidden vec-work-strong")).toBe(false);
    });

    it("excludes superseded entries in browse mode", async () => {
      const client = makeClient();
      await initDb(client);
      await storeBrowseEntries(client, [
        makeEntry({ content: "browse-superseded-active-1 vec-work-strong", importance: 7 }),
        makeEntry({ content: "browse-superseded-hidden vec-work-strong", importance: 9 }),
        makeEntry({ content: "browse-superseded-active-2 vec-work-strong", importance: 8 }),
      ]);
      await client.execute({
        sql: `
          UPDATE entries
          SET superseded_by = (SELECT id FROM entries WHERE content = ? LIMIT 1)
          WHERE content = ?
        `,
        args: ["browse-superseded-active-1 vec-work-strong", "browse-superseded-hidden vec-work-strong"],
      });

      const results = await recall(client, { browse: true, limit: 10 }, "", { now: new Date("2026-02-23T00:00:00.000Z") });
      expect(results).toHaveLength(2);
      expect(results.some((row) => row.entry.content === "browse-superseded-hidden vec-work-strong")).toBe(false);
    });

    it("filters browse results by platform", async () => {
      const client = makeClient();
      await initDb(client);
      await storeBrowseEntries(client, [
        { ...makeEntry({ content: "browse-platform-openclaw-1 vec-work-strong", importance: 7 }), platform: "openclaw" as const },
        { ...makeEntry({ content: "browse-platform-openclaw-2 vec-work-strong", importance: 6 }), platform: "openclaw" as const },
        { ...makeEntry({ content: "browse-platform-codex-1 vec-work-strong", importance: 8 }), platform: "codex" as const },
        { ...makeEntry({ content: "browse-platform-codex-2 vec-work-strong", importance: 5 }), platform: "codex" as const },
      ]);

      const results = await recall(
        client,
        { browse: true, platform: "openclaw", limit: 10 },
        "",
        { now: new Date("2026-02-23T00:00:00.000Z") },
      );
      expect(results).toHaveLength(2);
      expect(results.every((row) => row.entry.platform === "openclaw")).toBe(true);
    });

    it("filters browse results by minImportance", async () => {
      const client = makeClient();
      await initDb(client);
      await storeBrowseEntries(client, [
        makeEntry({ content: "browse-min-3 vec-work-strong", importance: 3 }),
        makeEntry({ content: "browse-min-5 vec-work-strong", importance: 5 }),
        makeEntry({ content: "browse-min-6 vec-work-strong", importance: 6 }),
        makeEntry({ content: "browse-min-7 vec-work-strong", importance: 7 }),
        makeEntry({ content: "browse-min-9 vec-work-strong", importance: 9 }),
      ]);

      const results = await recall(
        client,
        { browse: true, minImportance: 6, limit: 10 },
        "",
        { now: new Date("2026-02-23T00:00:00.000Z") },
      );
      expect(results).toHaveLength(3);
      expect(results.every((row) => row.entry.importance >= 6)).toBe(true);
    });

    it("does not call embed in browse mode", async () => {
      const client = makeClient();
      await initDb(client);
      await storeBrowseEntries(client, [
        makeEntry({ content: "browse-no-embed-1 vec-work-strong", importance: 7 }),
        makeEntry({ content: "browse-no-embed-2 vec-work-strong", importance: 7 }),
        makeEntry({ content: "browse-no-embed-3 vec-work-strong", importance: 7 }),
      ]);

      const spyEmbed = vi.fn().mockRejectedValue(new Error("embed called"));
      const results = await recall(
        client,
        { browse: true, limit: 10 },
        "",
        { now: new Date("2026-02-23T00:00:00.000Z"), embedFn: spyEmbed },
      );
      expect(results).toHaveLength(3);
      expect(spyEmbed).not.toHaveBeenCalled();
    });

    it("does not increment recall_count after browse", async () => {
      const client = makeClient();
      await initDb(client);

      const entry = makeEntry({
        content: "browse-no-metadata-update vec-work-strong",
        importance: 7,
      });
      await storeBrowseEntries(client, [entry]);

      const fixedNow = new Date("2026-02-23T12:00:00.000Z");
      await recall(client, { browse: true, limit: 10 }, "", { now: fixedNow });

      const result = await client.execute({
        sql: "SELECT recall_count, last_recalled_at FROM entries WHERE content = ?",
        args: [entry.content],
      });

      const row = result.rows[0] as { recall_count?: unknown; last_recalled_at?: unknown } | undefined;
      expect(row).toBeDefined();
      expect(asNumber(row?.recall_count)).toBe(0);
      expect(row?.last_recalled_at).toBeNull();
    });

    it("throws when noBoost is used in browse mode", async () => {
      const client = makeClient();
      await initDb(client);

      await expect(
        recall(
          client,
          { browse: true, noBoost: true, limit: 10 },
          "",
          { now: new Date("2026-02-23T00:00:00.000Z") },
        ),
      ).rejects.toThrow("--no-boost is not applicable in browse mode");
    });

    it("orders same-importance entries by most recent first", async () => {
      const client = makeClient();
      await initDb(client);
      await storeBrowseEntries(client, [
        makeEntry({ content: "entry-a vec-work-strong", importance: 7 }),
        makeEntry({ content: "entry-b vec-work-strong", importance: 7 }),
        makeEntry({ content: "entry-c vec-work-strong", importance: 7 }),
      ]);
      await setCreatedAt(client, "entry-a vec-work-strong", "2026-02-20T00:00:00.000Z");
      await setCreatedAt(client, "entry-b vec-work-strong", "2026-02-22T00:00:00.000Z");
      await setCreatedAt(client, "entry-c vec-work-strong", "2026-02-21T00:00:00.000Z");

      const fixedNow = new Date("2026-02-23T00:00:00.000Z");
      const results = await recall(client, { browse: true, limit: 10 }, "", { now: fixedNow });
      expect(results[0]?.entry.content).toBe("entry-b vec-work-strong");
      expect(results[1]?.entry.content).toBe("entry-c vec-work-strong");
      expect(results[2]?.entry.content).toBe("entry-a vec-work-strong");

      expect(results[0]!.score).toBeCloseTo(scoreBrowseEntry(results[0]!.entry, fixedNow));
      expect(results[0]!.score).toBeGreaterThan(0);
      expect(results[0]!.score).toBeLessThanOrEqual(1);
    });

    it("applies project filtering in browse mode", async () => {
      const client = makeClient();
      await initDb(client);
      await storeBrowseEntries(client, [
        { ...makeEntry({ content: "browse-project-alpha-1 vec-work-strong", importance: 7 }), project: "alpha" },
        { ...makeEntry({ content: "browse-project-alpha-2 vec-work-strong", importance: 8 }), project: "alpha" },
        { ...makeEntry({ content: "browse-project-beta-1 vec-work-strong", importance: 9 }), project: "beta" },
        { ...makeEntry({ content: "browse-project-beta-2 vec-work-strong", importance: 6 }), project: "beta" },
      ]);

      const results = await recall(
        client,
        { browse: true, project: "alpha", projectStrict: true, limit: 10 },
        "",
        { now: new Date("2026-02-23T00:00:00.000Z") },
      );
      expect(results).toHaveLength(2);
      expect(results.every((row) => row.entry.project === "alpha")).toBe(true);
    });

    it("applies type filtering in browse mode", async () => {
      const client = makeClient();
      await initDb(client);
      await storeBrowseEntries(client, [
        makeEntry({ content: "browse-type-fact-1 vec-work-strong", type: "fact", importance: 7 }),
        makeEntry({ content: "browse-type-todo-1 vec-work-strong", type: "todo", importance: 7 }),
        makeEntry({ content: "browse-type-fact-2 vec-work-strong", type: "fact", importance: 7 }),
        makeEntry({ content: "browse-type-preference-1 vec-work-strong", type: "preference", importance: 7 }),
      ]);

      const results = await recall(
        client,
        { browse: true, types: ["fact"], limit: 10 },
        "",
        { now: new Date("2026-02-23T00:00:00.000Z") },
      );
      expect(results).toHaveLength(2);
      expect(results.every((row) => row.entry.type === "fact")).toBe(true);
    });
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
