import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultLockDir(): string {
  return path.join(os.homedir(), ".agenr");
}

export function lockPath(lockDir: string, name: string): string {
  return path.join(lockDir, `${name}.lock`);
}

function readLockPid(filePath: string): number | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
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
    return code !== "ESRCH";
  }
}

export function acquireDbLock(lockDir?: string): void {
  const resolvedLockDir = lockDir ?? defaultLockDir();
  fs.mkdirSync(resolvedLockDir, { recursive: true });
  const filePath = lockPath(resolvedLockDir, "db");

  try {
    fs.writeFileSync(filePath, String(process.pid), { flag: "wx" });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  const pid = readLockPid(filePath);
  if (pid && isPidAlive(pid)) {
    throw new Error(`Another agenr process (PID ${pid}) is using this database. Wait for it to finish or kill it.`);
  }

  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore cleanup failures; the retry below handles any remaining contention.
  }

  fs.writeFileSync(filePath, String(process.pid), { flag: "wx" });
}

export function releaseDbLock(lockDir?: string): void {
  const resolvedLockDir = lockDir ?? defaultLockDir();
  try {
    fs.unlinkSync(lockPath(resolvedLockDir, "db"));
  } catch {
    // Idempotent release.
  }
}

export function isDbLocked(lockDir?: string): boolean {
  const resolvedLockDir = lockDir ?? defaultLockDir();
  const filePath = lockPath(resolvedLockDir, "db");
  const pid = readLockPid(filePath);
  if (!pid) {
    return false;
  }
  return isPidAlive(pid);
}
