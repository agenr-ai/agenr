import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../../src/db/client.js";
import { createMcpServer } from "../../src/mcp/server.js";

const clients: Client[] = [];

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return Number(value);
  }
  return Number.NaN;
}

function makeClient(): Client {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  return client;
}

async function insertEntry(client: Client, id: string, importance: number, content: string): Promise<number> {
  const createdAt = new Date().toISOString();
  await client.execute({
    sql: `
      INSERT INTO entries (
        id, type, subject, content, importance, expiry, scope, source_file, source_context,
        created_at, updated_at, retired
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `,
    args: [
      id,
      "fact",
      id,
      content,
      importance,
      "temporary",
      "private",
      "signals-since-seq.test.jsonl",
      "integration test",
      createdAt,
      createdAt,
    ],
  });
  const row = await client.execute({
    sql: "SELECT rowid FROM entries WHERE id = ?",
    args: [id],
  });
  return toNumber((row.rows[0] as { rowid?: unknown } | undefined)?.rowid);
}

function getToolText(response: unknown): string {
  const payload = response as {
    result?: { content?: Array<{ type?: string; text?: string }> };
  };
  return payload.result?.content?.[0]?.text ?? "";
}

afterEach(() => {
  while (clients.length > 0) {
    clients.pop()?.close();
  }
});

describe("integration: since_seq incremental recall", () => {
  it("returns all entries by rowid and supports high-watermark empty responses", async () => {
    const client = makeClient();
    await initDb(client);

    const rowid1 = await insertEntry(client, "entry-1", 5, "importance 5");
    const rowid2 = await insertEntry(client, "entry-2", 8, "importance 8");
    const rowid3 = await insertEntry(client, "entry-3", 9, "importance 9");

    const server = createMcpServer(
      {},
      {
        readConfigFn: () => ({ db: { path: ":memory:" } }),
        resolveEmbeddingApiKeyFn: () => "sk-test",
        getDbFn: () => client,
        initDbFn: async () => undefined,
        closeDbFn: () => undefined,
      },
    );

    const first = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "agenr_recall",
        arguments: {
          since_seq: 0,
          limit: 10,
        },
      },
    });

    const firstText = getToolText(first);
    expect(firstText).toContain("3 entries since seq 0:");
    expect(firstText).toContain(`[rowid=${rowid1}] [id=entry-1]`);
    expect(firstText).toContain(`[rowid=${rowid2}] [id=entry-2]`);
    expect(firstText).toContain(`[rowid=${rowid3}] [id=entry-3]`);
    const pos1 = firstText.indexOf(`[rowid=${rowid1}] [id=entry-1]`);
    const pos2 = firstText.indexOf(`[rowid=${rowid2}] [id=entry-2]`);
    const pos3 = firstText.indexOf(`[rowid=${rowid3}] [id=entry-3]`);
    expect(pos1).toBeGreaterThan(-1);
    expect(pos2).toBeGreaterThan(pos1);
    expect(pos3).toBeGreaterThan(pos2);

    const highWatermark = Math.max(rowid1, rowid2, rowid3) + 100;
    const second = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "agenr_recall",
        arguments: {
          since_seq: highWatermark,
          limit: 10,
        },
      },
    });

    const secondText = getToolText(second);
    expect(secondText).toBe(`No new entries since seq ${highWatermark}.`);

    await server.stop();
  });
});
