import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runEvalRecallCommand } from "../../src/commands/eval.js";
import { closeDb, getDb, initDb } from "../../src/db/client.js";
import { scoreEntry } from "../../src/db/recall.js";
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
    getDbFn: getDb,
    initDbFn: initDb,
    closeDbFn: closeDb,
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

async function mockEmbed(texts: string[]): Promise<number[][]> {
  return texts.map(() => Array.from({ length: 1024 }, () => 0));
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
    expect(output).toContain("1 new");
  });
});
