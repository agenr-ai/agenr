import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverFiles } from "../../../src/core/ingestion/discovery.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("discoverFiles", () => {
  it("returns a single absolute file path when the target is a file", async () => {
    const directory = await createTempDirectory();
    const filePath = await writeTempFile(directory, "session.jsonl");

    const result = await discoverFiles(filePath);

    expect(result).toEqual([path.resolve(filePath)]);
  });

  it("returns matching jsonl files from a directory", async () => {
    const directory = await createTempDirectory();
    const first = await writeTempFile(directory, "a.jsonl");
    const second = await writeTempFile(directory, "b.jsonl");

    const result = await discoverFiles(directory, { recursive: false });

    expect(result).toEqual([path.resolve(first), path.resolve(second)]);
  });

  it("includes reset and deleted transcript variants", async () => {
    const directory = await createTempDirectory();
    const resetFile = await writeTempFile(directory, "session.jsonl.reset.123");
    const deletedFile = await writeTempFile(directory, "session.jsonl.deleted.456");

    const result = await discoverFiles(directory, { recursive: false });

    expect(result).toEqual([path.resolve(deletedFile), path.resolve(resetFile)]);
  });

  it("walks subdirectories recursively by default", async () => {
    const directory = await createTempDirectory();
    const nestedFile = await writeTempFile(directory, "nested/deep/session.jsonl");

    const result = await discoverFiles(directory);

    expect(result).toEqual([path.resolve(nestedFile)]);
  });

  it("excludes files without a jsonl segment in the name", async () => {
    const directory = await createTempDirectory();
    await writeTempFile(directory, "notes.txt");
    await writeTempFile(directory, "session.json");
    await writeTempFile(directory, "memory.md");

    const result = await discoverFiles(directory, { recursive: false });

    expect(result).toEqual([]);
  });

  it("returns results in sorted order", async () => {
    const directory = await createTempDirectory();
    const paths = [await writeTempFile(directory, "zeta.jsonl"), await writeTempFile(directory, "alpha.jsonl"), await writeTempFile(directory, "mid.jsonl")];

    const result = await discoverFiles(directory, { recursive: false });

    expect(result).toEqual(paths.map((filePath) => path.resolve(filePath)).sort((left, right) => left.localeCompare(right)));
  });

  it("returns an empty array for an empty directory", async () => {
    const directory = await createTempDirectory();

    const result = await discoverFiles(directory);

    expect(result).toEqual([]);
  });
});

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "agenr-discovery-"));
  tempDirectories.push(directory);
  return directory;
}

async function writeTempFile(directory: string, relativePath: string): Promise<string> {
  const filePath = path.join(directory, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "{}", "utf8");
  return filePath;
}
