import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanSessionFiles } from "../../../../src/cli/commands/init/session-scanner.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("scanSessionFiles", () => {
  it("returns zero counts when the sessions root is missing", async () => {
    const result = await scanSessionFiles("/tmp/agenr-missing-sessions-root");

    expect(result).toEqual({
      totalFiles: 0,
      allFiles: [],
      recentFiles: [],
      totalSizeBytes: 0,
      recentSizeBytes: 0,
    });
  });

  it("counts all session transcripts and recent ones separately", async () => {
    const root = await createTempDir();
    const recentFile = await writeSessionFile(root, "agents/main/sessions/recent.jsonl", "{}");
    const oldFile = await writeSessionFile(root, "agents/other/sessions/old.jsonl.gz", "{}{}");
    await writeSessionFile(root, "agents/main/logs/not-a-session.jsonl", "{}");

    const oldTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await utimes(oldFile, oldTimestamp, oldTimestamp);

    const result = await scanSessionFiles(path.join(root, "agents"));

    expect(result.totalFiles).toBe(2);
    expect(result.allFiles).toEqual([oldFile, recentFile].sort((left, right) => left.localeCompare(right)));
    expect(result.recentFiles).toEqual([recentFile]);
    expect(result.totalSizeBytes).toBe(6);
    expect(result.recentSizeBytes).toBe(2);
  });
});

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agenr-session-scan-"));
  tempDirs.push(directory);
  return directory;
}

async function writeSessionFile(root: string, relativePath: string, content: string): Promise<string> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return path.resolve(filePath);
}
