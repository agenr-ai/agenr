import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runRetireCommand } from "../../src/commands/retire.js";
import { initDb } from "../../src/db/client.js";
import { retireEntries } from "../../src/db/retirements.js";
import { storeEntries } from "../../src/db/store.js";
import type { KnowledgeEntry } from "../../src/types.js";

const tempDirs: string[] = [];
const clients: Client[] = [];

function vector(): number[] {
  return [1, ...Array.from({ length: 1023 }, () => 0)];
}

async function mockEmbed(texts: string[]): Promise<number[][]> {
  return texts.map(() => vector());
}

async function makeTempDbPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-retire-command-test-"));
  tempDirs.push(dir);
  return path.join(dir, "knowledge.db");
}

function makeClient(dbPath: string): Client {
  const client = createClient({ url: `file:${dbPath}` });
  clients.push(client);
  return client;
}

function makeEntry(params: { subject: string; content: string; importance?: number }): KnowledgeEntry {
  return {
    type: "fact",
    subject: params.subject,
    content: params.content,
    importance: params.importance ?? 5,
    expiry: "temporary",
    tags: [],
    source: {
      file: "retire-command.test.jsonl",
      context: "test",
    },
  };
}

async function seedEntries(dbPath: string, entries: KnowledgeEntry[]): Promise<void> {
  const client = makeClient(dbPath);
  await initDb(client);
  await storeEntries(client, entries, "sk-test", {
    force: true,
    embedFn: mockEmbed,
    dbPath,
    sourceFile: "retire-command.test.jsonl",
    ingestContentHash: `seed-${Math.random()}`,
  });
}

afterEach(async () => {
  while (clients.length > 0) {
    clients.pop()?.close();
  }
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
  vi.restoreAllMocks();
});

describe("retire command", () => {
  it("exact match finds entry, shows it, confirms, and retires", async () => {
    const dbPath = await makeTempDbPath();
    await seedEntries(dbPath, [makeEntry({ subject: "Legacy Subject", content: "legacy content" })]);

    const lines: string[] = [];
    const result = await runRetireCommand(
      "Legacy Subject",
      { db: dbPath },
      {
        confirmFn: vi.fn(async () => true),
        textInputFn: vi.fn(async () => null),
        logFn: (line) => {
          lines.push(line);
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(lines.some((line) => line.includes('Legacy Subject"'))).toBe(true);

    const verifyClient = makeClient(dbPath);
    const row = await verifyClient.execute({
      sql: "SELECT retired FROM entries WHERE subject = ? LIMIT 1",
      args: ["Legacy Subject"],
    });
    expect(Number((row.rows[0] as { retired?: unknown } | undefined)?.retired ?? 0)).toBe(1);
  });

  it("returns exitCode 1 when no active match is found", async () => {
    const dbPath = await makeTempDbPath();
    await seedEntries(dbPath, [makeEntry({ subject: "Some Subject", content: "x" })]);

    const result = await runRetireCommand(
      "Missing Subject",
      { db: dbPath },
      {
        confirmFn: vi.fn(async () => true),
        textInputFn: vi.fn(async () => "CONFIRM"),
        logFn: vi.fn(),
      },
    );

    expect(result.exitCode).toBe(1);
  });

  it("shows all candidate entries when multiple match", async () => {
    const dbPath = await makeTempDbPath();
    await seedEntries(dbPath, [
      makeEntry({ subject: "Same Subject", content: "entry one" }),
      makeEntry({ subject: "Same Subject", content: "entry two" }),
    ]);

    const lines: string[] = [];
    await runRetireCommand(
      "Same Subject",
      { db: dbPath },
      {
        confirmFn: vi.fn(async () => true),
        textInputFn: vi.fn(async () => null),
        logFn: (line) => {
          lines.push(line);
        },
      },
    );

    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("[1]");
    expect(lines[1]).toContain("[2]");
  });

  it("--dry-run shows candidates and does not retire entries", async () => {
    const dbPath = await makeTempDbPath();
    await seedEntries(dbPath, [makeEntry({ subject: "Dry Run Subject", content: "dry run content" })]);

    const result = await runRetireCommand(
      "Dry Run Subject",
      { db: dbPath, dryRun: true },
      {
        confirmFn: vi.fn(async () => true),
        textInputFn: vi.fn(async () => "CONFIRM"),
        logFn: vi.fn(),
      },
    );

    expect(result.exitCode).toBe(0);
    const verifyClient = makeClient(dbPath);
    const row = await verifyClient.execute({
      sql: "SELECT retired FROM entries WHERE subject = ? LIMIT 1",
      args: ["Dry Run Subject"],
    });
    expect(Number((row.rows[0] as { retired?: unknown } | undefined)?.retired ?? 0)).toBe(0);
  });

  it("--persist calls retireEntries with writeLedger=true", async () => {
    const dbPath = await makeTempDbPath();
    await seedEntries(dbPath, [makeEntry({ subject: "Persist Subject", content: "persisted" })]);

    const retireSpy = vi.fn(async (opts: Parameters<typeof retireEntries>[0]) => retireEntries(opts));
    const result = await runRetireCommand(
      "Persist Subject",
      { db: dbPath, persist: true },
      {
        retireEntriesFn: retireSpy,
        confirmFn: vi.fn(async () => true),
        textInputFn: vi.fn(async () => "CONFIRM"),
        logFn: vi.fn(),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(retireSpy).toHaveBeenCalledTimes(1);
    expect(retireSpy.mock.calls[0]?.[0]).toMatchObject({ writeLedger: true });
  });

  it("importance >= 8 requires CONFIRM text input", async () => {
    const dbPath = await makeTempDbPath();
    await seedEntries(dbPath, [makeEntry({ subject: "High Subject", content: "critical", importance: 9 })]);

    const confirmFn = vi.fn(async () => true);
    const textInputFn = vi.fn(async () => "NOPE");
    const result = await runRetireCommand(
      "High Subject",
      { db: dbPath },
      {
        confirmFn,
        textInputFn,
        logFn: vi.fn(),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(textInputFn).toHaveBeenCalledTimes(1);
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it("retired entries get retired=1 and suppressed_contexts=[session-start]", async () => {
    const dbPath = await makeTempDbPath();
    await seedEntries(dbPath, [makeEntry({ subject: "Suppressed Subject", content: "suppressed content" })]);

    const result = await runRetireCommand(
      "Suppressed Subject",
      { db: dbPath },
      {
        confirmFn: vi.fn(async () => true),
        textInputFn: vi.fn(async () => null),
        logFn: vi.fn(),
      },
    );
    expect(result.exitCode).toBe(0);

    const verifyClient = makeClient(dbPath);
    const row = await verifyClient.execute({
      sql: "SELECT retired, suppressed_contexts FROM entries WHERE subject = ? LIMIT 1",
      args: ["Suppressed Subject"],
    });
    expect(Number((row.rows[0] as { retired?: unknown } | undefined)?.retired ?? 0)).toBe(1);
    const parsed = JSON.parse(
      String((row.rows[0] as { suppressed_contexts?: unknown } | undefined)?.suppressed_contexts ?? ""),
    ) as unknown[];
    expect(parsed).toEqual(["session-start"]);
  });

  it("supports retiring by --id lookup", async () => {
    const dbPath = await makeTempDbPath();
    await seedEntries(dbPath, [makeEntry({ subject: "ID Subject", content: "id content" })]);

    const lookupClient = makeClient(dbPath);
    const lookup = await lookupClient.execute({
      sql: "SELECT id FROM entries WHERE subject = ? LIMIT 1",
      args: ["ID Subject"],
    });
    const entryId = String((lookup.rows[0] as { id?: unknown } | undefined)?.id ?? "");
    expect(entryId.length).toBeGreaterThan(0);

    const retireSpy = vi.fn(async (opts: Parameters<typeof retireEntries>[0]) => retireEntries(opts));
    const result = await runRetireCommand(
      "",
      { db: dbPath, id: entryId },
      {
        retireEntriesFn: retireSpy,
        confirmFn: vi.fn(async () => true),
        textInputFn: vi.fn(async () => null),
        logFn: vi.fn(),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(retireSpy).toHaveBeenCalledTimes(1);
    expect(retireSpy.mock.calls[0]?.[0]).toMatchObject({
      subjectPattern: "ID Subject",
      matchType: "exact",
    });

    const verifyClient = makeClient(dbPath);
    const row = await verifyClient.execute({
      sql: "SELECT retired FROM entries WHERE id = ? LIMIT 1",
      args: [entryId],
    });
    expect(Number((row.rows[0] as { retired?: unknown } | undefined)?.retired ?? 0)).toBe(1);
  });
});
