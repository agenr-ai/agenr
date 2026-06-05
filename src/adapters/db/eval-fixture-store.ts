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
    insertDurable: async (entry, embedding, contentHash) => database.insertDurable(entry, embedding, contentHash),
    insertProcedure: async (procedure) => database.upsertProcedure(procedure),
    withTransaction: async <T>(fn: (store: RecallEvalFixtureStore) => Promise<T>) =>
      database.withTransaction(async (transaction) => fn(createRecallEvalFixtureStore(transaction))),
  };
}
