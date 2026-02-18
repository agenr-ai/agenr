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
  it("resolves the active OpenClaw session (legacy auto resolver)", async () => {
    const fakeHome = await makeTempDir();
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    const openclawDir = path.join(fakeHome, ".openclaw", "agents", "main", "sessions");
    await fs.mkdir(openclawDir, { recursive: true });

    const openclawFile = path.join(openclawDir, "openclaw.jsonl");
    await fs.writeFile(openclawFile, "{}\n", "utf8");

    await fs.writeFile(
      path.join(openclawDir, "sessions.json"),
      JSON.stringify({ sessions: [{ sessionFile: "openclaw.jsonl", updatedAt: "2026-02-01T00:00:00.000Z" }] }),
      "utf8",
    );

    await setMtime(openclawFile, "2026-02-10T00:00:00.000Z");

    const result = await resolveAutoSession();

    expect(result.discoveredRoots.map((root) => root.platform).sort()).toEqual(["openclaw"]);
    expect(result.platform).toBe("openclaw");
    expect(result.activeFile).toBe(path.resolve(openclawFile));
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
