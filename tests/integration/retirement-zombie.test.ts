import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../../src/db/client.js";
import { recall } from "../../src/db/recall.js";
import { retireEntries } from "../../src/db/retirements.js";
import { storeEntries } from "../../src/db/store.js";
import type { KnowledgeEntry } from "../../src/types.js";

const tempDirs: string[] = [];
const clients: Client[] = [];

function to1024(head: number[]): number[] {
  return [...head, ...Array.from({ length: 1021 }, () => 0)];
}

function vectorForText(text: string): number[] {
  if (text.includes("Dead Project config")) return to1024([1, 0, 0]);
  return to1024([0.1, 0.1, 0.98]);
}

async function mockEmbed(texts: string[]): Promise<number[][]> {
  return texts.map((text) => vectorForText(text));
}

function makeEntry(content: string): KnowledgeEntry {
  return {
    type: "fact",
    subject: "Dead Project config",
    content,
    importance: 7,
    expiry: "temporary",
    tags: ["legacy"],
    source: {
      file: "retirement-zombie.test.jsonl",
      context: "integration test",
    },
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-retirement-zombie-"));
  tempDirs.push(dir);
  return dir;
}

function makeClient(dbPath: string): Client {
  const client = createClient({ url: `file:${dbPath}` });
  clients.push(client);
  return client;
}

afterEach(async () => {
  while (clients.length > 0) {
    clients.pop()?.close();
  }
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("integration: retirement zombie prevention", () => {
  it("re-applies retirements after re-ingest without blocking ingest", async () => {
    const dir = await makeTempDir();
    const initialDbPath = path.join(dir, "knowledge.db");
    const reingestDbPath = path.join(dir, "knowledge-reingest.db");

    const initialClient = makeClient(initialDbPath);
    await initDb(initialClient);

    const entries = [makeEntry("Dead Project config - primary"), makeEntry("Dead Project config - secondary")];

    await storeEntries(initialClient, entries, "sk-test", {
      force: true,
      embedFn: mockEmbed,
      dbPath: initialDbPath,
      sourceFile: "retirement-zombie.test.jsonl",
      ingestContentHash: "zombie-seed",
    });

    await retireEntries({
      subjectPattern: "Dead Project config",
      matchType: "exact",
      reason: "project retired",
      writeLedger: true,
      db: initialClient,
      dbPath: initialDbPath,
    });

    const retiredSeedRows = await initialClient.execute({
      sql: "SELECT retired, suppressed_contexts FROM entries WHERE subject = ?",
      args: ["Dead Project config"],
    });
    expect(retiredSeedRows.rows).toHaveLength(2);
    for (const row of retiredSeedRows.rows) {
      expect(Number((row as { retired?: unknown }).retired ?? 0)).toBe(1);
      expect(String((row as { suppressed_contexts?: unknown }).suppressed_contexts ?? "")).toContain("session-start");
    }

    const reingestClient = makeClient(reingestDbPath);
    await initDb(reingestClient);

    await storeEntries(reingestClient, entries, "sk-test", {
      force: true,
      embedFn: mockEmbed,
      dbPath: reingestDbPath,
      sourceFile: "retirement-zombie.test.jsonl",
      ingestContentHash: "zombie-reingest",
    });

    const allRows = await reingestClient.execute({
      sql: "SELECT subject, retired, suppressed_contexts FROM entries WHERE subject = ?",
      args: ["Dead Project config"],
    });
    expect(allRows.rows.length).toBeGreaterThan(0);
    for (const row of allRows.rows) {
      expect(Number((row as { retired?: unknown }).retired ?? 0)).toBe(1);
      expect(String((row as { suppressed_contexts?: unknown }).suppressed_contexts ?? "")).toContain("session-start");
    }

    const sessionStart = await recall(
      reingestClient,
      {
        text: "",
        context: "session-start",
        limit: 10,
      },
      "sk-test",
      { now: new Date("2026-02-19T00:00:00.000Z") },
    );
    expect(sessionStart.some((result) => result.entry.subject === "Dead Project config")).toBe(false);

    const explicit = await recall(
      reingestClient,
      {
        text: "Dead Project config",
        limit: 10,
      },
      "sk-test",
      { embedFn: mockEmbed, now: new Date("2026-02-19T00:00:00.000Z") },
    );
    expect(explicit.some((result) => result.entry.subject === "Dead Project config")).toBe(true);
  });
});
