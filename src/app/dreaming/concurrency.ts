import { randomUUID } from "node:crypto";

import type { DreamPort } from "./ports.js";

/** Result returned when a dreaming run lock acquisition is attempted. */
export interface DreamingRunLockAcquisition {
  acquired: boolean;
  token: string | null;
}

const inProcessRunLocks = new Map<string, string>();
const episodeWriteRefcounts = new Map<string, number>();

/**
 * Resolves the process-wide lock key for one database.
 *
 * @param dbPath - Optional database path; in-memory databases share one key.
 * @returns Stable lock key for in-process coordination.
 */
export function resolveDreamingLockKey(dbPath?: string): string {
  const trimmed = dbPath?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : ":memory:";
}

/**
 * Attempts to acquire the process-wide dreaming run lock for one database.
 *
 * @param port - Dreaming persistence port used for the SQLite lock row.
 * @param dbPath - Optional database path used for in-process coordination.
 * @returns Acquisition result with the holder token when successful.
 */
export async function tryAcquireDreamingRunLock(port: DreamPort, dbPath?: string): Promise<DreamingRunLockAcquisition> {
  const lockKey = resolveDreamingLockKey(dbPath);
  if (inProcessRunLocks.has(lockKey)) {
    return { acquired: false, token: null };
  }

  const token = randomUUID();
  const acquired = await port.tryAcquireRunLock(token);
  if (!acquired) {
    return { acquired: false, token: null };
  }

  inProcessRunLocks.set(lockKey, token);
  return { acquired: true, token };
}

/**
 * Releases a previously acquired dreaming run lock.
 *
 * @param port - Dreaming persistence port used for the SQLite lock row.
 * @param dbPath - Optional database path used for in-process coordination.
 * @param token - Holder token returned by a successful acquire call.
 */
export async function releaseDreamingRunLock(port: DreamPort, dbPath: string | undefined, token: string): Promise<void> {
  const lockKey = resolveDreamingLockKey(dbPath);
  if (inProcessRunLocks.get(lockKey) === token) {
    inProcessRunLocks.delete(lockKey);
  }
  await port.releaseRunLock(token);
}

/**
 * Marks the start of an in-process episode write for one database.
 *
 * @param dbPath - Database path whose episode write guard should increment.
 */
export function beginEpisodeWrite(dbPath: string): void {
  const lockKey = resolveDreamingLockKey(dbPath);
  episodeWriteRefcounts.set(lockKey, (episodeWriteRefcounts.get(lockKey) ?? 0) + 1);
}

/**
 * Marks the end of an in-process episode write for one database.
 *
 * @param dbPath - Database path whose episode write guard should decrement.
 */
export function endEpisodeWrite(dbPath: string): void {
  const lockKey = resolveDreamingLockKey(dbPath);
  const next = (episodeWriteRefcounts.get(lockKey) ?? 0) - 1;
  if (next <= 0) {
    episodeWriteRefcounts.delete(lockKey);
    return;
  }
  episodeWriteRefcounts.set(lockKey, next);
}

/**
 * Returns whether an episode write is currently in progress for one database.
 *
 * @param dbPath - Optional database path to inspect.
 * @returns True when a host episode write guard is active in this process.
 */
export function isEpisodeWriteInProgress(dbPath?: string): boolean {
  return (episodeWriteRefcounts.get(resolveDreamingLockKey(dbPath)) ?? 0) > 0;
}

/**
 * Runs a callback while holding the in-process episode write guard.
 *
 * @param dbPath - Database path whose episode write guard should be held.
 * @param fn - Callback executed while the guard is active.
 * @returns Callback result after the guard is released.
 */
export async function withEpisodeWriteGuard<T>(dbPath: string, fn: () => Promise<T>): Promise<T> {
  beginEpisodeWrite(dbPath);
  try {
    return await fn();
  } finally {
    endEpisodeWrite(dbPath);
  }
}

/** Clears in-process dreaming concurrency state. Intended for tests only. */
export function resetDreamingConcurrencyStateForTests(): void {
  inProcessRunLocks.clear();
  episodeWriteRefcounts.clear();
}
