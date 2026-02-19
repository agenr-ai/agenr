import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../../src/db/client.js";
import { hashText, storeEntries } from "../../src/db/store.js";
import type { KnowledgeEntry } from "../../src/types.js";

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

function vectorForText(text: string): number[] {
  const to512 = (head: number[]): number[] => [...head, ...Array.from({ length: 1021 }, () => 0)];

  if (text.includes("vec-base")) return to512([1, 0, 0]);
  if (text.includes("vec-96")) return to512([0.96, Math.sqrt(1 - 0.96 ** 2), 0]);
  if (text.includes("vec-89")) return to512([0.89, Math.sqrt(1 - 0.89 ** 2), 0]);
  if (text.includes("vec-exact")) return to512([0.999, 0.01, 0]);
  if (text.includes("vec-mid")) return to512([0.94, 0.34, 0]);
  if (text.includes("vec-low")) return to512([0.7, 0.71, 0]);
  if (text.includes("vec-v2")) return to512([0, 1, 0]);
  if (text.includes("vec-v3")) return to512([0, 0, 1]);
  if (text.includes("vec-v4")) return to512([0.5, 0.5, 0.707]);
  if (text.includes("vec-v5")) return to512([-1, 0, 0]);
  return to512([0.2, 0.2, 0.9]);
}

async function mockEmbed(texts: string[]): Promise<number[][]> {
  return texts.map((text) => vectorForText(text));
}

function makeEntry(params: {
  type?: KnowledgeEntry["type"];
  subject?: string;
  canonicalKey?: string;
  content: string;
  sourceFile?: string;
  tags?: string[];
  createdAt?: string;
}): KnowledgeEntry {
  return {
    type: params.type ?? "fact",
    subject: params.subject ?? "Jim",
    canonical_key: params.canonicalKey,
    content: params.content,
    importance: 8,
    expiry: "permanent",
    tags: params.tags ?? [],
    created_at: params.createdAt,
    source: {
      file: params.sourceFile ?? "source-a.jsonl",
      context: "unit test",
    },
  };
}

describe("db store pipeline", () => {
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

  it("stores entries, then idempotently skips the same entries on re-ingest", async () => {
    const client = makeClient();
    await initDb(client);

    const entries = [
      makeEntry({ content: "entry one vec-base", tags: ["alpha"] }),
      makeEntry({ content: "entry two vec-v2", sourceFile: "source-b.jsonl", tags: ["beta"] }),
      makeEntry({ content: "entry three vec-v3", sourceFile: "source-c.jsonl", tags: ["gamma"] }),
      makeEntry({ content: "entry four vec-v4", sourceFile: "source-d.jsonl", tags: ["delta"] }),
      makeEntry({ content: "entry five vec-v5", sourceFile: "source-e.jsonl", tags: ["epsilon"] }),
    ];

    const first = await storeEntries(client, entries, "sk-test", {
      sourceFile: "/tmp/ingest-a.json",
      ingestContentHash: hashText("first"),
      embedFn: mockEmbed,
    });

    expect(first.added).toBe(5);
    expect(first.updated).toBe(0);
    expect(first.skipped).toBe(0);

    const second = await storeEntries(client, entries, "sk-test", {
      sourceFile: "/tmp/ingest-a.json",
      ingestContentHash: hashText("second"),
      embedFn: mockEmbed,
    });

    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(5);

    const tagsResult = await client.execute("SELECT tag FROM tags ORDER BY tag ASC");
    expect(tagsResult.rows.map((row) => String(row.tag))).toEqual(["alpha", "beta", "delta", "epsilon", "gamma"]);

    const ingestLogs = await client.execute(
      "SELECT file_path, content_hash, entries_added, entries_updated, entries_skipped FROM ingest_log ORDER BY ingested_at ASC",
    );
    expect(ingestLogs.rows.length).toBe(2);
    expect(String(ingestLogs.rows[0]?.file_path)).toBe("/tmp/ingest-a.json");
    expect(String(ingestLogs.rows[0]?.content_hash)).toBe(hashText("first"));
    expect(asNumber(ingestLogs.rows[0]?.entries_added)).toBe(5);
    expect(asNumber(ingestLogs.rows[1]?.entries_skipped)).toBe(5);
  });

  it("uses entry created_at when provided", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [makeEntry({ content: "seed vec-base", sourceFile: "seed.jsonl", createdAt: "2026-02-01T10:00:00.000Z" })],
      "sk-test",
      {
        sourceFile: "seed.jsonl",
        ingestContentHash: hashText("seed"),
        embedFn: mockEmbed,
      },
    );

    const rows = await client.execute({ sql: "SELECT created_at FROM entries WHERE source_file = ?", args: ["seed.jsonl"] });
    expect(String(rows.rows[0]?.created_at)).toBe("2026-02-01T10:00:00.000Z");
  });

  it("falls back to now for created_at when missing", async () => {
    const client = makeClient();
    await initDb(client);

    const before = Date.now();
    await storeEntries(client, [makeEntry({ content: "seed vec-base", sourceFile: "seed.jsonl" })], "sk-test", {
      sourceFile: "seed.jsonl",
      ingestContentHash: hashText("seed"),
      embedFn: mockEmbed,
    });
    const after = Date.now();

    const rows = await client.execute({ sql: "SELECT created_at FROM entries WHERE source_file = ?", args: ["seed.jsonl"] });
    const createdAt = new Date(String(rows.rows[0]?.created_at)).getTime();
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(createdAt).toBeLessThanOrEqual(after + 1_000);
  });

  it("stores platform when provided (and NULL when missing)", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [{ ...makeEntry({ content: "seed vec-base", sourceFile: "seed.jsonl" }), platform: "openclaw" as const }],
      "sk-test",
      {
        sourceFile: "seed.jsonl",
        ingestContentHash: hashText("seed-platform"),
        embedFn: mockEmbed,
        force: true,
      },
    );

    await storeEntries(
      client,
      [makeEntry({ content: "seed vec-v2", sourceFile: "seed2.jsonl" })],
      "sk-test",
      {
        sourceFile: "seed2.jsonl",
        ingestContentHash: hashText("seed-platform-2"),
        embedFn: mockEmbed,
        force: true,
      },
    );

    const rows = await client.execute({
      sql: "SELECT source_file, platform FROM entries ORDER BY source_file ASC",
      args: [],
    });

    const byFile = new Map(rows.rows.map((row) => [String(row.source_file), row.platform]));
    expect(byFile.get("seed.jsonl")).toBe("openclaw");
    expect(byFile.get("seed2.jsonl")).toBe(null);
  });

  it("stores project when provided (and NULL when missing)", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [{ ...makeEntry({ content: "seed vec-base", sourceFile: "seed.jsonl" }), project: "agenr" }],
      "sk-test",
      {
        sourceFile: "seed.jsonl",
        ingestContentHash: hashText("seed-project"),
        embedFn: mockEmbed,
        force: true,
      },
    );

    await storeEntries(
      client,
      [makeEntry({ content: "seed vec-v2", sourceFile: "seed2.jsonl" })],
      "sk-test",
      {
        sourceFile: "seed2.jsonl",
        ingestContentHash: hashText("seed-project-2"),
        embedFn: mockEmbed,
        force: true,
      },
    );

    const rows = await client.execute({
      sql: "SELECT source_file, project FROM entries ORDER BY source_file ASC",
      args: [],
    });

    const byFile = new Map(rows.rows.map((row) => [String(row.source_file), row.project]));
    expect(byFile.get("seed.jsonl")).toBe("agenr");
    expect(byFile.get("seed2.jsonl")).toBe(null);
  });

  it("normalizes mixed-case project values to lowercase on store", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [{ ...makeEntry({ content: "seed vec-base", sourceFile: "seed.jsonl" }), project: "AgenR" }],
      "sk-test",
      {
        sourceFile: "seed.jsonl",
        ingestContentHash: hashText("seed-project-case"),
        embedFn: mockEmbed,
        force: true,
      },
    );

    const rows = await client.execute({ sql: "SELECT project FROM entries WHERE source_file = ?", args: ["seed.jsonl"] });
    expect(rows.rows[0]?.project).toBe("agenr");
  });

  it("skips near-exact semantic duplicates at 0.95+ similarity", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(client, [makeEntry({ content: "seed vec-base", sourceFile: "seed.jsonl" })], "sk-test", {
      sourceFile: "seed.jsonl",
      ingestContentHash: hashText("seed"),
      embedFn: mockEmbed,
    });

    const result = await storeEntries(
      client,
      [makeEntry({ content: "incoming vec-96", sourceFile: "incoming.jsonl", subject: "Different" })],
      "sk-test",
      {
        sourceFile: "incoming.jsonl",
        ingestContentHash: hashText("incoming"),
        embedFn: mockEmbed,
      },
    );

    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("updates confirmations for 0.88-0.95 matches with same subject and type", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(client, [makeEntry({ content: "seed vec-base", sourceFile: "seed.jsonl" })], "sk-test", {
      sourceFile: "seed.jsonl",
      ingestContentHash: hashText("seed"),
      embedFn: mockEmbed,
    });

    const result = await storeEntries(
      client,
      [makeEntry({ content: "reinforcement vec-89", sourceFile: "incoming.jsonl", subject: "Jim", type: "fact" })],
      "sk-test",
      {
        sourceFile: "incoming.jsonl",
        ingestContentHash: hashText("incoming"),
        embedFn: mockEmbed,
      },
    );

    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(0);

    const confirmations = await client.execute({
      sql: "SELECT confirmations FROM entries WHERE content = ?",
      args: ["seed vec-base"],
    });
    expect(asNumber(confirmations.rows[0]?.confirmations)).toBe(1);
  });

  it("adds related relation for same-subject different-type match in 0.88-0.95 band", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(client, [makeEntry({ content: "seed vec-base", sourceFile: "seed.jsonl", type: "fact" })], "sk-test", {
      sourceFile: "seed.jsonl",
      ingestContentHash: hashText("seed"),
      embedFn: mockEmbed,
    });

    const result = await storeEntries(
      client,
      [
        makeEntry({
          content: "preference variant vec-89",
          sourceFile: "incoming.jsonl",
          type: "preference",
          subject: "Jim",
        }),
      ],
      "sk-test",
      {
        sourceFile: "incoming.jsonl",
        ingestContentHash: hashText("incoming"),
        embedFn: mockEmbed,
      },
    );

    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.relations_created).toBe(1);

    const relationResult = await client.execute({
      sql: `
        SELECT relation_type
        FROM relations
        WHERE source_id = (SELECT id FROM entries WHERE content = ? LIMIT 1)
          AND target_id = (SELECT id FROM entries WHERE content = ? LIMIT 1)
      `,
      args: ["preference variant vec-89", "seed vec-base"],
    });
    expect(relationResult.rows.length).toBe(1);
    expect(String(relationResult.rows[0]?.relation_type)).toBe("related");
  });

  it("adds entries when similarity is below 0.88", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(client, [makeEntry({ content: "seed vec-base", sourceFile: "seed.jsonl" })], "sk-test", {
      sourceFile: "seed.jsonl",
      ingestContentHash: hashText("seed"),
      embedFn: mockEmbed,
    });

    const result = await storeEntries(
      client,
      [makeEntry({ content: "low similarity vec-low", sourceFile: "incoming.jsonl", subject: "Jim", type: "fact" })],
      "sk-test",
      {
        sourceFile: "incoming.jsonl",
        ingestContentHash: hashText("incoming"),
        embedFn: mockEmbed,
      },
    );

    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("treats fuzzy subject matches as same-subject for reinforcement", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [makeEntry({ content: "seed vec-base", sourceFile: "seed.jsonl", subject: "pnpm" })],
      "sk-test",
      {
        sourceFile: "seed.jsonl",
        ingestContentHash: hashText("seed"),
        embedFn: mockEmbed,
      },
    );

    const result = await storeEntries(
      client,
      [makeEntry({ content: "reinforcement vec-89", sourceFile: "incoming.jsonl", subject: "pnpm migration", type: "fact" })],
      "sk-test",
      {
        sourceFile: "incoming.jsonl",
        ingestContentHash: hashText("incoming"),
        embedFn: mockEmbed,
      },
    );

    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("treats reordered subject words as same subject", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [makeEntry({ content: "seed vec-base", sourceFile: "seed.jsonl", subject: "openclaw gateway" })],
      "sk-test",
      {
        sourceFile: "seed.jsonl",
        ingestContentHash: hashText("seed"),
        embedFn: mockEmbed,
      },
    );

    const result = await storeEntries(
      client,
      [makeEntry({ content: "reinforcement vec-89", sourceFile: "incoming.jsonl", subject: "gateway openclaw", type: "fact" })],
      "sk-test",
      {
        sourceFile: "incoming.jsonl",
        ingestContentHash: hashText("incoming"),
        embedFn: mockEmbed,
      },
    );

    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
  });

  it("does not over-match low-overlap subjects (auth vs authentication flow)", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [makeEntry({ content: "seed vec-base", sourceFile: "seed.jsonl", subject: "auth" })],
      "sk-test",
      {
        sourceFile: "seed.jsonl",
        ingestContentHash: hashText("seed"),
        embedFn: mockEmbed,
      },
    );

    const result = await storeEntries(
      client,
      [makeEntry({ content: "candidate vec-89", sourceFile: "incoming.jsonl", subject: "authentication flow", type: "fact" })],
      "sk-test",
      {
        sourceFile: "incoming.jsonl",
        ingestContentHash: hashText("incoming"),
        embedFn: mockEmbed,
      },
    );

    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("reinforces by canonical key match before embedding dedup", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [makeEntry({ content: "seed vec-base", sourceFile: "seed.jsonl", canonicalKey: "preferred-package-manager" })],
      "sk-test",
      {
        sourceFile: "seed.jsonl",
        ingestContentHash: hashText("seed"),
        embedFn: mockEmbed,
      },
    );

    const result = await storeEntries(
      client,
      [
        makeEntry({
          content: "different wording vec-low",
          sourceFile: "incoming.jsonl",
          canonicalKey: "preferred-package-manager",
          subject: "javascript tooling",
          type: "fact",
        }),
      ],
      "sk-test",
      {
        sourceFile: "incoming.jsonl",
        ingestContentHash: hashText("incoming"),
        embedFn: mockEmbed,
      },
    );

    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);

    const countRows = await client.execute("SELECT COUNT(*) AS count FROM entries");
    expect(asNumber(countRows.rows[0]?.count)).toBe(1);
  });

  it("auto-supersedes canonical-key todo when event content signals completion", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [
        makeEntry({
          type: "todo",
          subject: "fix client test",
          canonicalKey: "client-test-fix",
          content: "Fix client test flake vec-base",
          sourceFile: "seed.jsonl",
        }),
      ],
      "sk-test",
      {
        sourceFile: "seed.jsonl",
        ingestContentHash: hashText("seed-todo"),
        embedFn: mockEmbed,
      },
    );

    await storeEntries(
      client,
      [
        makeEntry({
          type: "event",
          subject: "fix client test",
          canonicalKey: "client-test-fix",
          content: "Fix client test is resolved and fixed vec-low",
          sourceFile: "event.jsonl",
        }),
      ],
      "sk-test",
      {
        sourceFile: "event.jsonl",
        ingestContentHash: hashText("event"),
        embedFn: mockEmbed,
      },
    );

    const row = await client.execute({
      sql: "SELECT id, superseded_by FROM entries WHERE type = 'todo' AND canonical_key = ?",
      args: ["client-test-fix"],
    });
    expect(String(row.rows[0]?.superseded_by)).toBe(String(row.rows[0]?.id));
  });

  it("does not auto-supersede canonical-key todo when completion signal is missing", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [
        makeEntry({
          type: "todo",
          subject: "fix client test",
          canonicalKey: "client-test-fix",
          content: "Fix client test flake vec-base",
          sourceFile: "seed.jsonl",
        }),
      ],
      "sk-test",
      {
        sourceFile: "seed.jsonl",
        ingestContentHash: hashText("seed-todo"),
        embedFn: mockEmbed,
      },
    );

    await storeEntries(
      client,
      [
        makeEntry({
          type: "event",
          subject: "fix client test",
          canonicalKey: "client-test-fix",
          content: "Work on fix client test is in progress vec-low",
          sourceFile: "event.jsonl",
        }),
      ],
      "sk-test",
      {
        sourceFile: "event.jsonl",
        ingestContentHash: hashText("event"),
        embedFn: mockEmbed,
      },
    );

    const row = await client.execute({
      sql: "SELECT superseded_by FROM entries WHERE type = 'todo' AND canonical_key = ?",
      args: ["client-test-fix"],
    });
    expect(row.rows[0]?.superseded_by).toBeNull();
  });

  it("ignores negated completion phrases and still supersedes on genuine completion", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [
        makeEntry({
          type: "todo",
          subject: "fix client test",
          canonicalKey: "client-test-fix-negated",
          content: "Fix client test flake vec-base",
          sourceFile: "seed.jsonl",
        }),
      ],
      "sk-test",
      {
        sourceFile: "seed.jsonl",
        ingestContentHash: hashText("seed-todo"),
        embedFn: mockEmbed,
      },
    );

    await storeEntries(
      client,
      [
        makeEntry({
          type: "event",
          subject: "fix client test",
          canonicalKey: "client-test-fix-negated",
          content: "Fix client test is not done, never completed, and no longer resolved vec-low",
          sourceFile: "event-negated.jsonl",
        }),
      ],
      "sk-test",
      {
        sourceFile: "event-negated.jsonl",
        ingestContentHash: hashText("event-negated"),
        embedFn: mockEmbed,
      },
    );

    const beforePositive = await client.execute({
      sql: "SELECT id, superseded_by FROM entries WHERE type = 'todo' AND canonical_key = ?",
      args: ["client-test-fix-negated"],
    });
    expect(beforePositive.rows[0]?.superseded_by).toBeNull();

    await storeEntries(
      client,
      [
        makeEntry({
          type: "todo",
          subject: "fix client auth",
          canonicalKey: "client-auth-fix-positive",
          content: "Fix client auth flow vec-base",
          sourceFile: "seed-positive.jsonl",
        }),
      ],
      "sk-test",
      {
        sourceFile: "seed-positive.jsonl",
        ingestContentHash: hashText("seed-positive"),
        embedFn: mockEmbed,
      },
    );

    await storeEntries(
      client,
      [
        makeEntry({
          type: "event",
          subject: "fix client auth",
          canonicalKey: "client-auth-fix-positive",
          content: "Fix client auth is resolved vec-low",
          sourceFile: "event-positive.jsonl",
        }),
      ],
      "sk-test",
      {
        sourceFile: "event-positive.jsonl",
        ingestContentHash: hashText("event-positive"),
        embedFn: mockEmbed,
      },
    );

    const afterPositive = await client.execute({
      sql: "SELECT id, superseded_by FROM entries WHERE type = 'todo' AND canonical_key = ?",
      args: ["client-auth-fix-positive"],
    });
    expect(String(afterPositive.rows[0]?.superseded_by)).toBe(String(afterPositive.rows[0]?.id));
  });

  it("keeps same-type canonical key reinforcement behavior", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [makeEntry({ content: "seed vec-base", sourceFile: "seed.jsonl", canonicalKey: "preferred-package-manager" })],
      "sk-test",
      {
        sourceFile: "seed.jsonl",
        ingestContentHash: hashText("seed"),
        embedFn: mockEmbed,
      },
    );

    const result = await storeEntries(
      client,
      [
        makeEntry({
          content: "different wording vec-low",
          sourceFile: "incoming.jsonl",
          canonicalKey: "preferred-package-manager",
          subject: "javascript tooling",
          type: "fact",
        }),
      ],
      "sk-test",
      {
        sourceFile: "incoming.jsonl",
        ingestContentHash: hashText("incoming"),
        embedFn: mockEmbed,
      },
    );

    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
  });

  it("keeps embedding-based dedup behavior when canonical key is missing", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(client, [makeEntry({ content: "seed vec-base", sourceFile: "seed.jsonl" })], "sk-test", {
      sourceFile: "seed.jsonl",
      ingestContentHash: hashText("seed"),
      embedFn: mockEmbed,
    });

    const result = await storeEntries(
      client,
      [makeEntry({ content: "reinforcement vec-89", sourceFile: "incoming.jsonl", subject: "Jim", type: "fact" })],
      "sk-test",
      {
        sourceFile: "incoming.jsonl",
        ingestContentHash: hashText("incoming"),
        embedFn: mockEmbed,
      },
    );

    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
  });
});
