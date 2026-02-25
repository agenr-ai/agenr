import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanSessionFiles } from "./session-scanner.js";

const tempDirs: string[] = [];

async function createTempDir(prefix = "agenr-session-scan-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeFileWithContent(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("scanSessionFiles", () => {
  it("scanSessionFiles finds .jsonl files in directory", async () => {
    const sessionsDir = await createTempDir();
    const fileA = path.join(sessionsDir, "a.jsonl");
    const fileB = path.join(sessionsDir, "b.jsonl");
    await writeFileWithContent(fileA, "a");
    await writeFileWithContent(fileB, "b");

    const result = await scanSessionFiles(sessionsDir);

    expect(result.totalFiles).toBe(2);
    expect([...result.allFiles].sort()).toEqual([fileA, fileB].sort());
  });

  it("scanSessionFiles finds .jsonl.gz files", async () => {
    const sessionsDir = await createTempDir();
    const gzFile = path.join(sessionsDir, "compressed.jsonl.gz");
    await writeFileWithContent(gzFile, "gz-content");

    const result = await scanSessionFiles(sessionsDir);

    expect(result.totalFiles).toBe(1);
    expect(result.allFiles).toEqual([gzFile]);
  });

  it("scanSessionFiles filters recent files by mtime", async () => {
    const sessionsDir = await createTempDir();
    const recentFile = path.join(sessionsDir, "recent.jsonl");
    const oldFile = path.join(sessionsDir, "old.jsonl");
    await writeFileWithContent(recentFile, "recent");
    await writeFileWithContent(oldFile, "old");

    const oldTime = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    await fs.utimes(oldFile, oldTime, oldTime);

    const result = await scanSessionFiles(sessionsDir, 7);

    expect(result.totalFiles).toBe(2);
    expect(result.recentFiles).toEqual([recentFile]);
  });

  it("scanSessionFiles returns empty result for missing directory", async () => {
    const missingDir = path.join(os.tmpdir(), `agenr-missing-${Date.now()}-${Math.random()}`);
    const result = await scanSessionFiles(missingDir);

    expect(result.totalFiles).toBe(0);
    expect(result.recentFiles).toEqual([]);
    expect(result.allFiles).toEqual([]);
    expect(result.totalSizeBytes).toBe(0);
    expect(result.recentSizeBytes).toBe(0);
  });

  it("scanSessionFiles ignores non-jsonl files", async () => {
    const sessionsDir = await createTempDir();
    await writeFileWithContent(path.join(sessionsDir, "notes.txt"), "text");
    await writeFileWithContent(path.join(sessionsDir, "data.json"), "{}");
    await writeFileWithContent(path.join(sessionsDir, "valid.jsonl"), "ok");

    const result = await scanSessionFiles(sessionsDir);

    expect(result.totalFiles).toBe(1);
    expect(result.allFiles).toEqual([path.join(sessionsDir, "valid.jsonl")]);
  });

  it("scanSessionFiles calculates total and recent size", async () => {
    const sessionsDir = await createTempDir();
    const recentFile = path.join(sessionsDir, "recent.jsonl");
    const oldFile = path.join(sessionsDir, "old.jsonl");
    await writeFileWithContent(recentFile, "12345");
    await writeFileWithContent(oldFile, "1234567890");

    const oldTime = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    await fs.utimes(oldFile, oldTime, oldTime);

    const result = await scanSessionFiles(sessionsDir, 7);

    expect(result.totalSizeBytes).toBe(15);
    expect(result.recentSizeBytes).toBe(5);
  });

  it("scanSessionFiles discovers files in nested subdirectories", async () => {
    const sessionsDir = await createTempDir();
    const nestedA = path.join(sessionsDir, "2026", "02", "one.jsonl");
    const nestedB = path.join(sessionsDir, "2026", "03", "two.jsonl.gz");
    await writeFileWithContent(nestedA, "one");
    await writeFileWithContent(nestedB, "two");

    const result = await scanSessionFiles(sessionsDir);

    expect(result.totalFiles).toBe(2);
    expect([...result.allFiles].sort()).toEqual([nestedA, nestedB].sort());
  });
});
