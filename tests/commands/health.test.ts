import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHealthCommand } from "../../src/commands/health.js";
import { initDb } from "../../src/db/client.js";

describe("health command", () => {
  const clients: Client[] = [];

  afterEach(() => {
    while (clients.length > 0) {
      clients.pop()?.close();
    }
    vi.restoreAllMocks();
  });

  it("runs against an in-memory DB and prints health sections", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    await initDb(client);

    await client.execute({
      sql: `
        INSERT INTO entries (
          id, type, subject, content, importance, expiry, scope, source_file, source_context, created_at, updated_at, recall_count
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        "e1",
        "fact",
        "Health",
        "health content",
        7,
        "permanent",
        "private",
        "health.test.jsonl",
        "test",
        "2026-02-01T00:00:00.000Z",
        "2026-02-01T00:00:00.000Z",
        0,
      ],
    });

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const result = await runHealthCommand(
      {},
      {
        readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } })),
        getDbFn: vi.fn(() => client),
        closeDbFn: vi.fn(() => undefined),
        nowFn: vi.fn(() => new Date("2026-02-18T00:00:00.000Z")),
      },
    );

    expect(result.exitCode).toBe(0);
    const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Entries:");
    expect(output).toContain("File size:");
    expect(output).toContain("Forgetting Candidates");
  });
});

