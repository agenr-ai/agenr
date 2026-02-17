import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireDbLock, isDbLocked, lockPath, releaseDbLock } from "../../src/db/lockfile.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function makeLockDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agenr-lockfile-test-")).then((dir) => {
    tempDirs.push(dir);
    return dir;
  });
}

function mockProcessKill(isAlive: (pid: number) => boolean): () => void {
  const originalKill = process.kill;
  const killSpy = vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: NodeJS.Signals | number) => {
    if (!isAlive(pid)) {
      const error = new Error(`ESRCH: no such process, kill ${pid}`) as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    }

    return originalKill.call(process, pid, signal);
  });

  return () => {
    killSpy.mockRestore();
  };
}

describe("db lockfile", () => {
  it("acquireDbLock creates lock file with current pid", async () => {
    const lockDir = await makeLockDir();
    const pathToLock = lockPath(lockDir, "db");
    acquireDbLock(lockDir);

    const raw = await fs.readFile(pathToLock, "utf8");
    expect(raw.trim()).toBe(String(process.pid));
  });

  it("acquireDbLock throws when lock exists for live pid", async () => {
    const lockDir = await makeLockDir();
    acquireDbLock(lockDir);
    expect(() => acquireDbLock(lockDir)).toThrow(/Another agenr process/);
  });

  it("releaseDbLock removes lock file and is idempotent", async () => {
    const lockDir = await makeLockDir();
    const pathToLock = lockPath(lockDir, "db");
    acquireDbLock(lockDir);
    releaseDbLock(lockDir);
    releaseDbLock(lockDir);

    await expect(fs.stat(pathToLock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isDbLocked returns false when no lock exists", () => {
    expect(isDbLocked("/tmp/agenr-nonexistent-lock-dir")).toBe(false);
  });

  it("isDbLocked returns true when lock exists with live pid", async () => {
    const lockDir = await makeLockDir();
    acquireDbLock(lockDir);
    expect(isDbLocked(lockDir)).toBe(true);
  });

  it("isDbLocked returns false when lock exists with dead pid", async () => {
    const lockDir = await makeLockDir();
    const pathToLock = lockPath(lockDir, "db");
    const deadPid = 999_999;

    await fs.writeFile(pathToLock, String(deadPid), "utf8");
    const restoreKill = mockProcessKill((pid) => pid !== deadPid);

    try {
      expect(isDbLocked(lockDir)).toBe(false);
    } finally {
      restoreKill();
    }
  });

  it("handles stale lock replacement after EEXIST without crashing", async () => {
    const lockDir = await makeLockDir();
    const pathToLock = lockPath(lockDir, "db");
    const deadPid = 999_999;

    await fs.writeFile(pathToLock, String(deadPid), "utf8");
    const restoreKill = mockProcessKill((pid) => pid !== deadPid);

    try {
      acquireDbLock(lockDir);
      const raw = await fs.readFile(pathToLock, "utf8");
      expect(raw.trim()).toBe(String(process.pid));
    } finally {
      restoreKill();
    }
  });

  it("prevents TOCTOU races with atomic create checks", async () => {
    const lockDir = await makeLockDir();
    const settled = await Promise.allSettled([
      (() => { try { acquireDbLock(lockDir); return Promise.resolve(); } catch(e) { return Promise.reject(e); } })(),
      (() => { try { acquireDbLock(lockDir); return Promise.resolve(); } catch(e) { return Promise.reject(e); } })(),
    ]);

    const fulfilled = settled.filter((item) => item.status === "fulfilled");
    const rejected = settled.filter((item) => item.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
  });
});

