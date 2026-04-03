import type { EmbeddingPort, EpisodeDatabasePort, RecallPorts } from "../../../core/ports.js";
import type { Entry } from "../../../core/types.js";

/**
 * Narrow write surface used by recall eval fixture provisioning.
 */
export interface RecallEvalFixtureStore {
  /**
   * Inserts one exact fixture entry into isolated eval storage.
   *
   * @param entry - Canonical entry payload to store.
   * @param embedding - Precomputed embedding vector for the entry.
   * @param contentHash - Stable content hash for the seeded row.
   * @returns Persisted entry ID.
   */
  insertEntry(entry: Entry, embedding: number[], contentHash: string): Promise<string>;

  /**
   * Runs a callback inside a write transaction.
   *
   * @param fn - Callback that receives a transaction-scoped fixture store.
   * @returns Callback result after commit succeeds.
   */
  withTransaction<T>(fn: (store: RecallEvalFixtureStore) => Promise<T>): Promise<T>;
}

/**
 * Open isolated sandbox state for one recall eval case.
 */
export interface RecallEvalSandboxContext {
  /** Sandbox root directory used for the case execution. */
  root: string;
  /** SQLite database path used by the isolated sandbox. */
  dbPath: string;
  /** Whether the sandbox should remain on disk after cleanup. */
  preserved: boolean;
  /** Narrow fixture-seeding surface over the isolated database. */
  fixtureStore: RecallEvalFixtureStore;
  /** Episode database surface backed by the isolated sandbox database. */
  episodeDatabase: EpisodeDatabasePort;
  /**
   * Creates real recall ports against the isolated database.
   *
   * @param embedding - Shared embedding port used for query embeddings.
   * @returns Recall ports backed by the isolated sandbox database.
   */
  createRecallPorts(embedding: EmbeddingPort): RecallPorts;
  /**
   * Closes open resources and removes ephemeral sandbox state when needed.
   *
   * @returns Promise that resolves after cleanup finishes.
   */
  cleanup(): Promise<void>;
}
