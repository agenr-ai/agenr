import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("consolidate lock", () => {
  const originalEnv = { ...process.env };
  const tempDirs: string[] = [];

  const resetModules = () => {
    if (typeof vi.resetModules === "function") {
      vi.resetModules();
    }
  };

  afterEach(async () => {
    // Restore env on the original proxy (not replace it) so setenv() is called
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
    vi.restoreAllMocks();
    resetModules();
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  async function loadLockModule() {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-lock-home-"));
    tempDirs.push(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    resetModules();
    return import("../src/consolidate/lock.js");
  }

  function lockPathFromHome(home: string): string {
    return path.join(home, ".agenr", "db.lock");
  }

  it("acquireLock creates lock file with current pid", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-lock-home-"));
    tempDirs.push(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const mod = await import("../src/consolidate/lock.js");
    mod.acquireLock();

    const raw = await fs.readFile(lockPathFromHome(home), "utf8");
    expect(raw.trim()).toBe(String(process.pid));
    mod.releaseLock();
  });

  it("acquireLock throws when lock exists for live pid", async () => {
    const mod = await loadLockModule();
    const lockPath = lockPathFromHome(process.env.HOME || "");
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, String(process.pid), "utf8");

    expect(() => mod.acquireLock()).toThrow(/Another agenr process/);
  });

  it("releaseLock removes lock file and is no-throw if already removed", async () => {
    const mod = await loadLockModule();
    const lockPath = lockPathFromHome(process.env.HOME || "");

    mod.acquireLock();
    mod.releaseLock();
    mod.releaseLock();

    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("warnIfLocked logs warning when lock is active", async () => {
    const mod = await loadLockModule();
    const lockPath = lockPathFromHome(process.env.HOME || "");
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, String(process.pid), "utf8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mod.warnIfLocked();
    expect(warnSpy).toHaveBeenCalledWith(
      "Another agenr process is writing to the database. Writes may be delayed.",
    );
  });
});
