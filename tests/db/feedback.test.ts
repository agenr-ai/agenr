import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../../src/db/client.js";
import { __testing, updateQualityScores } from "../../src/db/feedback.js";

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
    params: { id: string; type: string; qualityScore?: number },
  ): Promise<void> {
    const baseArgs = [
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
    ];

    if (params.qualityScore === undefined) {
      await client.execute({
        sql: `
          INSERT INTO entries (
            id, type, subject, content, importance, expiry, scope, source_file, source_context,
            created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: baseArgs,
      });
      return;
    }

    await client.execute({
      sql: `
        INSERT INTO entries (
          id, type, subject, content, importance, expiry, scope, source_file, source_context,
          created_at, updated_at, quality_score
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        ...baseArgs,
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

  it("uses default quality_score 0.5 before EMA update when omitted on insert", async () => {
    const client = makeClient();
    await initDb(client);
    await insertEntry(client, { id: "default-quality", type: "lesson" });

    await updateQualityScores(client, [{ id: "default-quality", signal: 1 }]);
    expect(await readQuality(client, "default-quality")).toBeCloseTo(0.6, 8);
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

describe("collectAgenrStoreContents", () => {
  it("extracts Anthropic tool_use agenr_store content blocks", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "agenr_store",
            input: { content: "anthropic content" },
          },
        ],
      },
    ];

    expect(__testing.collectAgenrStoreContents(messages)).toEqual(["anthropic content"]);
  });

  it("extracts OpenAI named tool_calls arguments payload", () => {
    const messages = [
      {
        role: "assistant",
        tool_calls: [
          {
            name: "agenr_store",
            arguments: "{\"content\":\"openai named content\"}",
          },
        ],
      },
    ];

    expect(__testing.collectAgenrStoreContents(messages)).toEqual(["openai named content"]);
  });

  it("extracts OpenAI tool_calls function.name arguments payload", () => {
    const messages = [
      {
        role: "assistant",
        tool_calls: [
          {
            function: {
              name: "agenr_store",
              arguments: "{\"content\":\"openai function content\"}",
            },
          },
        ],
      },
    ];

    expect(__testing.collectAgenrStoreContents(messages)).toEqual(["openai function content"]);
  });

  it("extracts only agenr_store content across mixed messages", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "agenr_store",
            input: { content: "first" },
          },
          {
            type: "tool_use",
            name: "other_tool",
            input: { content: "ignored" },
          },
        ],
      },
      {
        role: "assistant",
        tool_calls: [
          {
            function: {
              name: "agenr_store",
              arguments: "{\"content\":\"second\"}",
            },
          },
          {
            function: {
              name: "different_tool",
              arguments: "{\"content\":\"ignored\"}",
            },
          },
        ],
      },
      {
        role: "user",
        content: "not assistant",
      },
    ];

    expect(__testing.collectAgenrStoreContents(messages)).toEqual(["first", "second"]);
  });

  it("returns empty array when no agenr_store calls are present", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        tool_calls: [{ name: "other_tool", arguments: "{\"content\":\"ignored\"}" }],
      },
    ];

    expect(__testing.collectAgenrStoreContents(messages)).toEqual([]);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(__testing.cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 8);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(__testing.cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 8);
  });

  it("returns a negative value for opposite vectors", () => {
    expect(__testing.cosineSimilarity([1, -2], [-1, 2])).toBeLessThan(0);
  });

  it("returns 0 when one vector is empty", () => {
    expect(__testing.cosineSimilarity([], [1, 2, 3])).toBe(0);
  });

  it("handles different-length vectors safely", () => {
    expect(__testing.cosineSimilarity([1, 1], [1])).toBeCloseTo(1, 8);
  });
});
