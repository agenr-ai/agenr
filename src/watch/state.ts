import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WatchFileState, WatchState } from "../types.js";

const WATCH_STATE_FILE = "watch-state.json";
const CONFIG_DIR_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;

function resolveConfigDir(configDir?: string): string {
  if (configDir && configDir.trim().length > 0) {
    return configDir;
  }
  return path.join(os.homedir(), ".agenr");
}

function resolveStatePath(configDir?: string): string {
  return path.join(resolveConfigDir(configDir), WATCH_STATE_FILE);
}

function createDefaultFileState(filePath: string): WatchFileState {
  return {
    filePath,
    byteOffset: 0,
    lastRunAt: new Date(0).toISOString(),
    totalEntriesStored: 0,
    totalRunCount: 0,
  };
}

function toFiniteNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return fallback;
}

function sanitizeFileState(filePath: string, value: unknown): WatchFileState {
  if (!value || typeof value !== "object") {
    return createDefaultFileState(filePath);
  }

  const record = value as Record<string, unknown>;
  const fallback = createDefaultFileState(filePath);
  const lastRunAt =
    typeof record.lastRunAt === "string" && record.lastRunAt.trim().length > 0
      ? record.lastRunAt
      : fallback.lastRunAt;

  return {
    filePath,
    byteOffset: toFiniteNonNegativeInt(record.byteOffset, fallback.byteOffset),
    lastRunAt,
    totalEntriesStored: toFiniteNonNegativeInt(record.totalEntriesStored, fallback.totalEntriesStored),
    totalRunCount: toFiniteNonNegativeInt(record.totalRunCount, fallback.totalRunCount),
  };
}

export function createEmptyWatchState(): WatchState {
  return {
    version: 1,
    files: {},
  };
}

export async function loadWatchState(configDir?: string): Promise<WatchState> {
  const statePath = resolveStatePath(configDir);

  let raw: string;
  try {
    raw = await fs.readFile(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createEmptyWatchState();
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to parse watch state at ${statePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid watch state at ${statePath}: expected an object.`);
  }

  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error(`Invalid watch state at ${statePath}: expected version 1.`);
  }

  if (!record.files || typeof record.files !== "object") {
    throw new Error(`Invalid watch state at ${statePath}: expected files map.`);
  }

  const filesRecord = record.files as Record<string, unknown>;
  const state: WatchState = createEmptyWatchState();

  for (const [rawKey, value] of Object.entries(filesRecord)) {
    const resolvedPath = path.resolve(rawKey);
    state.files[resolvedPath] = sanitizeFileState(resolvedPath, value);
  }

  return state;
}

export async function saveWatchState(state: WatchState, configDir?: string): Promise<void> {
  const dir = resolveConfigDir(configDir);
  const statePath = resolveStatePath(configDir);
  await fs.mkdir(dir, { recursive: true, mode: CONFIG_DIR_MODE });

  try {
    await fs.chmod(dir, CONFIG_DIR_MODE);
  } catch {
    // Best-effort permission hardening.
  }

  const normalized: WatchState = createEmptyWatchState();
  for (const [filePath, fileState] of Object.entries(state.files)) {
    const resolvedPath = path.resolve(filePath);
    normalized.files[resolvedPath] = sanitizeFileState(resolvedPath, fileState);
  }

  const tmpPath = `${statePath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: "utf8",
    mode: CONFIG_FILE_MODE,
  });
  await fs.rename(tmpPath, statePath);

  try {
    await fs.chmod(statePath, CONFIG_FILE_MODE);
  } catch {
    // Best-effort permission hardening.
  }
}

export function getFileState(state: WatchState, filePath: string): WatchFileState | undefined {
  return state.files[path.resolve(filePath)];
}

export function updateFileState(state: WatchState, filePath: string, update: Partial<WatchFileState>): void {
  const resolvedPath = path.resolve(filePath);
  const current = state.files[resolvedPath] ?? createDefaultFileState(resolvedPath);

  state.files[resolvedPath] = {
    filePath: resolvedPath,
    byteOffset: update.byteOffset ?? current.byteOffset,
    lastRunAt: update.lastRunAt ?? current.lastRunAt,
    totalEntriesStored: update.totalEntriesStored ?? current.totalEntriesStored,
    totalRunCount: update.totalRunCount ?? current.totalRunCount,
  };
}
