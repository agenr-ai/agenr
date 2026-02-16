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
    process.env = { ...originalEnv };
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

  it("acquireLock creates lock file with current pid", async () => {
    const mod = await loadLockModule();

    mod.acquireLock();
    const raw = await fs.readFile(mod.LOCK_PATH, "utf8");
    expect(raw.trim()).toBe(String(process.pid));
  });

  it("acquireLock throws when lock exists for live pid", async () => {
    const mod = await loadLockModule();
    await fs.mkdir(path.dirname(mod.LOCK_PATH), { recursive: true });
    await fs.writeFile(mod.LOCK_PATH, String(process.pid), "utf8");

    expect(() => mod.acquireLock()).toThrow(/Consolidation lock is held/);
  });

  it("acquireLock recovers stale lock and replaces it", async () => {
    const mod = await loadLockModule();
    await fs.mkdir(path.dirname(mod.LOCK_PATH), { recursive: true });
    await fs.writeFile(mod.LOCK_PATH, "999999", "utf8");

    mod.acquireLock();
    const raw = await fs.readFile(mod.LOCK_PATH, "utf8");
    expect(raw.trim()).toBe(String(process.pid));
  });

  it("releaseLock removes lock file and is no-throw if already removed", async () => {
    const mod = await loadLockModule();

    mod.releaseLock();
    mod.acquireLock();
    mod.releaseLock();
    mod.releaseLock();

    await expect(fs.stat(mod.LOCK_PATH)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isLocked returns true only for live lock pid", async () => {
    const mod = await loadLockModule();
    await fs.mkdir(path.dirname(mod.LOCK_PATH), { recursive: true });

    await fs.writeFile(mod.LOCK_PATH, String(process.pid), "utf8");
    expect(mod.isLocked()).toBe(true);

    await fs.writeFile(mod.LOCK_PATH, "999999", "utf8");
    expect(mod.isLocked()).toBe(false);
  });

  it("warnIfLocked logs warning when lock is active", async () => {
    const mod = await loadLockModule();
    await fs.mkdir(path.dirname(mod.LOCK_PATH), { recursive: true });
    await fs.writeFile(mod.LOCK_PATH, String(process.pid), "utf8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mod.warnIfLocked();
    expect(warnSpy).toHaveBeenCalledWith("Consolidation in progress. Writes may be delayed.");
  });
});
