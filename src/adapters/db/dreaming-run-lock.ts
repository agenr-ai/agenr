import type { SqlExecutor } from "./queries.js";

/**
 * Age after which a held dreaming run lock is treated as stale and may be taken
 * over by a new run.
 *
 * The lock is not heartbeated: `updated_at` records the acquire time and is not
 * refreshed mid-run. This threshold is therefore deliberately set well above any
 * realistic run duration so that takeover only recovers locks orphaned by a
 * crashed or killed process, never a run that is still legitimately executing.
 */
const DREAMING_RUN_LOCK_STALE_MS = 60 * 60 * 1000;

export { DREAMING_RUN_LOCK_STALE_MS };

/**
 * Attempts to acquire the singleton dreaming run lock row in dream_state.
 *
 * Acquisition succeeds when the lock is unheld or when the current holder's row
 * is older than {@link DREAMING_RUN_LOCK_STALE_MS} (crash recovery). Unexpected
 * SQL errors propagate so callers can distinguish contention (no rows affected)
 * from a real failure such as a missing column.
 *
 * @param executor - SQL executor backing the target database.
 * @param holderToken - Unique token written when acquisition succeeds.
 * @param now - Current time used for the row timestamp and stale-lock cutoff.
 * @returns True when this caller now owns the lock.
 */
export async function tryAcquireDreamStateRunLock(executor: SqlExecutor, holderToken: string, now: Date): Promise<boolean> {
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - DREAMING_RUN_LOCK_STALE_MS).toISOString();
  await executor.execute("BEGIN IMMEDIATE");
  try {
    const result = await executor.execute({
      sql: `
        UPDATE dream_state
        SET run_lock_holder = ?, updated_at = ?
        WHERE id = 'default'
          AND (run_lock_holder IS NULL OR run_lock_holder = '' OR updated_at < ?)
      `,
      args: [holderToken, nowIso, staleBefore],
    });
    await executor.execute("COMMIT");
    return result.rowsAffected > 0;
  } catch (error) {
    await executor.execute("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/**
 * Releases the dreaming run lock when the holder token still matches.
 *
 * Unexpected SQL errors propagate after the transaction is rolled back so a
 * failed release is surfaced rather than silently leaving the lock held.
 *
 * @param executor - SQL executor backing the target database.
 * @param holderToken - Token previously returned by a successful acquire call.
 * @param now - Current time persisted when the lock row is cleared.
 */
export async function releaseDreamStateRunLock(executor: SqlExecutor, holderToken: string, now: Date): Promise<void> {
  await executor.execute("BEGIN IMMEDIATE");
  try {
    await executor.execute({
      sql: `
        UPDATE dream_state
        SET run_lock_holder = NULL, updated_at = ?
        WHERE id = 'default' AND run_lock_holder = ?
      `,
      args: [now.toISOString(), holderToken],
    });
    await executor.execute("COMMIT");
  } catch (error) {
    await executor.execute("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
