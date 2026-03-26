import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { computeTranscriptFileHash, discoverTranscriptFiles } from "../../../src/adapters/files/transcript-files.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("discoverTranscriptFiles", () => {
  it("returns a single absolute file path when the target is a file", async () => {
    const directory = await createTempDirectory();
    const filePath = await writeTempFile(directory, "session.jsonl");

    const result = await discoverTranscriptFiles(filePath);

    expect(result).toEqual([path.resolve(filePath)]);
  });

  it("returns matching jsonl files from a directory", async () => {
    const directory = await createTempDirectory();
    const first = await writeTempFile(directory, "a.jsonl");
    const second = await writeTempFile(directory, "b.jsonl");

    const result = await discoverTranscriptFiles(directory, { recursive: false });

    expect(result).toEqual([path.resolve(first), path.resolve(second)]);
  });

  it("includes reset and deleted transcript variants", async () => {
    const directory = await createTempDirectory();
    const resetFile = await writeTempFile(directory, "session.jsonl.reset.123");
    const deletedFile = await writeTempFile(directory, "session.jsonl.deleted.456");

    const result = await discoverTranscriptFiles(directory, { recursive: false });

    expect(result).toEqual([path.resolve(deletedFile), path.resolve(resetFile)]);
  });

  it("walks subdirectories recursively by default", async () => {
    const directory = await createTempDirectory();
    const nestedFile = await writeTempFile(directory, "nested/deep/session.jsonl");

    const result = await discoverTranscriptFiles(directory);

    expect(result).toEqual([path.resolve(nestedFile)]);
  });

  it("excludes files without a jsonl segment in the name", async () => {
    const directory = await createTempDirectory();
    await writeTempFile(directory, "notes.txt");
    await writeTempFile(directory, "session.json");
    await writeTempFile(directory, "memory.md");

    const result = await discoverTranscriptFiles(directory, { recursive: false });

    expect(result).toEqual([]);
  });

  it("returns results in sorted order", async () => {
    const directory = await createTempDirectory();
    const paths = [await writeTempFile(directory, "zeta.jsonl"), await writeTempFile(directory, "alpha.jsonl"), await writeTempFile(directory, "mid.jsonl")];

    const result = await discoverTranscriptFiles(directory, { recursive: false });

    expect(result).toEqual(paths.map((filePath) => path.resolve(filePath)).sort((left, right) => left.localeCompare(right)));
  });

  it("returns an empty array for an empty directory", async () => {
    const directory = await createTempDirectory();

    const result = await discoverTranscriptFiles(directory);

    expect(result).toEqual([]);
  });
});

describe("computeTranscriptFileHash", () => {
  it("returns a stable SHA-256 digest for the file contents", async () => {
    const directory = await createTempDirectory();
    const filePath = await writeTempFile(directory, "session.jsonl", "hello world");

    const firstHash = await computeTranscriptFileHash(filePath);
    const secondHash = await computeTranscriptFileHash(filePath);

    expect(firstHash).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
    expect(secondHash).toBe(firstHash);
  });
});

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "agenr-discovery-"));
  tempDirectories.push(directory);
  return directory;
}

async function writeTempFile(directory: string, relativePath: string, content = "{}"): Promise<string> {
  const filePath = path.join(directory, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return filePath;
}
