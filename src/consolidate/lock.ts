import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOCK_PATH = path.join(os.homedir(), ".agenr", "consolidation.lock");

function ensureLockDir(): void {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
}

function readLockPid(): number | null {
  try {
    const raw = fs.readFileSync(LOCK_PATH, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    return true;
  }
}

export function acquireLock(): void {
  ensureLockDir();

  if (fs.existsSync(LOCK_PATH)) {
    const pid = readLockPid();
    if (pid && isPidAlive(pid)) {
      throw new Error(`Consolidation lock is held by PID ${pid}.`);
    }

    try {
      fs.unlinkSync(LOCK_PATH);
    } catch {
      // Ignore stale lock cleanup errors; write attempt below will fail if needed.
    }
  }

  fs.writeFileSync(LOCK_PATH, String(process.pid), "utf8");
}

export function releaseLock(): void {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {
    // No-op when lock file is already gone.
  }
}

export function isLocked(): boolean {
  if (!fs.existsSync(LOCK_PATH)) {
    return false;
  }

  const pid = readLockPid();
  if (!pid) {
    return false;
  }

  return isPidAlive(pid);
}

export function warnIfLocked(): void {
  if (!isLocked()) {
    return;
  }

  console.warn("Consolidation in progress. Writes may be delayed.");
}
