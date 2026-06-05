import { randomUUID } from "node:crypto";

import type { DreamPort } from "./ports.js";

const DREAMING_RUN_LEASE_BRAND: unique symbol = Symbol("DreamingRunLease");

/** Lease proving that this process currently owns the dreaming coordination lock. */
export interface DreamingRunLease {
  readonly token: string;
  readonly [DREAMING_RUN_LEASE_BRAND]: true;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
}

const inProcessRunLocks = new Map<string, string>();
const episodeWriteRefcounts = new Map<string, number>();
const DEFAULT_LOCK_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 60 * 1000;
const DEFAULT_LOCK_WAIT_POLL_MS = 500;

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
 * @returns Lock lease when successful, otherwise null.
 */
export async function tryAcquireDreamingRunLock(port: DreamPort, dbPath?: string): Promise<DreamingRunLease | null> {
  const lockKey = resolveDreamingLockKey(dbPath);
  if (inProcessRunLocks.has(lockKey)) {
    return null;
  }

  const token = randomUUID();
  const acquired = await port.tryAcquireRunLock(token);
  if (!acquired) {
    return null;
  }

  inProcessRunLocks.set(lockKey, token);
  return createDreamingRunLease(port, lockKey, token);
}

/**
 * Runs a callback while holding a newly acquired dreaming run lock.
 *
 * @param port - Dreaming persistence port used for the SQLite lock row.
 * @param dbPath - Optional database path used for in-process coordination.
 * @param fn - Callback executed while the lock is held.
 * @returns Callback result after the lock is released.
 */
export async function withDreamingRunLock<T>(port: DreamPort, dbPath: string | undefined, fn: (lease: DreamingRunLease) => Promise<T>): Promise<T> {
  const lease = await tryAcquireDreamingRunLock(port, dbPath);
  if (!lease) {
    throw new Error("Dreaming run already in progress.");
  }

  return withHeldDreamingRunLock(lease, fn);
}

/**
 * Runs a callback while holding an already acquired dreaming run lock.
 *
 * @param lease - Lease returned by {@link tryAcquireDreamingRunLock}.
 * @param fn - Callback executed while the lock is held.
 * @returns Callback result after the lock is released.
 */
export async function withHeldDreamingRunLock<T>(lease: DreamingRunLease, fn: (lease: DreamingRunLease) => Promise<T>): Promise<T> {
  let callbackError: unknown;
  let result: T | undefined;
  const stopHeartbeat = startDreamingRunLockHeartbeat(lease);
  try {
    await lease.heartbeat();
    result = await fn(lease);
  } catch (error) {
    callbackError = error;
  }

  let cleanupError: unknown;
  try {
    await stopHeartbeat();
  } catch (error) {
    cleanupError = error;
  }
  try {
    await lease.release();
  } catch (error) {
    if (cleanupError === undefined) {
      cleanupError = error;
    }
  }

  if (callbackError !== undefined) {
    throw callbackError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
  return result as T;
}

/**
 * Waits for and holds the dreaming lock while an episode write runs.
 *
 * @param input - Lock dependencies and optional wait tuning.
 * @param fn - Episode-write callback.
 * @returns Callback result after the guard and lock are released.
 */
export async function withEpisodeWriteGuard<T>(
  input: {
    port: DreamPort;
    dbPath: string;
    waitTimeoutMs?: number;
    waitPollMs?: number;
  },
  fn: () => Promise<T>,
): Promise<T> {
  beginEpisodeWrite(input.dbPath);
  try {
    const lease = await waitForDreamingRunLock(input.port, input.dbPath, {
      timeoutMs: input.waitTimeoutMs,
      pollMs: input.waitPollMs,
    });
    return await withHeldDreamingRunLock(lease, async () => fn());
  } finally {
    endEpisodeWrite(input.dbPath);
  }
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

/** Clears in-process dreaming concurrency state. Intended for tests only. */
export function resetDreamingConcurrencyStateForTests(): void {
  inProcessRunLocks.clear();
  episodeWriteRefcounts.clear();
}

/** Creates a lease object tied to one in-process lock key and holder token. */
function createDreamingRunLease(port: DreamPort, lockKey: string, token: string): DreamingRunLease {
  let released = false;
  return {
    token,
    [DREAMING_RUN_LEASE_BRAND]: true,
    async heartbeat() {
      if (released) {
        return;
      }
      if (inProcessRunLocks.get(lockKey) !== token) {
        throw new Error("Dreaming run lock was lost in this process.");
      }
      const retained = await port.heartbeatRunLock(token);
      if (!retained) {
        throw new Error("Dreaming run lock was lost.");
      }
    },
    async release() {
      if (released) {
        return;
      }
      released = true;
      if (inProcessRunLocks.get(lockKey) === token) {
        inProcessRunLocks.delete(lockKey);
      }
      await port.releaseRunLock(token);
    },
  };
}

/** Starts periodic lock heartbeats and returns a cleanup callback. */
function startDreamingRunLockHeartbeat(lease: DreamingRunLease): () => Promise<void> {
  let heartbeatError: unknown;
  let pendingHeartbeat: Promise<void> | null = null;
  const timer = setInterval(() => {
    pendingHeartbeat = lease.heartbeat().catch((error: unknown) => {
      heartbeatError = error;
    });
  }, DEFAULT_LOCK_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  return async () => {
    clearInterval(timer);
    if (pendingHeartbeat) {
      await pendingHeartbeat;
    }
    if (heartbeatError !== undefined) {
      throw heartbeatError;
    }
  };
}

/** Waits until the dreaming coordination lock can be acquired or times out. */
async function waitForDreamingRunLock(port: DreamPort, dbPath: string, options: { timeoutMs?: number; pollMs?: number }): Promise<DreamingRunLease> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_LOCK_WAIT_POLL_MS;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const lease = await tryAcquireDreamingRunLock(port, dbPath);
    if (lease) {
      return lease;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for dreaming run lock before episode write.");
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

/** Sleeps for a short polling delay. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
