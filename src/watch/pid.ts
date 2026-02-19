import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfigDir } from "./state.js";

const WATCHER_PID_FILE = "watcher.pid";

export function resolveWatcherPidPath(configDir?: string): string {
  return path.join(resolveConfigDir(configDir), WATCHER_PID_FILE);
}

export async function writeWatcherPid(configDir?: string): Promise<void> {
  const pidPath = resolveWatcherPidPath(configDir);
  await fs.mkdir(path.dirname(pidPath), { recursive: true });
  await fs.writeFile(pidPath, String(process.pid), "utf8");
}

export async function deleteWatcherPid(configDir?: string): Promise<void> {
  try {
    await fs.unlink(resolveWatcherPidPath(configDir));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function readWatcherPid(configDir?: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(resolveWatcherPidPath(configDir), "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

// process.kill(pid, 0) does not send a signal - it tests if the process exists.
// ESRCH means dead; EPERM means alive but not owned by this user.
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

export async function isWatcherRunning(configDir?: string): Promise<boolean> {
  const pid = await readWatcherPid(configDir);
  if (pid === null) {
    return false;
  }
  return isProcessAlive(pid);
}
