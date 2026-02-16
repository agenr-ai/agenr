import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initDb } from "../../src/db/client.js";
import { hashText, storeEntries } from "../../src/db/store.js";
import { composeEmbeddingText } from "../../src/embeddings/client.js";
import type { KnowledgeEntry, LlmClient } from "../../src/types.js";

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
  return [...head, ...Array.from({ length: 1021 }, () => 0)];
}

function vectorForText(text: string): number[] {
  if (text.includes("vec-base")) return to512([1, 0, 0]);
  if (text.includes("vec-86")) return to512([0.86, Math.sqrt(1 - 0.86 ** 2), 0]);
  if (text.includes("vec-85")) return to512([0.85, Math.sqrt(1 - 0.85 ** 2), 0]);
  if (text.includes("vec-84")) return to512([0.84, Math.sqrt(1 - 0.84 ** 2), 0]);
  if (text.includes("vec-95")) return to512([0.95, Math.sqrt(1 - 0.95 ** 2), 0]);
  if (text.includes("vec-exact")) return to512([0.999, 0.01, 0]);
  return to512([0, 1, 0]);
}

async function mockEmbed(texts: string[]): Promise<number[][]> {
  return texts.map((text) => vectorForText(text));
}

function makeEntry(params: {
  content: string;
  subject?: string;
  type?: KnowledgeEntry["type"];
  sourceFile?: string;
}): KnowledgeEntry {
  return {
    type: params.type ?? "fact",
    subject: params.subject ?? "Jim",
    content: params.content,
    importance: 8,
    expiry: "permanent",
    tags: [],
    source: {
      file: params.sourceFile ?? "online-dedup-test.jsonl",
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

async function seedBaseEntry(db: Client): Promise<void> {
  await storeEntries(db, [makeEntry({ content: "seed vec-base" })], "sk-test", {
    sourceFile: "seed.jsonl",
    ingestContentHash: hashText("seed"),
    embedFn: mockEmbed,
  });
}

describe("db online dedup", () => {
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

  it("adds new entry when no similar candidates pass threshold", async () => {
    const client = makeClient();
    await initDb(client);

    const result = await storeEntries(client, [makeEntry({ content: "new fact vec-base" })], "sk-test", {
      sourceFile: "incoming.jsonl",
      ingestContentHash: hashText("incoming"),
      embedFn: mockEmbed,
      onlineDedup: true,
      llmClient: fakeLlmClient(),
      onlineDedupFn: vi.fn(async () => ({
        action: "SKIP",
        target_id: "ignored",
        merged_content: null,
        reasoning: "should not be called",
      })),
    });

    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.superseded).toBe(0);
    expect(result.llm_dedup_calls).toBe(0);
  });

  it("skips semantic duplicate via online dedup SKIP and bumps confirmations", async () => {
    const client = makeClient();
    await initDb(client);
    await seedBaseEntry(client);

    const result = await storeEntries(client, [makeEntry({ content: "same meaning vec-85" })], "sk-test", {
      sourceFile: "incoming.jsonl",
      ingestContentHash: hashText("incoming-skip"),
      embedFn: mockEmbed,
      onlineDedup: true,
      llmClient: fakeLlmClient(),
      onlineDedupFn: vi.fn(async (_client, _entry, candidates) => ({
        action: "SKIP",
        target_id: candidates[0]?.entry.id ?? null,
        merged_content: null,
        reasoning: "already captured",
      })),
    });

    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.superseded).toBe(0);

    const confirmations = await client.execute({
      sql: "SELECT confirmations FROM entries WHERE content = ?",
      args: ["seed vec-base"],
    });
    expect(asNumber(confirmations.rows[0]?.confirmations)).toBe(1);
  });

  it("updates existing entry content, re-embeds merged text, and bumps confirmations", async () => {
    const client = makeClient();
    await initDb(client);
    await seedBaseEntry(client);

    const embeddedTexts: string[] = [];
    const embedSpy = vi.fn(async (texts: string[]) => {
      embeddedTexts.push(...texts);
      return mockEmbed(texts);
    });

    const result = await storeEntries(client, [makeEntry({ content: "incoming update vec-85" })], "sk-test", {
      sourceFile: "incoming.jsonl",
      ingestContentHash: hashText("incoming-update"),
      embedFn: embedSpy,
      onlineDedup: true,
      llmClient: fakeLlmClient(),
      onlineDedupFn: vi.fn(async (_client, _entry, candidates) => ({
        action: "UPDATE",
        target_id: candidates[0]?.entry.id ?? null,
        merged_content: "merged detail vec-95",
        reasoning: "new detail",
      })),
    });

    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.superseded).toBe(0);

    const updatedRow = await client.execute({
      sql: "SELECT content, confirmations FROM entries WHERE content = ? LIMIT 1",
      args: ["merged detail vec-95"],
    });
    expect(updatedRow.rows.length).toBe(1);
    expect(asNumber(updatedRow.rows[0]?.confirmations)).toBe(1);

    const expectedMergedText = composeEmbeddingText({
      ...makeEntry({ content: "merged detail vec-95" }),
      subject: "Jim",
      type: "fact",
    });
    expect(embeddedTexts).toContain(expectedMergedText);
  });

  it("supersedes existing entry and creates supersedes relation", async () => {
    const client = makeClient();
    await initDb(client);
    await seedBaseEntry(client);

    const result = await storeEntries(client, [makeEntry({ content: "replacement fact vec-85" })], "sk-test", {
      sourceFile: "incoming.jsonl",
      ingestContentHash: hashText("incoming-supersede"),
      embedFn: mockEmbed,
      onlineDedup: true,
      llmClient: fakeLlmClient(),
      onlineDedupFn: vi.fn(async (_client, _entry, candidates) => ({
        action: "SUPERSEDE",
        target_id: candidates[0]?.entry.id ?? null,
        merged_content: null,
        reasoning: "new fact supersedes old",
      })),
    });

    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.superseded).toBe(1);
    expect(result.relations_created).toBe(1);

    const rows = await client.execute(
      "SELECT id, content, superseded_by FROM entries ORDER BY created_at ASC",
    );
    const oldEntry = rows.rows.find((row) => String(row.content) === "seed vec-base");
    const newEntry = rows.rows.find((row) => String(row.content) === "replacement fact vec-85");

    expect(oldEntry).toBeTruthy();
    expect(newEntry).toBeTruthy();
    expect(String(oldEntry?.superseded_by)).toBe(String(newEntry?.id));

    const relationCount = await client.execute({
      sql: "SELECT COUNT(*) AS count FROM relations WHERE relation_type = 'supersedes' AND source_id = ? AND target_id = ?",
      args: [String(newEntry?.id), String(oldEntry?.id)],
    });
    expect(asNumber(relationCount.rows[0]?.count)).toBe(1);
  });

  it("preserves content-hash fast path before embedding/LLM", async () => {
    const client = makeClient();
    await initDb(client);

    const entry = makeEntry({ content: "hash-stable vec-base" });
    await storeEntries(client, [entry], "sk-test", {
      sourceFile: "incoming.jsonl",
      ingestContentHash: hashText("hash-seed"),
      embedFn: mockEmbed,
      onlineDedup: true,
      llmClient: fakeLlmClient(),
      onlineDedupFn: vi.fn(async () => ({
        action: "ADD",
        target_id: null,
        merged_content: null,
        reasoning: "add",
      })),
    });

    const embedSpy = vi.fn(async (texts: string[]) => mockEmbed(texts));
    const dedupSpy = vi.fn(async () => ({
      action: "ADD" as const,
      target_id: null,
      merged_content: null,
      reasoning: "add",
    }));

    const second = await storeEntries(client, [entry], "sk-test", {
      sourceFile: "incoming.jsonl",
      ingestContentHash: hashText("hash-second"),
      embedFn: embedSpy,
      onlineDedup: true,
      llmClient: fakeLlmClient(),
      onlineDedupFn: dedupSpy,
    });

    expect(second.skipped).toBe(1);
    expect(embedSpy).not.toHaveBeenCalled();
    expect(dedupSpy).not.toHaveBeenCalled();
  });

  it("respects dedupThreshold boundaries for LLM invocation", async () => {
    const clientLow = makeClient();
    await initDb(clientLow);
    await seedBaseEntry(clientLow);

    const lowSpy = vi.fn(async (_client, _entry, candidates) => ({
      action: "SKIP" as const,
      target_id: candidates[0]?.entry.id ?? null,
      merged_content: null,
      reasoning: "skip",
    }));

    const lowResult = await storeEntries(clientLow, [makeEntry({ content: "below threshold vec-84" })], "sk-test", {
      sourceFile: "incoming-low.jsonl",
      ingestContentHash: hashText("incoming-low"),
      embedFn: mockEmbed,
      onlineDedup: true,
      dedupThreshold: 0.85,
      llmClient: fakeLlmClient(),
      onlineDedupFn: lowSpy,
    });

    expect(lowResult.added).toBe(1);
    expect(lowSpy).not.toHaveBeenCalled();

    const clientHigh = makeClient();
    await initDb(clientHigh);
    await seedBaseEntry(clientHigh);

    const highSpy = vi.fn(async (_client, _entry, candidates) => ({
      action: "SKIP" as const,
      target_id: candidates[0]?.entry.id ?? null,
      merged_content: null,
      reasoning: "skip",
    }));

    const highResult = await storeEntries(clientHigh, [makeEntry({ content: "above threshold vec-86" })], "sk-test", {
      sourceFile: "incoming-high.jsonl",
      ingestContentHash: hashText("incoming-high"),
      embedFn: mockEmbed,
      onlineDedup: true,
      dedupThreshold: 0.85,
      llmClient: fakeLlmClient(),
      onlineDedupFn: highSpy,
    });

    expect(highResult.skipped).toBe(1);
    expect(highSpy).toHaveBeenCalledTimes(1);
  });

  it("bypasses all dedup when force=true", async () => {
    const client = makeClient();
    await initDb(client);

    const entry = makeEntry({ content: "force vec-base" });
    await storeEntries(client, [entry], "sk-test", {
      sourceFile: "seed.jsonl",
      ingestContentHash: hashText("force-seed"),
      embedFn: mockEmbed,
    });

    const dedupSpy = vi.fn(async () => ({
      action: "SKIP" as const,
      target_id: null,
      merged_content: null,
      reasoning: "should not run",
    }));

    const result = await storeEntries(client, [entry], "sk-test", {
      sourceFile: "force.jsonl",
      ingestContentHash: hashText("force-ingest"),
      embedFn: mockEmbed,
      force: true,
      onlineDedup: true,
      llmClient: fakeLlmClient(),
      onlineDedupFn: dedupSpy,
    });

    expect(result.added).toBe(1);
    expect(dedupSpy).not.toHaveBeenCalled();
    expect(await countEntries(client)).toBe(2);
  });

  it("commits per entry when online dedup is enabled (partial progress survives failure)", async () => {
    const client = makeClient();
    await initDb(client);

    const embedWithFailure = vi.fn(async (texts: string[]) => {
      if (texts[0]?.includes("boom")) {
        throw new Error("embed failure");
      }
      return mockEmbed(texts);
    });

    await expect(
      storeEntries(
        client,
        [
          makeEntry({ content: "first ok vec-base" }),
          makeEntry({ content: "second boom vec-85" }),
        ],
        "sk-test",
        {
          sourceFile: "per-entry.jsonl",
          ingestContentHash: hashText("per-entry"),
          embedFn: embedWithFailure,
          onlineDedup: true,
          llmClient: fakeLlmClient(),
          onlineDedupFn: vi.fn(async () => ({
            action: "ADD",
            target_id: null,
            merged_content: null,
            reasoning: "add",
          })),
        },
      ),
    ).rejects.toThrow("embed failure");

    expect(await countEntries(client)).toBe(1);
  });

  it("retains batch rollback behavior when online dedup is disabled", async () => {
    const client = makeClient();
    await initDb(client);

    const embedWithFailure = vi.fn(async (texts: string[]) => {
      if (texts[0]?.includes("boom")) {
        throw new Error("embed failure");
      }
      return mockEmbed(texts);
    });

    await expect(
      storeEntries(
        client,
        [
          makeEntry({ content: "first ok vec-base" }),
          makeEntry({ content: "second boom vec-85" }),
        ],
        "sk-test",
        {
          sourceFile: "batch.jsonl",
          ingestContentHash: hashText("batch"),
          embedFn: embedWithFailure,
          onlineDedup: false,
        },
      ),
    ).rejects.toThrow("embed failure");

    expect(await countEntries(client)).toBe(0);
  });
});
