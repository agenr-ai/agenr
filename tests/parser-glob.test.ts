import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expandInputFiles } from "../src/parser.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-parser-glob-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("expandInputFiles glob handling", () => {
  it("handles brace expansion {md,txt,jsonl}", async () => {
    const dir = await makeTempDir();
    const mdFile = path.join(dir, "note.md");
    const txtFile = path.join(dir, "note.txt");
    const jsonlFile = path.join(dir, "note.jsonl");
    const ignoredFile = path.join(dir, "note.csv");

    await fs.writeFile(mdFile, "md", "utf8");
    await fs.writeFile(txtFile, "txt", "utf8");
    await fs.writeFile(jsonlFile, "jsonl", "utf8");
    await fs.writeFile(ignoredFile, "csv", "utf8");

    const files = await expandInputFiles([path.join(dir, "*.{md,txt,jsonl}")]);

    expect(files).toEqual([jsonlFile, mdFile, txtFile].sort((a, b) => a.localeCompare(b)));
  });

  it("handles ** recursive with brace expansion", async () => {
    const dir = await makeTempDir();
    const rootMd = path.join(dir, "root.md");
    const nestedTxt = path.join(dir, "sub", "nested.txt");
    const deepJsonl = path.join(dir, "sub", "deep", "nested.jsonl");
    const ignored = path.join(dir, "sub", "skip.bin");

    await fs.mkdir(path.dirname(deepJsonl), { recursive: true });
    await fs.writeFile(rootMd, "root", "utf8");
    await fs.writeFile(nestedTxt, "nested", "utf8");
    await fs.writeFile(deepJsonl, "deep", "utf8");
    await fs.writeFile(ignored, "ignored", "utf8");

    const files = await expandInputFiles([path.join(dir, "**/*.{md,txt,jsonl}")]);

    expect(files).toEqual([deepJsonl, nestedTxt, rootMd].sort((a, b) => a.localeCompare(b)));
  });
});
