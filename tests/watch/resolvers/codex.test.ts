import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexSessionResolver } from "../../../src/watch/resolvers/codex.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-codex-resolver-test-"));
  tempDirs.push(dir);
  return dir;
}

async function setMtime(filePath: string, isoDate: string): Promise<void> {
  const date = new Date(isoDate);
  await fs.utimes(filePath, date, date);
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("codex session resolver", () => {
  it("recursively picks the newest jsonl under the date tree", async () => {
    const dir = await makeTempDir();
    const oldFile = path.join(dir, "2026", "02", "15", "old.jsonl");
    const newFile = path.join(dir, "2026", "02", "16", "new.jsonl");

    await fs.mkdir(path.dirname(oldFile), { recursive: true });
    await fs.mkdir(path.dirname(newFile), { recursive: true });
    await fs.writeFile(oldFile, "{}\n", "utf8");
    await fs.writeFile(newFile, "{}\n", "utf8");

    await setMtime(oldFile, "2026-02-15T01:00:00.000Z");
    await setMtime(newFile, "2026-02-16T01:00:00.000Z");

    const active = await codexSessionResolver.resolveActiveSession(dir);

    expect(active).toBe(path.resolve(newFile));
  });
});
