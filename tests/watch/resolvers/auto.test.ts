import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAutoSession } from "../../../src/watch/resolvers/auto.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-auto-resolver-test-"));
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
  vi.restoreAllMocks();
});

describe("auto session resolver", () => {
  it("picks the most recently active session across supported platforms", async () => {
    const fakeHome = await makeTempDir();
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    const openclawDir = path.join(fakeHome, ".openclaw", "agents", "main", "sessions");
    const claudeProject = path.join(fakeHome, ".claude", "projects", "project-a");
    const codexDir = path.join(fakeHome, ".codex", "sessions", "2026", "02", "16");

    await fs.mkdir(openclawDir, { recursive: true });
    await fs.mkdir(claudeProject, { recursive: true });
    await fs.mkdir(codexDir, { recursive: true });

    const openclawFile = path.join(openclawDir, "openclaw.jsonl");
    const claudeFile = path.join(claudeProject, "claude.jsonl");
    const codexFile = path.join(codexDir, "codex.jsonl");

    await fs.writeFile(openclawFile, "{}\n", "utf8");
    await fs.writeFile(claudeFile, "{}\n", "utf8");
    await fs.writeFile(codexFile, "{}\n", "utf8");

    await fs.writeFile(
      path.join(openclawDir, "sessions.json"),
      JSON.stringify({ sessions: [{ sessionFile: "openclaw.jsonl", updatedAt: "2026-02-01T00:00:00.000Z" }] }),
      "utf8",
    );

    await setMtime(openclawFile, "2026-02-10T00:00:00.000Z");
    await setMtime(codexFile, "2026-02-11T00:00:00.000Z");
    await setMtime(claudeFile, "2026-02-12T00:00:00.000Z");

    const result = await resolveAutoSession();

    expect(result.discoveredRoots.map((root) => root.platform).sort()).toEqual(["claude-code", "codex", "openclaw"]);
    expect(result.platform).toBe("claude-code");
    expect(result.activeFile).toBe(path.resolve(claudeFile));
  });

  it("returns no active file when no platform roots are present", async () => {
    const fakeHome = await makeTempDir();
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    const result = await resolveAutoSession();

    expect(result.discoveredRoots).toEqual([]);
    expect(result.activeFile).toBeNull();
    expect(result.platform).toBeNull();
  });
});
