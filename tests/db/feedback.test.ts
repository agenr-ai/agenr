import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../../src/db/client.js";
import { updateQualityScores } from "../../src/db/feedback.js";

describe("db feedback", () => {
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

  async function insertEntry(
    client: Client,
    params: { id: string; type: string; qualityScore: number | null },
  ): Promise<void> {
    await client.execute({
      sql: `
        INSERT INTO entries (
          id, type, subject, content, importance, expiry, scope, source_file, source_context,
          created_at, updated_at, quality_score
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        params.id,
        params.type,
        `subject-${params.id}`,
        `content-${params.id}`,
        5,
        "temporary",
        "private",
        "feedback.test.jsonl",
        "test",
        "2026-02-20T00:00:00.000Z",
        "2026-02-20T00:00:00.000Z",
        params.qualityScore,
      ],
    });
  }

  async function readQuality(client: Client, id: string): Promise<number> {
    const result = await client.execute({
      sql: "SELECT quality_score FROM entries WHERE id = ?",
      args: [id],
    });
    return Number((result.rows[0] as { quality_score?: unknown } | undefined)?.quality_score ?? Number.NaN);
  }

  it("applies EMA update correctly", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, { id: "ema", type: "lesson", qualityScore: 0.5 });

    await updateQualityScores(client, [{ id: "ema", signal: 1 }]);
    expect(await readQuality(client, "ema")).toBeCloseTo(0.6, 8);
  });

  it("defaults null quality_score to 0.5 before EMA update", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, { id: "null-quality", type: "lesson", qualityScore: null });

    await updateQualityScores(client, [{ id: "null-quality", signal: 1 }]);
    expect(await readQuality(client, "null-quality")).toBeCloseTo(0.6, 8);
  });

  it("is a no-op when updates array is empty", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, { id: "noop", type: "lesson", qualityScore: 0.7 });

    await updateQualityScores(client, []);
    expect(await readQuality(client, "noop")).toBeCloseTo(0.7, 8);
  });

  it("accumulates EMA updates across multiple calls", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, { id: "chain", type: "lesson", qualityScore: 0.5 });

    await updateQualityScores(client, [{ id: "chain", signal: 1 }]);
    await updateQualityScores(client, [{ id: "chain", signal: 0.4 }]);
    expect(await readQuality(client, "chain")).toBeCloseTo(0.56, 8);
  });

  it("keeps quality_score bounded in [0, 1]", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, { id: "upper", type: "lesson", qualityScore: 1 });
    await insertEntry(client, { id: "lower", type: "lesson", qualityScore: 0 });

    await updateQualityScores(client, [{ id: "upper", signal: 1 }]);
    await updateQualityScores(client, [{ id: "lower", signal: 0 }]);
    expect(await readQuality(client, "upper")).toBeCloseTo(1, 8);
    expect(await readQuality(client, "lower")).toBeCloseTo(0.1, 8);
  });

  it("applies fact floor of 0.35 for signal 0", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, { id: "fact-floor", type: "fact", qualityScore: 0 });

    await updateQualityScores(client, [{ id: "fact-floor", signal: 0 }]);
    expect(await readQuality(client, "fact-floor")).toBeCloseTo(0.35, 8);
  });

  it("applies lesson floor of 0.1 for signal 0", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, { id: "lesson-floor", type: "lesson", qualityScore: 0 });

    await updateQualityScores(client, [{ id: "lesson-floor", signal: 0 }]);
    expect(await readQuality(client, "lesson-floor")).toBeCloseTo(0.1, 8);
  });

  it("applies preference floor of 0.35 for signal 0", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, { id: "pref-floor", type: "preference", qualityScore: 0 });

    await updateQualityScores(client, [{ id: "pref-floor", signal: 0 }]);
    expect(await readQuality(client, "pref-floor")).toBeCloseTo(0.35, 8);
  });
});
