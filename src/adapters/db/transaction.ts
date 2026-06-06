import type { SqlExecutor } from "./queries.js";

/**
 * Runs a callback inside a single `BEGIN IMMEDIATE` write transaction.
 *
 * Every statement runs on the supplied executor, which keeps the transaction
 * correct for in-memory databases whose schema is per-connection. The
 * transaction commits on success and best-effort rolls back on failure; a
 * failed statement may have already aborted the transaction, so rollback
 * errors are ignored.
 *
 * @param executor - SQL executor or libSQL client backing the transaction.
 * @param fn - Callback that performs writes inside the open transaction.
 * @returns Callback result after the transaction commits.
 */
export async function runImmediateTransaction<T>(executor: SqlExecutor, fn: () => Promise<T>): Promise<T> {
  await executor.execute("BEGIN IMMEDIATE");
  try {
    const result = await fn();
    await executor.execute("COMMIT");
    return result;
  } catch (error) {
    try {
      await executor.execute("ROLLBACK");
    } catch {
      // A failed statement may have already aborted the transaction; nothing to roll back.
    }
    throw error;
  }
}
