import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHealthCommand } from "../../src/commands/health.js";
import { initDb } from "../../src/db/client.js";
import type { AgenrConfig } from "../../src/types.js";

describe("health command", () => {
  const clients: Client[] = [];

  afterEach(() => {
    while (clients.length > 0) {
      clients.pop()?.close();
    }
    vi.restoreAllMocks();
  });

  async function insertEntry(
    client: Client,
    params: {
      id: string;
      type: string;
      subject: string;
      content?: string;
      importance?: number;
      expiry?: string;
      scope?: string;
      createdAt: string;
      updatedAt: string;
      recallCount?: number;
      contradictions?: number;
      qualityScore?: number;
    },
  ): Promise<void> {
    await client.execute({
      sql: `
        INSERT INTO entries (
          id, type, subject, content, importance, expiry, scope, source_file, source_context,
          created_at, updated_at, recall_count, contradictions, quality_score
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        params.id,
        params.type,
        params.subject,
        params.content ?? "health content",
        params.importance ?? 5,
        params.expiry ?? "temporary",
        params.scope ?? "private",
        "health.test.jsonl",
        "test",
        params.createdAt,
        params.updatedAt,
        params.recallCount ?? 0,
        params.contradictions ?? 0,
        params.qualityScore ?? 0.5,
      ],
    });
  }

  async function runWithClient(
    client: Client,
    nowIso = "2026-02-18T00:00:00.000Z",
    config: AgenrConfig = { db: { path: ":memory:" } },
  ): Promise<string> {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const result = await runHealthCommand(
      {},
      {
        readConfigFn: vi.fn(() => config),
        getDbFn: vi.fn(() => client),
        closeDbFn: vi.fn(() => undefined),
        statFn: vi.fn(async () => ({ size: 0 } as unknown as fs.Stats)),
        nowFn: vi.fn(() => new Date(nowIso)),
      },
    );
    expect(result.exitCode).toBe(0);
    return stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
  }

  it("runs against an in-memory DB and prints health sections", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    await initDb(client);

    await insertEntry(client, {
      id: "e1",
      type: "fact",
      subject: "Health",
      importance: 7,
      expiry: "permanent",
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });

    const output = await runWithClient(client);
    expect(output).toContain("Entries:");
    expect(output).toContain("File size:");
    expect(output).toContain("Forgetting Candidates");
    expect(output).toContain("Co-Recall Edges");
    expect(output).toContain("Review Queue");
  });

  it("reports an empty database cleanly", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    await initDb(client);

    const output = await runWithClient(client);
    expect(output).toContain("Entries: 0 total");
    expect(output).toContain("Recency Distribution");
    expect(output).toContain("Consolidation Health");
  });

  it("shows old low-score entries as forgetting candidates", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    await initDb(client);

    await insertEntry(client, {
      id: "old-1",
      type: "fact",
      subject: "Old candidate",
      importance: 1,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });

    const output = await runWithClient(client, "2026-02-18T00:00:00.000Z", {
      db: { path: ":memory:" },
      forgetting: { scoreThreshold: 0.2, maxAgeDays: 60, protect: [] },
    });
    expect(output).toContain("Forgetting Candidates");
    expect(output).toMatch(/- score < 0\.2:\s+1 entries/);
  });

  it("reports contradiction flags and stale todos in consolidation health", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    await initDb(client);

    await insertEntry(client, {
      id: "todo-stale",
      type: "todo",
      subject: "Old todo",
      importance: 5,
      createdAt: "2025-10-01T00:00:00.000Z",
      updatedAt: "2025-10-01T00:00:00.000Z",
      recallCount: 0,
    });
    await insertEntry(client, {
      id: "fact-contradiction",
      type: "fact",
      subject: "Disputed",
      importance: 6,
      createdAt: "2026-01-10T00:00:00.000Z",
      updatedAt: "2026-01-10T00:00:00.000Z",
      contradictions: 2,
    });

    const output = await runWithClient(client);
    expect(output).toContain("Consolidation Health");
    expect(output).toContain("Contradiction flags: 1 entries");
    expect(output).toContain("Stale todos (>30d old, not recalled): 1");
  });

  it("includes quality score distribution", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    await initDb(client);

    await insertEntry(client, {
      id: "quality-high",
      type: "fact",
      subject: "High quality",
      qualityScore: 0.9,
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
    await insertEntry(client, {
      id: "quality-medium",
      type: "fact",
      subject: "Medium quality",
      qualityScore: 0.5,
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
    await insertEntry(client, {
      id: "quality-low",
      type: "fact",
      subject: "Low quality",
      qualityScore: 0.2,
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });

    const output = await runWithClient(client);
    expect(output).toContain("Quality Score Distribution");
    expect(output).toContain("High (>= 0.7):      1 entries");
    expect(output).toContain("Medium (0.3-0.7):  1 entries");
    expect(output).toContain("Low (< 0.3):       1 entries");
    expect(output).toContain("Average:           0.53");
  });

  it("includes co-recall and review queue stats", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    await initDb(client);

    await insertEntry(client, {
      id: "edge-a",
      type: "fact",
      subject: "Edge A",
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
    await insertEntry(client, {
      id: "edge-b",
      type: "fact",
      subject: "Edge B",
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });

    await client.execute({
      sql: `
        INSERT INTO co_recall_edges (
          entry_a, entry_b, weight, session_count, last_co_recalled, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      args: [
        "edge-a",
        "edge-b",
        0.9,
        4,
        "2026-02-17T12:00:00.000Z",
        "2026-02-10T12:00:00.000Z",
      ],
    });

    await client.execute({
      sql: `
        INSERT INTO review_queue (
          id, entry_id, reason, detail, suggested_action, status, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        "review-1",
        "edge-a",
        "low_quality",
        "quality_score 0.100 after 12 recalls",
        "retire",
        "pending",
        "2026-02-10T00:00:00.000Z",
      ],
    });

    const output = await runWithClient(client, "2026-02-18T00:00:00.000Z");
    expect(output).toContain("Co-Recall Edges");
    expect(output).toContain("Total edges:       1");
    expect(output).toContain("Edge A <-> Edge B (0.90)");
    expect(output).toContain("Review Queue");
    expect(output).toContain("Total pending:     1");
    expect(output).toContain("Pending by reason: low_quality=1");
  });
});
