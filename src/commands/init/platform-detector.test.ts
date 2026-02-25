import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectPlatforms, isOnPath } from "./platform-detector.js";

const tempDirs: string[] = [];

async function createTempDir(prefix = "agenr-platform-detector-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("detectPlatforms", () => {
  it("detectPlatforms finds openclaw when config dir exists", async () => {
    const homeDir = await createTempDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    await fs.mkdir(path.join(homeDir, ".openclaw"), { recursive: true });

    const platforms = detectPlatforms(() => false);
    const openclaw = platforms.find((platform) => platform.id === "openclaw");
    expect(openclaw?.detected).toBe(true);
  });

  it("detectPlatforms finds codex when config dir exists", async () => {
    const homeDir = await createTempDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    await fs.mkdir(path.join(homeDir, ".codex"), { recursive: true });

    const platforms = detectPlatforms(() => false);
    const codex = platforms.find((platform) => platform.id === "codex");
    expect(codex?.detected).toBe(true);
  });

  it("detectPlatforms returns detected=false for missing dirs", async () => {
    const homeDir = await createTempDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    const platforms = detectPlatforms(() => false);
    expect(platforms.every((platform) => !platform.detected)).toBe(true);
  });

  it("detectPlatforms returns both openclaw and codex entries", async () => {
    const homeDir = await createTempDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    const platforms = detectPlatforms(() => false);
    expect(platforms).toHaveLength(2);
    expect(platforms.map((platform) => platform.id)).toEqual(["openclaw", "codex"]);
  });
});

describe("isOnPath", () => {
  it("isOnPath returns true for node", () => {
    expect(isOnPath("node")).toBe(true);
  });

  it("isOnPath returns false for nonexistent command", () => {
    expect(isOnPath("definitely-not-a-real-command-agenr")).toBe(false);
  });
});
