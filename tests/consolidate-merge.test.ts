import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractMergeResultFromToolCall, mergeCluster } from "../src/consolidate/merge.js";
import { initDb } from "../src/db/client.js";
import { hashText, insertEntry } from "../src/db/store.js";
import type { Cluster } from "../src/consolidate/cluster.js";
import type { KnowledgeEntry, LlmClient } from "../src/types.js";

const runSimpleStreamMock = vi.hoisted(() => vi.fn());
const embedMock = vi.hoisted(() => vi.fn());

vi.mock("../src/llm/stream.js", () => ({
  runSimpleStream: runSimpleStreamMock,
}));

vi.mock("../src/embeddings/client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/embeddings/client.js")>("../src/embeddings/client.js");
  return {
    ...actual,
    embed: embedMock,
  };
});

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

function vector(seed: number): number[] {
  const head = [1, seed, 0];
  const norm = Math.sqrt(head.reduce((sum, item) => sum + item * item, 0));
  const normalized = head.map((item) => item / norm);
  return [...normalized, ...Array.from({ length: 509 }, () => 0)];
}

function makeEntry(content: string): KnowledgeEntry {
  return {
    type: "fact",
    subject: "Merge Subject",
    content,
    importance: 6,
    expiry: "permanent",
    tags: ["merge"],
    source: {
      file: "merge.test.jsonl",
      context: "merge test",
    },
  };
}

function makeLlmClient(): LlmClient {
  return {
    auth: "openai-api-key",
    resolvedModel: {
      provider: "openai",
      modelId: "gpt-4o",
      model: {} as any,
    },
    credentials: {
      apiKey: "llm-key",
      source: "test",
    },
  };
}

function makeToolCallMessage(args: Record<string, unknown>) {
  return {
    content: [
      {
        type: "toolCall",
        name: "merge_entries",
        arguments: {
          content: "Merged canonical content",
          subject: "Merge Subject",
          type: "fact",
          importance: 8,
          expiry: "permanent",
          tags: ["merged", "canonical"],
          notes: "merged",
          ...args,
        },
      },
    ],
  };
}

describe("consolidate merge", () => {
  const clients: Client[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    runSimpleStreamMock.mockResolvedValue({
      stopReason: "stop",
      content: [
        {
          type: "toolCall",
          name: "merge_entries",
          arguments: {
            content: "Merged canonical content",
            subject: "Merge Subject",
            type: "fact",
            importance: 8,
            expiry: "permanent",
            tags: ["merged", "canonical"],
            notes: "merged",
          },
        },
      ],
    });
    embedMock.mockResolvedValue([vector(0)]);
  });

  afterEach(() => {
    while (clients.length > 0) {
      clients.pop()?.close();
    }
  });

  async function makeDb(): Promise<Client> {
    const db = createClient({ url: ":memory:" });
    clients.push(db);
    await initDb(db);
    return db;
  }

  async function seedSources(db: Client): Promise<Cluster> {
    const embeddingA = vector(0.01);
    const embeddingB = vector(0.02);

    const idA = await insertEntry(db, makeEntry("source a"), embeddingA, hashText("source-a"));
    const idB = await insertEntry(db, makeEntry("source b"), embeddingB, hashText("source-b"));

    await db.execute({
      sql: "UPDATE entries SET confirmations = 2, recall_count = 5 WHERE id = ?",
      args: [idA],
    });
    await db.execute({
      sql: "UPDATE entries SET confirmations = 3, recall_count = 7 WHERE id = ?",
      args: [idB],
    });

    return {
      entries: [
        {
          id: idA,
          type: "fact",
          subject: "Merge Subject",
          content: "source a",
          importance: 6,
          embedding: embeddingA,
          confirmations: 2,
          recallCount: 5,
          createdAt: new Date().toISOString(),
        },
        {
          id: idB,
          type: "fact",
          subject: "Merge Subject",
          content: "source b",
          importance: 8,
          embedding: embeddingB,
          confirmations: 3,
          recallCount: 7,
          createdAt: new Date().toISOString(),
        },
      ],
    };
  }

  it("creates merged entry, sources, supersedes relations, and aggregated scores", async () => {
    const db = await makeDb();
    const cluster = await seedSources(db);

    const outcome = await mergeCluster(db, cluster, makeLlmClient(), "embed-key");

    expect(outcome.flagged).toBe(false);
    expect(outcome.mergedEntryId.length).toBeGreaterThan(0);

    const merged = await db.execute({
      sql: "SELECT merged_from, consolidated_at, confirmations, recall_count FROM entries WHERE id = ?",
      args: [outcome.mergedEntryId],
    });

    expect(asNumber(merged.rows[0]?.merged_from)).toBe(2);
    expect(String(merged.rows[0]?.consolidated_at ?? "").length).toBeGreaterThan(0);
    expect(asNumber(merged.rows[0]?.confirmations)).toBe(5);
    expect(asNumber(merged.rows[0]?.recall_count)).toBe(12);

    const entrySources = await db.execute({
      sql: "SELECT source_entry_id, original_confirmations, original_recall_count FROM entry_sources WHERE merged_entry_id = ? ORDER BY source_entry_id ASC",
      args: [outcome.mergedEntryId],
    });

    expect(entrySources.rows).toHaveLength(2);
    expect(entrySources.rows.map((row) => asNumber(row.original_confirmations)).sort()).toEqual([2, 3]);
    expect(entrySources.rows.map((row) => asNumber(row.original_recall_count)).sort()).toEqual([5, 7]);

    const superseded = await db.execute({
      sql: "SELECT id, superseded_by FROM entries WHERE id IN (?, ?) ORDER BY id ASC",
      args: outcome.sourceIds,
    });
    expect(superseded.rows.every((row) => String(row.superseded_by) === outcome.mergedEntryId)).toBe(true);

    const relations = await db.execute({
      sql: "SELECT source_id, target_id, relation_type FROM relations WHERE relation_type = 'supersedes' ORDER BY target_id ASC",
      args: [],
    });
    expect(relations.rows).toHaveLength(2);
    expect(relations.rows.every((row) => String(row.source_id) === outcome.mergedEntryId)).toBe(true);
  });

  it("truncates long entry content to stay under merge prompt token budget", async () => {
    const db = await makeDb();
    const long = "x".repeat(5000);
    const cluster: Cluster = {
      entries: Array.from({ length: 12 }, (_, index) => ({
        id: `id-${index}`,
        type: "fact",
        subject: "Long Subject",
        content: long,
        importance: 6,
        embedding: vector(0),
        confirmations: 1,
        recallCount: 1,
        createdAt: new Date().toISOString(),
      })),
    };

    await mergeCluster(db, cluster, makeLlmClient(), "embed-key", { dryRun: true });

    const call = runSimpleStreamMock.mock.calls[0]?.[0];
    const payload = String(call?.context?.messages?.[0]?.content ?? "");
    expect(payload.includes("x".repeat(801))).toBe(false);
    expect(payload.includes("x".repeat(800))).toBe(true);
  });

  it("dry-run performs no database writes", async () => {
    const db = await makeDb();
    const cluster = await seedSources(db);

    const beforeEntries = await db.execute("SELECT COUNT(*) AS count FROM entries");
    const beforeSources = await db.execute("SELECT COUNT(*) AS count FROM entry_sources");

    const outcome = await mergeCluster(db, cluster, makeLlmClient(), "embed-key", { dryRun: true });

    expect(outcome.flagged).toBe(false);
    expect(outcome.mergedEntryId).toBe("DRY_RUN");

    const afterEntries = await db.execute("SELECT COUNT(*) AS count FROM entries");
    const afterSources = await db.execute("SELECT COUNT(*) AS count FROM entry_sources");

    expect(asNumber(afterEntries.rows[0]?.count)).toBe(asNumber(beforeEntries.rows[0]?.count));
    expect(asNumber(afterSources.rows[0]?.count)).toBe(asNumber(beforeSources.rows[0]?.count));

    const superseded = await db.execute({
      sql: "SELECT COUNT(*) AS count FROM entries WHERE superseded_by IS NOT NULL",
      args: [],
    });
    expect(asNumber(superseded.rows[0]?.count)).toBe(0);
  });
});

describe("extractMergeResultFromToolCall", () => {
  it("falls back to permanent when expiry is never", () => {
    const result = extractMergeResultFromToolCall(makeToolCallMessage({ expiry: "never" }));
    expect(result).not.toBeNull();
    expect(result?.expiry).toBe("permanent");
  });

  it("falls back to permanent when expiry is unknown", () => {
    const result = extractMergeResultFromToolCall(makeToolCallMessage({ expiry: "unknown" }));
    expect(result).not.toBeNull();
    expect(result?.expiry).toBe("permanent");
  });

  it("falls back to 5 when importance is non-numeric", () => {
    const result = extractMergeResultFromToolCall(makeToolCallMessage({ importance: "certain" }));
    expect(result).not.toBeNull();
    expect(result?.importance).toBe(5);
  });

  it("falls back to fact when type is belief", () => {
    const result = extractMergeResultFromToolCall(makeToolCallMessage({ type: "belief" }));
    expect(result).not.toBeNull();
    expect(result?.type).toBe("fact");
  });

  it("logs fallback warnings in verbose mode", () => {
    const onLog = vi.fn();
    const result = extractMergeResultFromToolCall(makeToolCallMessage({ expiry: "never" }), {
      verbose: true,
      onLog,
    });

    expect(result).not.toBeNull();
    expect(onLog).toHaveBeenCalledWith('[merge] LLM returned invalid expiry "never", falling back to "permanent"');
  });

  it("returns null when content is empty", () => {
    const result = extractMergeResultFromToolCall(makeToolCallMessage({ content: "   " }));
    expect(result).toBeNull();
  });

  it("returns null when subject is empty", () => {
    const result = extractMergeResultFromToolCall(makeToolCallMessage({ subject: "   " }));
    expect(result).toBeNull();
  });

  it("keeps valid enum values unchanged", () => {
    const result = extractMergeResultFromToolCall(
      makeToolCallMessage({
        type: "event",
        importance: 6,
        expiry: "temporary",
      }),
    );

    expect(result).not.toBeNull();
    expect(result?.type).toBe("event");
    expect(result?.importance).toBe(6);
    expect(result?.expiry).toBe("temporary");
  });
});
