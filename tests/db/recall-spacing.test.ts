import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../../src/db/client.js";
import {
  computeSpacingFactor,
  recall,
  recallStrength,
  recency,
  scoreEntryWithBreakdown,
  updateRecallMetadata,
} from "../../src/db/recall.js";
import { initSchema } from "../../src/db/schema.js";
import { mapRawStoredEntry } from "../../src/db/stored-entry.js";
import type { StoredEntry } from "../../src/types.js";

const ONE_DAY_SECS = 86400;
const SEVEN_DAYS_SECS = 86400 * 7;
const t1 = 1708300000;

function to1024(head: number[]): number[] {
  return [...head, ...Array.from({ length: Math.max(0, 1024 - head.length) }, () => 0)];
}

function parseIntervals(raw: unknown): number[] {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return [];
  }
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed.filter((value): value is number => typeof value === "number") : [];
}

function makeEntry(overrides: Partial<StoredEntry> = {}): StoredEntry {
  return {
    id: "test-id",
    type: "fact",
    subject: "test subject",
    content: "test content",
    importance: 7,
    expiry: "permanent",
    scope: "private",
    tags: [],
    source: { file: "", context: "" },
    embedding: undefined,
    created_at: new Date(Date.now() - 30 * ONE_DAY_SECS * 1000).toISOString(),
    updated_at: new Date().toISOString(),
    recall_count: 5,
    recall_intervals: undefined,
    confirmations: 0,
    contradictions: 0,
    ...overrides,
  };
}

async function insertEntry(
  db: Client,
  id: string,
  options: {
    recallCount?: number;
    recallIntervals?: string | null;
    createdAt?: string;
    updatedAt?: string;
    lastRecalledAt?: string | null;
    embedding?: number[];
  } = {},
): Promise<void> {
  const createdAt = options.createdAt ?? "2026-01-01T00:00:00.000Z";
  const updatedAt = options.updatedAt ?? createdAt;
  const lastRecalledAt = options.lastRecalledAt ?? null;
  const recallCount = options.recallCount ?? 0;
  const recallIntervals = options.recallIntervals ?? null;

  if (options.embedding) {
    await db.execute({
      sql: `
        INSERT INTO entries (
          id, type, subject, content, importance, expiry, scope, source_file, source_context,
          embedding, created_at, updated_at, last_recalled_at, recall_count, recall_intervals,
          confirmations, contradictions
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, vector32(?), ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        id,
        "fact",
        "Subject",
        `Content ${id}`,
        8,
        "permanent",
        "private",
        "recall-spacing.test",
        "test",
        JSON.stringify(options.embedding),
        createdAt,
        updatedAt,
        lastRecalledAt,
        recallCount,
        recallIntervals,
        0,
        0,
      ],
    });
    return;
  }

  await db.execute({
    sql: `
      INSERT INTO entries (
        id, type, subject, content, importance, expiry, scope, source_file, source_context,
        created_at, updated_at, last_recalled_at, recall_count, recall_intervals, confirmations, contradictions
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      id,
      "fact",
      "Subject",
      `Content ${id}`,
      8,
      "permanent",
      "private",
      "recall-spacing.test",
      "test",
      createdAt,
      updatedAt,
      lastRecalledAt,
      recallCount,
      recallIntervals,
      0,
      0,
    ],
  });
}

describe("recall spacing", () => {
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

  describe("computeSpacingFactor", () => {
    it("returns 1.0 for empty arrays", () => {
      expect(computeSpacingFactor([])).toBe(1.0);
    });

    it("returns 1.0 for a single timestamp", () => {
      expect(computeSpacingFactor([t1])).toBe(1.0);
    });

    it("returns immediate bonus for a 1-day interval", () => {
      expect(computeSpacingFactor([t1, t1 + ONE_DAY_SECS])).toBeCloseTo(Math.log1p(2), 4);
    });

    it("returns a strong bonus for a 7-day interval", () => {
      expect(computeSpacingFactor([t1, t1 + SEVEN_DAYS_SECS])).toBeCloseTo(Math.log1p(8), 4);
    });

    it("treats same-timestamp cramming as neutral", () => {
      expect(computeSpacingFactor([t1, t1, t1, t1, t1])).toBe(1.0);
    });

    it("uses max gap, not mean gap", () => {
      const ts = [t1, t1 + ONE_DAY_SECS, t1 + 2 * ONE_DAY_SECS, t1 + 3 * ONE_DAY_SECS, t1 + 10 * ONE_DAY_SECS];
      expect(computeSpacingFactor(ts)).toBeCloseTo(Math.log1p(8), 4);
    });

    it("rewards growing SM-2 style intervals", () => {
      const growing = [
        t1,
        t1 + ONE_DAY_SECS,
        t1 + 3 * ONE_DAY_SECS,
        t1 + 7 * ONE_DAY_SECS,
        t1 + 15 * ONE_DAY_SECS,
        t1 + 31 * ONE_DAY_SECS,
      ];
      expect(computeSpacingFactor(growing)).toBeCloseTo(Math.log1p(17), 4);
    });

    it("handles out-of-order timestamps", () => {
      const skewed = [t1 + ONE_DAY_SECS, t1, t1 + SEVEN_DAYS_SECS];
      const result = computeSpacingFactor(skewed);
      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(1.0);
    });

    it("does not mutate input arrays", () => {
      const arr = [t1, t1 + SEVEN_DAYS_SECS];
      const original = [...arr];
      computeSpacingFactor(arr);
      expect(arr).toEqual(original);
    });

    it("imputes legacy intervals when recall_count exists", () => {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * ONE_DAY_SECS * 1000).toISOString();
      const factor = computeSpacingFactor([], 3, thirtyDaysAgo, now.toISOString());
      expect(factor).toBeGreaterThan(1.0);
    });

    it("imputes a full created-to-last gap when recall_count is 1", () => {
      const factor = computeSpacingFactor([], 1, "2025-01-01T00:00:00.000Z", "2025-06-30T00:00:00.000Z");
      expect(factor).toBeGreaterThan(1.1);
    });

    it("returns neutral when recall_count is zero", () => {
      expect(computeSpacingFactor([], 0, "2025-01-01T00:00:00Z", "2026-01-01T00:00:00Z")).toBe(1.0);
    });

    it("returns neutral when legacy createdAt and lastRecalledAt are identical", () => {
      expect(computeSpacingFactor([], 2, "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z")).toBe(1.0);
    });

    it("returns neutral for unparseable legacy timestamps", () => {
      expect(computeSpacingFactor([], 2, "garbage", "also-garbage")).toBe(1.0);
    });

    it("stays finite for backward/negative-gap timestamp ordering", () => {
      const backward = [t1 + SEVEN_DAYS_SECS, t1];
      const result = computeSpacingFactor(backward);
      expect(Number.isFinite(result)).toBe(true);
    });
  });

  describe("scoreEntryWithBreakdown", () => {
    it("scores spaced recalls higher than crammed recalls", () => {
      const now = new Date();
      const crammed = makeEntry({
        recall_intervals: [t1, t1 + 100, t1 + 200, t1 + 300, t1 + 400],
      });
      const spaced = makeEntry({
        recall_intervals: [t1, t1 + ONE_DAY_SECS, t1 + 3 * ONE_DAY_SECS, t1 + 7 * ONE_DAY_SECS, t1 + 15 * ONE_DAY_SECS],
      });

      const crammedScore = scoreEntryWithBreakdown(crammed, 0.8, false, now).score;
      const spacedScore = scoreEntryWithBreakdown(spaced, 0.8, false, now).score;
      expect(spacedScore).toBeGreaterThan(crammedScore);
    });

    it("always reports spacing >= 1.0", () => {
      const entry = makeEntry({ recall_intervals: [t1, t1 + SEVEN_DAYS_SECS] });
      const { scores } = scoreEntryWithBreakdown(entry, 0.5, false, new Date());
      expect(scores.spacing).toBeGreaterThanOrEqual(1.0);
    });

    it("lets high-importance entries benefit from spacing", () => {
      const now = new Date();
      const highImpCrammed = makeEntry({ importance: 9, recall_intervals: [t1, t1 + 100] });
      const highImpSpaced = makeEntry({ importance: 9, recall_intervals: [t1, t1 + 30 * ONE_DAY_SECS] });
      const crammedScore = scoreEntryWithBreakdown(highImpCrammed, 0.5, false, now).score;
      const spacedScore = scoreEntryWithBreakdown(highImpSpaced, 0.5, false, now).score;
      expect(spacedScore).toBeGreaterThan(crammedScore);
    });

    it("keeps score bounded at <= 1.0 with extreme spacing", () => {
      const now = new Date("2026-02-19T12:00:00.000Z");
      const entry = makeEntry({
        expiry: "core",
        importance: 8,
        created_at: "2026-02-19T10:00:00.000Z",
        recall_count: 1,
        recall_intervals: [t1, t1 + 100 * ONE_DAY_SECS],
      });
      const scored = scoreEntryWithBreakdown(entry, 1.0, false, now);
      expect(scored.score).toBeLessThanOrEqual(1.0);
    });

    it("keeps recallStrength behavior unchanged", () => {
      expect(recallStrength(0, 10, "permanent")).toBe(0);
      expect(recallStrength(5, 0, "core")).toBe(1.0);
      expect(recallStrength(5, 7, "permanent")).toBeCloseTo(
        Math.min(Math.pow(5, 0.7) / 5, 1.0) * recency(7, "permanent"),
        6,
      );
    });
  });

  describe("updateRecallMetadata", () => {
    it("appends one interval for all ids in a bulk call", async () => {
      const client = makeClient();
      await initDb(client);

      const ids = ["a", "b", "c", "d", "e"];
      for (const id of ids) {
        await insertEntry(client, id);
      }

      const now = new Date("2026-02-19T12:00:00.000Z");
      await updateRecallMetadata(client, ids, now);

      const rows = await client.execute({
        sql: "SELECT id, recall_intervals FROM entries WHERE id IN (?, ?, ?, ?, ?)",
        args: ids,
      });
      const intervalsById = new Map<string, number[]>();
      for (const row of rows.rows) {
        intervalsById.set(String(row.id), parseIntervals(row.recall_intervals));
      }

      for (const id of ids) {
        expect(intervalsById.get(id)).toHaveLength(1);
      }
    });

    it("handles partial overlap updates without dropping appends", async () => {
      const client = makeClient();
      await initDb(client);

      await insertEntry(client, "A");
      await insertEntry(client, "B");
      await insertEntry(client, "C");

      await updateRecallMetadata(client, ["A", "B"], new Date("2026-02-19T12:00:00.000Z"));
      await updateRecallMetadata(client, ["B", "C"], new Date("2026-02-19T13:00:00.000Z"));

      const rows = await client.execute({
        sql: "SELECT id, recall_intervals FROM entries WHERE id IN (?, ?, ?)",
        args: ["A", "B", "C"],
      });
      const byId = new Map<string, number[]>();
      for (const row of rows.rows) {
        byId.set(String(row.id), parseIntervals(row.recall_intervals));
      }

      expect(byId.get("A")).toHaveLength(1);
      expect(byId.get("B")).toHaveLength(2);
      expect(byId.get("C")).toHaveLength(1);
    });

    it("preserves append order across repeated calls", async () => {
      const client = makeClient();
      await initDb(client);
      await insertEntry(client, "ordered");

      const first = new Date("2026-02-19T12:00:00.000Z");
      const second = new Date("2026-02-19T12:10:00.000Z");
      const third = new Date("2026-02-19T12:20:00.000Z");

      await updateRecallMetadata(client, ["ordered"], first);
      await updateRecallMetadata(client, ["ordered"], second);
      await updateRecallMetadata(client, ["ordered"], third);

      const row = await client.execute({
        sql: "SELECT recall_intervals FROM entries WHERE id = ?",
        args: ["ordered"],
      });
      const intervals = parseIntervals(row.rows[0]?.recall_intervals);
      expect(intervals).toEqual([
        Math.floor(first.getTime() / 1000),
        Math.floor(second.getTime() / 1000),
        Math.floor(third.getTime() / 1000),
      ]);
    });

    it("is safe under concurrent updates to the same id", async () => {
      const client = makeClient();
      await initDb(client);
      await insertEntry(client, "concurrent");

      await Promise.all([
        updateRecallMetadata(client, ["concurrent"], new Date("2026-02-19T12:00:00.000Z")),
        updateRecallMetadata(client, ["concurrent"], new Date("2026-02-19T12:00:01.000Z")),
      ]);

      const row = await client.execute({
        sql: "SELECT recall_intervals FROM entries WHERE id = ?",
        args: ["concurrent"],
      });
      const intervals = parseIntervals(row.rows[0]?.recall_intervals);
      expect(intervals).toHaveLength(2);
    });

    it("stores timestamps in epoch seconds, not milliseconds", async () => {
      const client = makeClient();
      await initDb(client);
      await insertEntry(client, "unit-check");

      const before = Math.floor(Date.now() / 1000);
      await updateRecallMetadata(client, ["unit-check"], new Date());
      const after = Math.floor(Date.now() / 1000);

      const row = await client.execute({
        sql: "SELECT recall_intervals FROM entries WHERE id = ?",
        args: ["unit-check"],
      });
      const intervals = parseIntervals(row.rows[0]?.recall_intervals);
      expect(intervals[0]).toBeGreaterThanOrEqual(before);
      expect(intervals[0]).toBeLessThanOrEqual(after + 1);
    });

  });

  describe("mapRawStoredEntry", () => {
    it("falls back to spacing 1.0 for corrupt recall_intervals JSON", async () => {
      const client = makeClient();
      await initDb(client);

      await insertEntry(client, "bad-json", {
        recallCount: 0,
        recallIntervals: "not-json",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const row = await client.execute({
        sql: `
          SELECT
            id, type, subject, content, importance, expiry, scope, platform, project,
            source_file, source_context, created_at, updated_at, last_recalled_at,
            recall_count, recall_intervals, confirmations, contradictions, superseded_by,
            retired, retired_at, retired_reason, suppressed_contexts
          FROM entries
          WHERE id = ?
        `,
        args: ["bad-json"],
      });
      const entry = mapRawStoredEntry(row.rows[0] as Record<string, unknown>, { tags: [] });
      const scored = scoreEntryWithBreakdown(entry, 1, false, new Date("2026-02-01T00:00:00.000Z"));

      expect(scored.score).toBeGreaterThanOrEqual(0);
      expect(scored.scores.spacing).toBe(1.0);
    });
  });

  describe("recall() spacing integration", () => {
    it("does not crash scoring when recall_intervals is NULL for legacy rows", async () => {
      const client = makeClient();
      await initDb(client);

      await insertEntry(client, "legacy-null", {
        recallCount: 3,
        recallIntervals: null,
        createdAt: "2025-12-01T00:00:00.000Z",
        updatedAt: "2025-12-01T00:00:00.000Z",
        lastRecalledAt: "2026-01-30T00:00:00.000Z",
      });

      const results = await recall(
        client,
        {
          text: "",
          context: "session-start",
          limit: 5,
          noUpdate: true,
        },
        "sk-test",
        { now: new Date("2026-02-01T00:00:00.000Z") },
      );

      const legacy = results.find((item) => item.entry.id === "legacy-null");
      expect(legacy).toBeTruthy();
      expect(legacy!.score).toBeGreaterThanOrEqual(0);
    });

    it("uses recall_intervals in session-start candidate scoring", async () => {
      const client = makeClient();
      await initDb(client);

      await insertEntry(client, "session-spaced", {
        recallCount: 0,
        recallIntervals: JSON.stringify([t1, t1 + SEVEN_DAYS_SECS]),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const results = await recall(
        client,
        {
          text: "",
          context: "session-start",
          limit: 5,
          noUpdate: true,
        },
        "sk-test",
        { now: new Date("2026-02-01T00:00:00.000Z") },
      );

      const spaced = results.find((item) => item.entry.id === "session-spaced");
      expect(spaced).toBeTruthy();
      expect(spaced!.scores.spacing).toBeGreaterThan(1.0);
    });

    it("uses recall_intervals in vector candidate scoring", async () => {
      const client = makeClient();
      await initDb(client);

      const vector = to1024([1, 0, 0]);
      await insertEntry(client, "vector-spaced", {
        recallCount: 0,
        recallIntervals: JSON.stringify([t1, t1 + SEVEN_DAYS_SECS]),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        embedding: vector,
      });

      const results = await recall(
        client,
        {
          text: "vector spaced",
          limit: 5,
          noUpdate: true,
        },
        "sk-test",
        {
          now: new Date("2026-02-01T00:00:00.000Z"),
          embedFn: async () => [vector],
        },
      );

      const spaced = results.find((item) => item.entry.id === "vector-spaced");
      expect(spaced).toBeTruthy();
      expect(spaced!.scores.spacing).toBeGreaterThan(1.0);
    });

    it("builds spacing after repeated recalls with advancing time", async () => {
      const client = makeClient();
      await initDb(client);

      const vector = to1024([1, 0, 0]);
      await insertEntry(client, "roundtrip", {
        embedding: vector,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const firstNow = new Date("2026-02-01T00:00:00.000Z");
      await recall(
        client,
        {
          text: "roundtrip query",
          limit: 1,
        },
        "sk-test",
        {
          now: firstNow,
          embedFn: async () => [vector],
        },
      );

      const afterFirst = await client.execute({
        sql: "SELECT recall_intervals FROM entries WHERE id = ?",
        args: ["roundtrip"],
      });
      expect(parseIntervals(afterFirst.rows[0]?.recall_intervals)).toHaveLength(1);

      const secondNow = new Date("2026-02-08T00:00:00.000Z");
      await recall(
        client,
        {
          text: "roundtrip query",
          limit: 1,
        },
        "sk-test",
        {
          now: secondNow,
          embedFn: async () => [vector],
        },
      );

      const afterSecond = await client.execute({
        sql: "SELECT recall_intervals FROM entries WHERE id = ?",
        args: ["roundtrip"],
      });
      expect(parseIntervals(afterSecond.rows[0]?.recall_intervals)).toHaveLength(2);

      const third = await recall(
        client,
        {
          text: "roundtrip query",
          limit: 1,
          noUpdate: true,
        },
        "sk-test",
        {
          now: new Date("2026-02-15T00:00:00.000Z"),
          embedFn: async () => [vector],
        },
      );

      expect(third[0]?.scores.spacing).toBeGreaterThan(1.0);
    });
  });

  it("runs recall_intervals migration idempotently", async () => {
    const client = makeClient();

    await initSchema(client);
    await initSchema(client);
    await initSchema(client);

    const info = await client.execute("PRAGMA table_info(entries)");
    const recallIntervalsColumns = info.rows.filter((row) => String(row.name) === "recall_intervals");
    expect(recallIntervalsColumns).toHaveLength(1);
  });
});
