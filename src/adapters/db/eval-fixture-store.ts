import type { RecallEvalFixtureStore } from "../../app/evals/recall/ports.js";
import type { TransactionalDatabasePort } from "./client.js";

/**
 * Creates the narrow fixture-seeding store used by recall eval sandboxes.
 *
 * @param database - Transactional database adapter for the isolated sandbox.
 * @returns Fixture store that hides DB adapter internals from the app layer.
 */
export function createRecallEvalFixtureStore(database: TransactionalDatabasePort): RecallEvalFixtureStore {
  return {
    insertEntry: async (entry, embedding, contentHash) => database.insertEntry(entry, embedding, contentHash),
    withTransaction: async <T>(fn: (store: RecallEvalFixtureStore) => Promise<T>) =>
      database.withTransaction(async (transaction) => fn(createRecallEvalFixtureStore(transaction))),
  };
}
