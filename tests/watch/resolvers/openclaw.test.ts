import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openClawSessionResolver } from "../../../src/watch/resolvers/openclaw.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-openclaw-resolver-test-"));
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

describe("openclaw session resolver", () => {
  it("uses sessions.json and filters out spawned subagents", async () => {
    const dir = await makeTempDir();
    const mainOld = path.join(dir, "main-old.jsonl");
    const mainNew = path.join(dir, "main-new.jsonl");
    const subagent = path.join(dir, "subagent.jsonl");

    await fs.writeFile(mainOld, "{}\n", "utf8");
    await fs.writeFile(mainNew, "{}\n", "utf8");
    await fs.writeFile(subagent, "{}\n", "utf8");

    const manifest = {
      sessions: [
        { sessionFile: "main-old.jsonl", updatedAt: "2026-02-01T00:00:00.000Z" },
        { sessionFile: "subagent.jsonl", updatedAt: "2026-02-10T00:00:00.000Z", spawnedBy: "main" },
        { sessionFile: "main-new.jsonl", updatedAt: "2026-02-05T00:00:00.000Z" },
      ],
    };

    await fs.writeFile(path.join(dir, "sessions.json"), JSON.stringify(manifest), "utf8");

    const active = await openClawSessionResolver.resolveActiveSession(dir);

    expect(active).toBe(path.resolve(mainNew));
  });

  it("falls back to mtime when sessions.json is missing", async () => {
    const dir = await makeTempDir();
    const first = path.join(dir, "a.jsonl");
    const second = path.join(dir, "b.jsonl");

    await fs.writeFile(first, "{}\n", "utf8");
    await fs.writeFile(second, "{}\n", "utf8");
    await setMtime(first, "2026-02-01T00:00:00.000Z");
    await setMtime(second, "2026-02-03T00:00:00.000Z");

    const active = await openClawSessionResolver.resolveActiveSession(dir);

    expect(active).toBe(path.resolve(second));
  });

  it("falls back to mtime when sessions.json is corrupt", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "session.jsonl");

    await fs.writeFile(filePath, "{}\n", "utf8");
    await fs.writeFile(path.join(dir, "sessions.json"), "{invalid", "utf8");

    const active = await openClawSessionResolver.resolveActiveSession(dir);

    expect(active).toBe(path.resolve(filePath));
  });

  it("findRenamedFile returns null when no reset files exist", async () => {
    const dir = await makeTempDir();
    const original = path.join(dir, "abc123.jsonl");

    const resolved = await openClawSessionResolver.findRenamedFile(original);

    expect(resolved).toBeNull();
  });

  it("findRenamedFile finds the reset file matching the original filename", async () => {
    const dir = await makeTempDir();
    const original = path.join(dir, "abc123.jsonl");
    const reset = path.join(dir, "abc123.jsonl.reset.2026-02-17T19-52-05.323Z");

    await fs.writeFile(reset, "{}\n", "utf8");

    const resolved = await openClawSessionResolver.findRenamedFile(original);

    expect(resolved).toBe(reset);
  });

  it("findRenamedFile picks the most recent when multiple reset files exist", async () => {
    const dir = await makeTempDir();
    const original = path.join(dir, "abc123.jsonl");
    const older = path.join(dir, "abc123.jsonl.reset.2026-02-17T19-52-05.323Z");
    const newer = path.join(dir, "abc123.jsonl.reset.2026-02-17T19-52-06.323Z");

    await fs.writeFile(older, "{}\n", "utf8");
    await fs.writeFile(newer, "{}\n", "utf8");

    const resolved = await openClawSessionResolver.findRenamedFile(original);

    expect(resolved).toBe(newer);
  });

  it("findRenamedFile returns null when directory doesn't exist", async () => {
    const original = "/tmp/agenr-openclaw-resolver-test-missing/abc123.jsonl";

    const resolved = await openClawSessionResolver.findRenamedFile(original);

    expect(resolved).toBeNull();
  });

  it("findRenamedFile ignores reset files for other sessions", async () => {
    const dir = await makeTempDir();
    const original = path.join(dir, "abc123.jsonl");
    const otherReset = path.join(dir, "def456.jsonl.reset.2026-02-17T19-52-05.323Z");

    await fs.writeFile(otherReset, "{}\n", "utf8");

    const resolved = await openClawSessionResolver.findRenamedFile(original);

    expect(resolved).toBeNull();
  });
});
