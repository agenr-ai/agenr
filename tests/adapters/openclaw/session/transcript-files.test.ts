import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverOpenClawTranscriptFiles } from "../../../../src/adapters/openclaw/session/transcript-files.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("discoverOpenClawTranscriptFiles", () => {
  it("finds active, reset, and deleted session transcripts while ignoring noise", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agenr-openclaw-discovery-"));
    tempDirectories.push(root);
    const nested = path.join(root, "nested");
    await mkdir(nested, { recursive: true });

    const active = path.join(root, "123e4567-e89b-12d3-a456-426614174000.jsonl");
    const reset = path.join(nested, "123e4567-e89b-12d3-a456-426614174001.jsonl.reset.1711111111");
    const deleted = path.join(root, "123e4567-e89b-12d3-a456-426614174002.jsonl.deleted.1711111112");
    await writeFile(active, "", "utf8");
    await writeFile(reset, "", "utf8");
    await writeFile(deleted, "", "utf8");
    await writeFile(path.join(root, "sessions.json"), "{}", "utf8");
    await writeFile(path.join(root, "notes.jsonl"), "", "utf8");
    await writeFile(path.join(root, ".DS_Store"), "", "utf8");

    expect(await discoverOpenClawTranscriptFiles(root)).toEqual([active, deleted, reset].sort((left, right) => left.localeCompare(right)));
  });

  it("returns an explicitly requested valid transcript file and rejects non-matching direct files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agenr-openclaw-discovery-file-"));
    tempDirectories.push(root);
    const validFile = path.join(root, "123e4567-e89b-12d3-a456-426614174003.jsonl");
    const invalidFile = path.join(root, "manual-session.jsonl");
    await writeFile(validFile, "", "utf8");
    await writeFile(invalidFile, "", "utf8");

    expect(await discoverOpenClawTranscriptFiles(validFile)).toEqual([validFile]);
    expect(await discoverOpenClawTranscriptFiles(invalidFile)).toEqual([]);
  });
});
