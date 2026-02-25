import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectPlatforms,
  isDefaultOpenClawPath,
  isOnPath,
  resolveDefaultCodexConfigDir,
  resolveDefaultOpenClawConfigDir,
} from "./platform-detector.js";

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

  it("OpenClaw platform sessionsDir includes agents/main/sessions", async () => {
    const homeDir = await createTempDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    const platforms = detectPlatforms(() => false);
    const openclaw = platforms.find((platform) => platform.id === "openclaw");

    expect(openclaw?.sessionsDir).toBe(path.join(homeDir, ".openclaw", "agents", "main", "sessions"));
  });
});

describe("isOnPath", () => {
  it("isOnPath returns true for sh (POSIX-guaranteed)", () => {
    if (process.platform === "win32") return;
    expect(isOnPath("sh")).toBe(true);
  });

  it("isOnPath returns false for nonexistent command", () => {
    expect(isOnPath("definitely-not-a-real-command-agenr")).toBe(false);
  });
});

describe("default path helpers", () => {
  it("resolveDefaultOpenClawConfigDir resolves from home directory", async () => {
    const homeDir = await createTempDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    expect(resolveDefaultOpenClawConfigDir()).toBe(path.join(homeDir, ".openclaw"));
  });

  it("resolveDefaultCodexConfigDir resolves from home directory", async () => {
    const homeDir = await createTempDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    expect(resolveDefaultCodexConfigDir()).toBe(path.join(homeDir, ".codex"));
  });

  it("isDefaultOpenClawPath returns true for default path", async () => {
    const homeDir = await createTempDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    expect(isDefaultOpenClawPath(path.join(homeDir, ".openclaw"))).toBe(true);
  });

  it("isDefaultOpenClawPath returns false for custom path", async () => {
    const homeDir = await createTempDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    expect(isDefaultOpenClawPath(path.join(homeDir, ".openclaw-sandbox"))).toBe(false);
  });
});
