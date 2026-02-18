import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runEvalRecallCommand } from "../../src/commands/eval.js";
import { closeDb, getDb, initDb } from "../../src/db/client.js";
import { recall, scoreEntry } from "../../src/db/recall.js";
import { sessionStartRecall } from "../../src/db/session-start.js";
import { storeEntries } from "../../src/db/store.js";
import type { KnowledgeEntry } from "../../src/types.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-eval-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
  vi.restoreAllMocks();
});

function makeDeps(homeDir: string) {
  return {
    readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } })),
    resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
    getDbFn: getDb,
    initDbFn: initDb,
    closeDbFn: closeDb,
    recallFn: vi.fn((db, query, apiKey, options) => recall(db, query, apiKey, { ...(options ?? {}), embedFn: mockEmbed })),
    sessionStartRecallFn: sessionStartRecall,
    scoreEntryFn: scoreEntry,
    readFileFn: fs.readFile,
    writeFileFn: fs.writeFile,
    mkdirFn: fs.mkdir,
    accessFn: fs.access,
    homedirFn: () => homeDir,
    nowFn: () => new Date("2026-02-18T00:00:00.000Z"),
  };
}

function to1024(head: number[]): number[] {
  return [...head, ...Array.from({ length: 1021 }, () => 0)];
}

function vectorForText(text: string): number[] {
  const lower = text.toLowerCase();
  if (lower.includes("preference") || lower.includes("configuration")) return to1024([1, 0, 0]);
  if (lower.includes("architecture") || lower.includes("technical")) return to1024([0, 1, 0]);
  if (lower.includes("decision")) return to1024([0, 0.9, 0.1]);
  if (lower.includes("todo") || lower.includes("task")) return to1024([0, 0, 1]);
  return to1024([0.2, 0.2, 0.2]);
}

async function mockEmbed(texts: string[]): Promise<number[][]> {
  return texts.map((text) => vectorForText(text));
}

function makeEntry(params: { content: string; type?: KnowledgeEntry["type"] }): KnowledgeEntry {
  return {
    type: params.type ?? "todo",
    subject: "Jim",
    content: params.content,
    importance: 7,
    expiry: "temporary",
    tags: [],
    source: { file: "eval.test.ts", context: "seed" },
  };
}

function sectionFor(output: string, id: string): string {
  const marker = `${id}\n`;
  const start = output.indexOf(marker);
  if (start < 0) {
    return "";
  }
  const end = output.indexOf("\n\n", start);
  return end >= 0 ? output.slice(start, end) : output.slice(start);
}

describe("eval recall command", () => {
  it("runs without error on empty DB", async () => {
    const home = await makeTempDir();
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const result = await runEvalRecallCommand({ limit: 5 }, makeDeps(home));

    expect(result.exitCode).toBe(0);
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it("--save-baseline creates a file at the expected path", async () => {
    const home = await makeTempDir();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const result = await runEvalRecallCommand({ saveBaseline: true, limit: 3 }, makeDeps(home));
    expect(result.exitCode).toBe(0);

    const baselinePath = path.join(home, ".agenr", "eval-baseline.json");
    const content = await fs.readFile(baselinePath, "utf8");
    const parsed = JSON.parse(content) as { queries?: unknown[] };
    expect(Array.isArray(parsed.queries)).toBe(true);
  });

  it("--compare loads baseline and produces diff output", async () => {
    const home = await makeTempDir();
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const dbPath = path.join(home, "agenr-eval.sqlite");
    const deps = {
      ...makeDeps(home),
      readConfigFn: vi.fn(() => ({ db: { path: dbPath } })),
    };

    const db = getDb(dbPath);
    await initDb(db);
    await storeEntries(db, [makeEntry({ content: "Seed todo 1" })], "sk-test", {
      sourceFile: "eval.test.ts",
      ingestContentHash: "hash-eval-baseline",
      embedFn: mockEmbed,
      force: true,
    });
    await closeDb(db);

    await runEvalRecallCommand({ saveBaseline: true, limit: 3 }, deps);

    const db2 = getDb(dbPath);
    await initDb(db2);
    await storeEntries(db2, [makeEntry({ content: "Seed todo 2" })], "sk-test", {
      sourceFile: "eval.test.ts",
      ingestContentHash: "hash-eval-compare",
      embedFn: mockEmbed,
      force: true,
    });
    await closeDb(db2);

    const compareResult = await runEvalRecallCommand({ compare: true, limit: 3 }, deps);

    expect(compareResult.exitCode).toBe(0);
    const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toMatch(/\d+ new/);
  });

  it("uses structured and semantic recall paths for default categories", async () => {
    const home = await makeTempDir();
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const dbPath = path.join(home, "agenr-eval-categories.sqlite");
    const deps = {
      ...makeDeps(home),
      readConfigFn: vi.fn(() => ({ db: { path: dbPath } })),
    };

    const db = getDb(dbPath);
    await initDb(db);
    await storeEntries(
      db,
      [
        makeEntry({ type: "decision", content: "Decision: adopt architecture ADR process" }),
        makeEntry({ type: "decision", content: "Decision: move ingestion to a queue" }),
        makeEntry({ type: "todo", content: "Todo: finish active task backlog" }),
        makeEntry({ type: "todo", content: "Task: write migration checklist" }),
        makeEntry({ type: "preference", content: "Preference: user prefers compact CLI configuration output" }),
        makeEntry({ type: "fact", content: "Architecture uses modular services with clear technical boundaries" }),
      ],
      "sk-test",
      {
        sourceFile: "eval.test.ts",
        ingestContentHash: "hash-eval-categories",
        embedFn: mockEmbed,
        force: true,
      },
    );
    await closeDb(db);

    const result = await runEvalRecallCommand({ limit: 5 }, deps);
    expect(result.exitCode).toBe(0);

    const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    const sessionStartSection = sectionFor(output, "session-start");
    const recentDecisionsSection = sectionFor(output, "recent-decisions");
    const activeTodosSection = sectionFor(output, "active-todos");
    const preferencesSection = sectionFor(output, "preferences");
    const architectureSection = sectionFor(output, "architecture");

    expect(sessionStartSection).not.toContain("(no results)");

    expect(recentDecisionsSection).not.toContain("(no results)");
    expect(recentDecisionsSection).toMatch(/\sdecision\s/);
    expect(recentDecisionsSection).not.toMatch(/\stodo\s/);

    expect(activeTodosSection).not.toContain("(no results)");
    expect(activeTodosSection).toMatch(/\stodo\s/);
    expect(activeTodosSection).not.toMatch(/\sdecision\s/);

    expect(preferencesSection).not.toContain("(no results)");
    expect(preferencesSection).toMatch(/\spreference\s/);

    expect(architectureSection).not.toContain("(no results)");
    expect(architectureSection.toLowerCase()).toContain("architecture");
  });
});
