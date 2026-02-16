import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initDb } from "../../src/db/client.js";
import { batchClassify, hashText, storeEntries, type ClassificationResult } from "../../src/db/store.js";
import type { KnowledgeEntry, LlmClient, StoredEntry } from "../../src/types.js";

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

function to512(head: number[]): number[] {
  return [...head, ...Array.from({ length: 509 }, () => 0)];
}

function vectorForText(text: string): number[] {
  if (text.includes("vec-base")) return to512([1, 0, 0]);
  if (text.includes("vec-95")) return to512([0.95, Math.sqrt(1 - 0.95 ** 2), 0]);
  if (text.includes("vec-85")) return to512([0.85, Math.sqrt(1 - 0.85 ** 2), 0]);
  if (text.includes("vec-75")) return to512([0.75, Math.sqrt(1 - 0.75 ** 2), 0]);
  if (text.includes("vec-45")) return to512([0.45, Math.sqrt(1 - 0.45 ** 2), 0]);
  return to512([0, 1, 0]);
}

async function mockEmbed(texts: string[]): Promise<number[][]> {
  return texts.map((text) => vectorForText(text));
}

function makeEntry(params: {
  content: string;
  subject?: string;
  type?: KnowledgeEntry["type"];
}): KnowledgeEntry {
  return {
    type: params.type ?? "fact",
    subject: params.subject ?? "Jim",
    content: params.content,
    importance: 8,
    expiry: "permanent",
    tags: [],
    source: {
      file: "classify-test.jsonl",
      context: "unit test",
    },
  };
}

function fakeLlmClient(): LlmClient {
  return {
    auth: "openai-api-key",
    resolvedModel: {
      provider: "openai",
      modelId: "gpt-4o",
      model: {} as any,
    },
    credentials: {
      apiKey: "test-key",
      source: "test",
    },
  };
}

async function countEntries(db: Client): Promise<number> {
  const result = await db.execute("SELECT COUNT(*) AS count FROM entries");
  return asNumber(result.rows[0]?.count);
}

async function getEntryByContent(db: Client, content: string): Promise<{ id: string; confirmations: number; contradictions: number; supersededBy?: string } | null> {
  const result = await db.execute({
    sql: "SELECT id, confirmations, contradictions, superseded_by FROM entries WHERE content = ? LIMIT 1",
    args: [content],
  });
  if (result.rows.length === 0) {
    return null;
  }
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: String(row.id),
    confirmations: asNumber(row.confirmations),
    contradictions: asNumber(row.contradictions),
    supersededBy: row.superseded_by ? String(row.superseded_by) : undefined,
  };
}

async function relationCount(db: Client, type: string, sourceId: string, targetId: string): Promise<number> {
  const result = await db.execute({
    sql: `
      SELECT COUNT(*) AS count
      FROM relations
      WHERE relation_type = ?
        AND source_id = ?
        AND target_id = ?
    `,
    args: [type, sourceId, targetId],
  });
  return asNumber(result.rows[0]?.count);
}

async function seedBaseEntry(db: Client): Promise<void> {
  await storeEntries(db, [makeEntry({ content: "seed vec-base" })], "sk-test", {
    sourceFile: "seed.jsonl",
    ingestContentHash: hashText("seed"),
    embedFn: mockEmbed,
  });
}

async function storeClassified(
  db: Client,
  classification: ClassificationResult,
): Promise<void> {
  await storeEntries(
    db,
    [makeEntry({ content: "incoming vec-85", subject: "Jim", type: "fact" })],
    "sk-test",
    {
      sourceFile: "incoming.jsonl",
      ingestContentHash: hashText(`incoming-${classification}`),
      embedFn: mockEmbed,
      classify: true,
      llmClient: fakeLlmClient(),
      classifyFn: vi.fn(async () => classification),
    },
  );
}

describe("db store classification", () => {
  const clients: Client[] = [];

  afterEach(() => {
    while (clients.length > 0) {
      clients.pop()?.close();
    }
    vi.restoreAllMocks();
  });

  function makeClient(): Client {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    return client;
  }

  it("handles REINFORCING by updating confirmations without inserting new entry", async () => {
    const client = makeClient();
    await initDb(client);
    await seedBaseEntry(client);

    await storeClassified(client, "REINFORCING");

    const seed = await getEntryByContent(client, "seed vec-base");
    expect(seed?.confirmations).toBe(1);
    expect(await getEntryByContent(client, "incoming vec-85")).toBeNull();
    expect(await countEntries(client)).toBe(1);
  });

  it("handles SUPERSEDING by superseding old entry and linking relation", async () => {
    const client = makeClient();
    await initDb(client);
    await seedBaseEntry(client);

    await storeClassified(client, "SUPERSEDING");

    const seed = await getEntryByContent(client, "seed vec-base");
    const incoming = await getEntryByContent(client, "incoming vec-85");
    expect(seed?.supersededBy).toBe(incoming?.id);
    expect(await relationCount(client, "supersedes", incoming?.id ?? "", seed?.id ?? "")).toBe(1);
  });

  it("handles CONTRADICTING by incrementing contradictions and linking relation", async () => {
    const client = makeClient();
    await initDb(client);
    await seedBaseEntry(client);

    await storeClassified(client, "CONTRADICTING");

    const seed = await getEntryByContent(client, "seed vec-base");
    const incoming = await getEntryByContent(client, "incoming vec-85");
    expect(seed?.contradictions).toBe(1);
    expect(await relationCount(client, "contradicts", incoming?.id ?? "", seed?.id ?? "")).toBe(1);
  });

  it("handles NUANCING by creating elaborates relation", async () => {
    const client = makeClient();
    await initDb(client);
    await seedBaseEntry(client);

    await storeClassified(client, "NUANCING");

    const seed = await getEntryByContent(client, "seed vec-base");
    const incoming = await getEntryByContent(client, "incoming vec-85");
    expect(await relationCount(client, "elaborates", incoming?.id ?? "", seed?.id ?? "")).toBe(1);
  });

  it("handles UNRELATED by inserting entry without relation", async () => {
    const client = makeClient();
    await initDb(client);
    await seedBaseEntry(client);

    await storeClassified(client, "UNRELATED");

    const relationResult = await client.execute("SELECT COUNT(*) AS count FROM relations");
    expect(asNumber(relationResult.rows[0]?.count)).toBe(0);
    expect(await getEntryByContent(client, "incoming vec-85")).not.toBeNull();
  });

  it("falls back to UNRELATED when classification function throws", async () => {
    const client = makeClient();
    await initDb(client);
    await seedBaseEntry(client);

    await storeEntries(client, [makeEntry({ content: "incoming vec-85", subject: "Jim" })], "sk-test", {
      sourceFile: "incoming.jsonl",
      ingestContentHash: hashText("incoming-throw"),
      embedFn: mockEmbed,
      classify: true,
      llmClient: fakeLlmClient(),
      classifyFn: vi.fn(async () => {
        throw new Error("LLM failure");
      }),
    });

    expect(await getEntryByContent(client, "incoming vec-85")).not.toBeNull();
    const relationResult = await client.execute("SELECT COUNT(*) AS count FROM relations");
    expect(asNumber(relationResult.rows[0]?.count)).toBe(0);
  });

  it("keeps default behavior when classify is not passed", async () => {
    const client = makeClient();
    await initDb(client);
    await seedBaseEntry(client);

    const classifyFn = vi.fn(async () => "REINFORCING" as const);
    await storeEntries(client, [makeEntry({ content: "incoming vec-85", subject: "Jim" })], "sk-test", {
      sourceFile: "incoming.jsonl",
      ingestContentHash: hashText("incoming-no-classify"),
      embedFn: mockEmbed,
      classifyFn,
    });

    expect(classifyFn).not.toHaveBeenCalled();
    expect(await getEntryByContent(client, "incoming vec-85")).not.toBeNull();
  });

  it("skips classification outside 0.80-0.92 range", async () => {
    const client = makeClient();
    await initDb(client);
    await seedBaseEntry(client);

    const classifyFn = vi.fn(async () => "REINFORCING" as const);

    await storeEntries(client, [makeEntry({ content: "low vec-75", subject: "Jim" })], "sk-test", {
      sourceFile: "incoming-low.jsonl",
      ingestContentHash: hashText("incoming-low"),
      embedFn: mockEmbed,
      classify: true,
      llmClient: fakeLlmClient(),
      classifyFn,
    });

    await storeEntries(client, [makeEntry({ content: "high vec-95", subject: "Jim", type: "fact" })], "sk-test", {
      sourceFile: "incoming-high.jsonl",
      ingestContentHash: hashText("incoming-high"),
      embedFn: mockEmbed,
      classify: true,
      llmClient: fakeLlmClient(),
      classifyFn,
    });

    expect(classifyFn).not.toHaveBeenCalled();
    expect(await getEntryByContent(client, "low vec-75")).not.toBeNull();
    const seed = await getEntryByContent(client, "seed vec-base");
    expect(seed?.confirmations).toBe(1);
  });

  it("applies batch classifications, including REINFORCING deletion semantics", async () => {
    const client = makeClient();
    await initDb(client);

    const existingEntries = [
      makeEntry({ content: "existing-0 vec-base", subject: "S0" }),
      makeEntry({ content: "existing-1 vec-base", subject: "S1" }),
      makeEntry({ content: "existing-2 vec-base", subject: "S2" }),
      makeEntry({ content: "existing-3 vec-base", subject: "S3" }),
      makeEntry({ content: "existing-4 vec-base", subject: "S4" }),
    ];
    const newEntries = [
      makeEntry({ content: "new-0 vec-85", subject: "S0" }),
      makeEntry({ content: "new-1 vec-85", subject: "S1" }),
      makeEntry({ content: "new-2 vec-85", subject: "S2" }),
      makeEntry({ content: "new-3 vec-85", subject: "S3" }),
      makeEntry({ content: "new-4 vec-85", subject: "S4" }),
    ];

    await storeEntries(client, existingEntries, "sk-test", {
      sourceFile: "existing.jsonl",
      ingestContentHash: hashText("existing"),
      embedFn: mockEmbed,
      force: true,
    });
    await storeEntries(client, newEntries, "sk-test", {
      sourceFile: "new.jsonl",
      ingestContentHash: hashText("new"),
      embedFn: mockEmbed,
      force: true,
    });

    const byContent = new Map<string, StoredEntry>();
    const rows = await client.execute(`
      SELECT
        id, type, subject, content, importance, expiry, source_file, source_context,
        created_at, updated_at, recall_count, confirmations, contradictions, superseded_by
      FROM entries
    `);
    for (const row of rows.rows) {
      const entry: StoredEntry = {
        id: String(row.id),
        type: String(row.type) as StoredEntry["type"],
        subject: String(row.subject),
        content: String(row.content),
        importance: asNumber(row.importance),
        expiry: String(row.expiry) as StoredEntry["expiry"],
        tags: [],
        source: {
          file: String(row.source_file ?? ""),
          context: String(row.source_context ?? ""),
        },
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
        recall_count: asNumber(row.recall_count),
        confirmations: asNumber(row.confirmations),
        contradictions: asNumber(row.contradictions),
        superseded_by: row.superseded_by ? String(row.superseded_by) : undefined,
      };
      byContent.set(entry.content, entry);
    }

    const candidates = [
      { newEntry: byContent.get("new-0 vec-85"), matchEntry: byContent.get("existing-0 vec-base"), similarity: 0.85 },
      { newEntry: byContent.get("new-1 vec-85"), matchEntry: byContent.get("existing-1 vec-base"), similarity: 0.85 },
      { newEntry: byContent.get("new-2 vec-85"), matchEntry: byContent.get("existing-2 vec-base"), similarity: 0.85 },
      { newEntry: byContent.get("new-3 vec-85"), matchEntry: byContent.get("existing-3 vec-base"), similarity: 0.85 },
      { newEntry: byContent.get("new-4 vec-85"), matchEntry: byContent.get("existing-4 vec-base"), similarity: 0.85 },
    ]
      .filter((item): item is { newEntry: StoredEntry; matchEntry: StoredEntry; similarity: number } => Boolean(item.newEntry && item.matchEntry));

    await batchClassify(client, fakeLlmClient(), candidates, {
      classifyBatchFn: vi.fn(async () =>
        new Map<number, ClassificationResult>([
          [0, "REINFORCING"],
          [1, "SUPERSEDING"],
          [2, "CONTRADICTING"],
          [3, "NUANCING"],
          [4, "UNRELATED"],
        ]),
      ),
    });

    const existing0 = await getEntryByContent(client, "existing-0 vec-base");
    expect(existing0?.confirmations).toBe(1);
    expect(await getEntryByContent(client, "new-0 vec-85")).toBeNull();

    const existing1 = await getEntryByContent(client, "existing-1 vec-base");
    const new1 = await getEntryByContent(client, "new-1 vec-85");
    expect(existing1?.supersededBy).toBe(new1?.id);
    expect(await relationCount(client, "supersedes", new1?.id ?? "", existing1?.id ?? "")).toBe(1);

    const existing2 = await getEntryByContent(client, "existing-2 vec-base");
    const new2 = await getEntryByContent(client, "new-2 vec-85");
    expect(existing2?.contradictions).toBe(1);
    expect(await relationCount(client, "contradicts", new2?.id ?? "", existing2?.id ?? "")).toBe(1);

    const existing3 = await getEntryByContent(client, "existing-3 vec-base");
    const new3 = await getEntryByContent(client, "new-3 vec-85");
    expect(await relationCount(client, "elaborates", new3?.id ?? "", existing3?.id ?? "")).toBe(1);

    const relationForUnrelated = await client.execute({
      sql: "SELECT COUNT(*) AS count FROM relations WHERE source_id = ?",
      args: [(await getEntryByContent(client, "new-4 vec-85"))?.id ?? ""],
    });
    expect(asNumber(relationForUnrelated.rows[0]?.count)).toBe(0);
  });
});
