import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("initDb vector index probe", () => {
  const clients: Client[] = [];
  const resetModules = () => {
    if (typeof vi.resetModules === "function") {
      vi.resetModules();
    }
  };

  afterEach(() => {
    while (clients.length > 0) {
      clients.pop()?.close();
    }
    vi.restoreAllMocks();
    resetModules();
  });

  async function initDb(client: Client): Promise<void> {
    // Import dynamically so `didWarnVectorIndexCorruption` is fresh per test.
    resetModules();
    const mod = await import("../../src/db/client.js");
    await mod.initDb(client);
  }

  it("warns (but does not throw) when vector index is missing/corrupt", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

    await initDb(client);

    const embedding = Array.from({ length: 512 }, (_, i) => (i % 97) / 97);
    const now = "2026-02-14T00:00:00.000Z";
    await client.execute({
      sql: `
        INSERT INTO entries (
          id,
          type,
          subject,
          content,
          importance,
          expiry,
          scope,
          source_file,
          source_context,
          embedding,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, vector32(?), ?, ?)
      `,
      args: [
        "e1",
        "fact",
        "S",
        "A",
        8,
        "temporary",
        "private",
        "seed.jsonl",
        "test",
        JSON.stringify(embedding),
        now,
        now,
      ],
    });

    await client.execute("DROP INDEX IF EXISTS idx_entries_embedding");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(initDb(client)).resolves.toBeUndefined();

    const stderr = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(stderr).toContain("Vector index may be corrupted");
    expect(stderr).toContain("agenr db rebuild-index");
  });
});
