import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildClusters } from "../src/consolidate/cluster.js";
import { mergeCluster } from "../src/consolidate/merge.js";
import { consolidateRules } from "../src/consolidate/rules.js";
import { initDb } from "../src/db/client.js";
import { hashText, insertEntry } from "../src/db/store.js";
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

function vectorFromAngle(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180;
  const head = [Math.cos(radians), Math.sin(radians), 0];
  return [...head, ...Array.from({ length: 509 }, () => 0)];
}

function vectorFromHead(head: [number, number, number]): number[] {
  return [...head, ...Array.from({ length: 509 }, () => 0)];
}

function makeEntry(subject: string, content: string, type: KnowledgeEntry["type"] = "fact"): KnowledgeEntry {
  return {
    type,
    subject,
    content,
    confidence: "medium",
    expiry: "permanent",
    tags: ["e2e"],
    source: {
      file: "consolidate-e2e.jsonl",
      context: "e2e",
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

describe("consolidate e2e", () => {
  const clients: Client[] = [];
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    runSimpleStreamMock.mockResolvedValue({
      stopReason: "stop",
      content: [
        {
          type: "toolCall",
          name: "merge_entries",
          arguments: {
            content: "Merged cluster content",
            subject: "Tier2",
            type: "fact",
            confidence: "high",
            expiry: "permanent",
            tags: ["merged"],
            notes: "merged",
          },
        },
      ],
    });
    embedMock.mockResolvedValue([vectorFromAngle(0)]);
  });

  afterEach(async () => {
    while (clients.length > 0) {
      clients.pop()?.close();
    }
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  async function makeDb(): Promise<Client> {
    const db = createClient({ url: ":memory:" });
    clients.push(db);
    await initDb(db);
    return db;
  }

  async function makeBackupSource(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-consolidate-e2e-"));
    tempDirs.push(dir);
    const backupSourcePath = path.join(dir, "knowledge.db");
    await fs.writeFile(backupSourcePath, "seed", "utf8");
    return backupSourcePath;
  }

  it("runs rules first, then clusters remaining active entries and merges them", async () => {
    const db = await makeDb();
    const backupSourcePath = await makeBackupSource();

    // Tier 1 near-exact duplicates.
    await insertEntry(db, makeEntry("Tier1", "dup-a", "decision"), vectorFromAngle(0), hashText("dup-a"));
    await insertEntry(db, makeEntry("Tier1", "dup-b", "decision"), vectorFromAngle(0), hashText("dup-b"));

    // Tier 2 cluster candidates: similar but below Tier 1 near-exact threshold.
    const tier2A = vectorFromHead([1, 0, 0]);
    const tier2B = vectorFromHead([0.9, 0.4358898943540673, 0]);
    const tier2C = vectorFromHead([0.9, 0.2064735483877485, 0.38384410931829513]);
    await insertEntry(db, makeEntry("Tier2", "cluster-a"), tier2A, hashText("cluster-a"));
    await insertEntry(db, makeEntry("Tier2", "cluster-b"), tier2B, hashText("cluster-b"));
    await insertEntry(db, makeEntry("Tier2", "cluster-c"), tier2C, hashText("cluster-c"));

    const rulesStats = await consolidateRules(db, backupSourcePath);
    expect(rulesStats.mergedCount).toBeGreaterThan(0);

    const clusters = await buildClusters(db, {
      simThreshold: 0.85,
      minCluster: 3,
      typeFilter: "fact",
    });
    expect(clusters).toHaveLength(1);

    const outcome = await mergeCluster(db, clusters[0], makeLlmClient(), "embed-key");
    expect(outcome.flagged).toBe(false);

    const active = await db.execute("SELECT COUNT(*) AS count FROM entries WHERE superseded_by IS NULL");
    expect(asNumber(active.rows[0]?.count)).toBeGreaterThan(0);

    const sourceStates = await db.execute({
      sql: "SELECT COUNT(*) AS count FROM entries WHERE id IN (?, ?, ?) AND superseded_by = ?",
      args: [...outcome.sourceIds, outcome.mergedEntryId],
    });
    expect(asNumber(sourceStates.rows[0]?.count)).toBe(3);
  });

  it("does not supersede sources when merge is flagged", async () => {
    const db = await makeDb();
    const backupSourcePath = await makeBackupSource();

    const tier2A = vectorFromHead([1, 0, 0]);
    const tier2B = vectorFromHead([0.9, 0.4358898943540673, 0]);
    const tier2C = vectorFromHead([0.9, 0.2064735483877485, 0.38384410931829513]);
    const sourceA = await insertEntry(db, makeEntry("Tier2", "cluster-a", "fact"), tier2A, hashText("cluster-a-flag"));
    await insertEntry(
      db,
      makeEntry("Tier2", "cluster-b", "preference"),
      tier2B,
      hashText("cluster-b-flag"),
    );
    const sourceC = await insertEntry(db, makeEntry("Tier2", "cluster-c", "event"), tier2C, hashText("cluster-c-flag"));

    await consolidateRules(db, backupSourcePath);

    const clusters = await buildClusters(db, { simThreshold: 0.85, minCluster: 3 });
    expect(clusters).toHaveLength(1);

    // Force verification failure by embedding drift.
    embedMock.mockResolvedValueOnce([vectorFromAngle(90)]);

    const outcome = await mergeCluster(db, clusters[0], makeLlmClient(), "embed-key");
    expect(outcome.flagged).toBe(true);

    const superseded = await db.execute({
      sql: "SELECT superseded_by FROM entries WHERE id IN (?, ?)",
      args: [sourceA, sourceC],
    });
    expect(superseded.rows.every((row) => row.superseded_by == null)).toBe(true);

    const sourceRows = await db.execute("SELECT COUNT(*) AS count FROM entry_sources");
    expect(asNumber(sourceRows.rows[0]?.count)).toBe(0);
  });
});
