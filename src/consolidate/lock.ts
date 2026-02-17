import { acquireDbLock, isDbLocked, releaseDbLock } from "../db/lockfile.js";

export function acquireLock(): void {
  acquireDbLock();
}

export function releaseLock(): void {
  releaseDbLock();
}

export function isLocked(): boolean {
  return isDbLocked();
}

export function warnIfLocked(): void {
  if (!isLocked()) {
    return;
  }

  console.warn("Another agenr process is writing to the database. Writes may be delayed.");
}
