import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteWatcherPid,
  isProcessAlive,
  isWatcherRunning,
  readWatcherPid,
  resolveWatcherPidPath,
  writeWatcherPid,
} from "../../src/watch/pid.js";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-watch-pid-test-"));
  tempDirs.push(dir);
  return dir;
}

function useTempHome(dir: string): void {
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
  vi.restoreAllMocks();
});

describe("watch pid", () => {
  it("writeWatcherPid and readWatcherPid round-trip", async () => {
    useTempHome(await makeTempDir());
    await writeWatcherPid();
    await expect(readWatcherPid()).resolves.toBe(process.pid);
  });

  it("writeWatcherPid overwrites an existing stale PID file", async () => {
    useTempHome(await makeTempDir());
    const pidPath = resolveWatcherPidPath();
    await fs.mkdir(path.dirname(pidPath), { recursive: true });
    await fs.writeFile(pidPath, "999999999", "utf8");

    await writeWatcherPid();

    const raw = await fs.readFile(pidPath, "utf8");
    expect(raw.trim()).toBe(String(process.pid));
  });

  it("deleteWatcherPid removes file", async () => {
    useTempHome(await makeTempDir());
    await writeWatcherPid();
    await deleteWatcherPid();
    await expect(readWatcherPid()).resolves.toBeNull();
  });

  it("deleteWatcherPid on missing file is silent", async () => {
    useTempHome(await makeTempDir());
    await expect(deleteWatcherPid()).resolves.toBeUndefined();
  });

  it("readWatcherPid on missing file returns null", async () => {
    useTempHome(await makeTempDir());
    await expect(readWatcherPid()).resolves.toBeNull();
  });

  it("isProcessAlive current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("isProcessAlive nonexistent PID", () => {
    expect(isProcessAlive(999999999)).toBe(false);
  });

  it("isWatcherRunning no file", async () => {
    useTempHome(await makeTempDir());
    await expect(isWatcherRunning()).resolves.toBe(false);
  });

  it("isWatcherRunning stale PID (dead process)", async () => {
    useTempHome(await makeTempDir());
    const pidPath = resolveWatcherPidPath();
    await fs.mkdir(path.dirname(pidPath), { recursive: true });
    await fs.writeFile(pidPath, "999999999", "utf8");

    await expect(isWatcherRunning()).resolves.toBe(false);
  });

  it("isWatcherRunning live PID (current process)", async () => {
    useTempHome(await makeTempDir());
    const pidPath = resolveWatcherPidPath();
    await fs.mkdir(path.dirname(pidPath), { recursive: true });
    await fs.writeFile(pidPath, String(process.pid), "utf8");

    await expect(isWatcherRunning()).resolves.toBe(true);
  });
});
