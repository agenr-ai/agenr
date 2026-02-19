import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfigDir } from "./state.js";

export interface WatcherHealth {
  pid: number;
  startedAt: string; // ISO timestamp
  lastHeartbeat: string; // ISO timestamp
  sessionsWatched: number;
  entriesStored: number;
}

const HEALTH_FILE = "watcher.health.json";
const HEALTH_STALE_MS = 5 * 60 * 1000; // 5 minutes

export function resolveHealthPath(configDir?: string): string {
  return path.join(resolveConfigDir(configDir), HEALTH_FILE);
}

export async function writeHealthFile(health: WatcherHealth, configDir?: string): Promise<void> {
  const healthPath = resolveHealthPath(configDir);
  await fs.mkdir(path.dirname(healthPath), { recursive: true });
  const tmpPath = `${healthPath}.${process.pid}.${Date.now()}.tmp`;
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(tmpPath, "w");
    await handle.writeFile(JSON.stringify(health, null, 2), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmpPath, healthPath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

function isWatcherHealth(value: unknown): value is WatcherHealth {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.pid === "number" &&
    typeof record.startedAt === "string" &&
    typeof record.lastHeartbeat === "string" &&
    typeof record.sessionsWatched === "number" &&
    typeof record.entriesStored === "number"
  );
}

export async function readHealthFile(configDir?: string): Promise<WatcherHealth | null> {
  try {
    const raw = await fs.readFile(resolveHealthPath(configDir), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isWatcherHealth(parsed)) {
      return null;
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function isHealthy(health: WatcherHealth, now?: Date): boolean {
  const ms = Date.parse(health.lastHeartbeat);
  if (Number.isNaN(ms)) {
    return false;
  }
  return (now ?? new Date()).getTime() - ms < HEALTH_STALE_MS;
}
