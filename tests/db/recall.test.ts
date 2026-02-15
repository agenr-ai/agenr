import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../../src/db/client.js";
import { confidenceScore, recall, recallStrength, recency, scoreEntry } from "../../src/db/recall.js";
import { storeEntries } from "../../src/db/store.js";
import type { KnowledgeEntry, StoredEntry } from "../../src/types.js";

function to512(head: number[]): number[] {
  return [...head, ...Array.from({ length: 509 }, () => 0)];
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
  confidence?: KnowledgeEntry["confidence"];
  expiry?: KnowledgeEntry["expiry"];
}): KnowledgeEntry {
  return {
    type: params.type ?? "fact",
    subject: "Jim",
    content: params.content,
    confidence: params.confidence ?? "high",
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
    confidence: "high",
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

  it("recency keeps core at 1.0 and decays session-only faster than temporary", () => {
    expect(recency(0, "core")).toBe(1);
    expect(recency(5000, "core")).toBe(1);

    const temporary = recency(10, "temporary");
    const sessionOnly = recency(10, "session-only");
    expect(temporary).toBeLessThan(1);
    expect(sessionOnly).toBeLessThan(temporary);
  });

  it("confidenceScore behaves as Bayesian confidence with decay", () => {
    expect(confidenceScore("high", 0, 0, 0)).toBeCloseTo(0.75, 5);

    const reinforced = confidenceScore("medium", 3, 0, 0);
    const contradicted = confidenceScore("medium", 0, 3, 0);
    expect(reinforced).toBeGreaterThan(confidenceScore("medium", 0, 0, 0));
    expect(contradicted).toBeLessThan(confidenceScore("medium", 0, 0, 0));

    const decayed = confidenceScore("low", 8, 0, 1200);
    expect(decayed).toBeCloseTo(0.5, 2);
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

  it("scoreEntry uses multiplicative scaling for memory strength", () => {
    const now = new Date("2026-02-15T00:00:00.000Z");
    const highConfidence = makeStoredEntry({
      confidence: "high",
      confirmations: 3,
      contradictions: 0,
      recall_count: 2,
    });
    const lowConfidence = makeStoredEntry({
      confidence: "low",
      confirmations: 0,
      contradictions: 4,
      recall_count: 0,
    });

    const highScore = scoreEntry(highConfidence, 0.95, false, now);
    const lowScore = scoreEntry(lowConfidence, 0.95, false, now);
    expect(highScore).toBeGreaterThan(lowScore);
  });

  it("applies contradiction penalty only when contradictions >= 2", () => {
    const now = new Date("2026-02-15T00:00:00.000Z");
    const base = makeStoredEntry({
      expiry: "core",
      confidence: "low",
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
        text: "work",
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
        text: "work",
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
        text: "work",
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
  });
});
