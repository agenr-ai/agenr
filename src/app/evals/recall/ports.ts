import type { EmbeddingPort, EpisodeDatabasePort, ProcedureDatabasePort, RecallPorts } from "../../../core/ports.js";
import type { Durable, Procedure } from "../../../core/types.js";
import type { SessionStartRepository } from "../../session-start/index.js";
import type { EvalProfileSnapshotFixture } from "../ablation-arm.js";
import type { RecallEvalSnapshotMetadata } from "./contracts.js";

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
  insertDurable(entry: Durable, embedding: number[], contentHash: string): Promise<string>;

  /**
   * Inserts one exact fixture procedure into isolated eval storage.
   *
   * @param procedure - Canonical procedure payload to store.
   * @returns Persisted procedure row.
   */
  insertProcedure(procedure: Procedure): Promise<Procedure>;

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
  /** Procedure database surface backed by the isolated sandbox database. */
  procedureDatabase: ProcedureDatabasePort;
  /** Feature-scoped repository for session-start selection against the sandbox. */
  sessionStartRepository: SessionStartRepository;
  /**
   * Lists active abstain directives in the sandbox at the supplied semantic clock.
   *
   * @param now - Optional reference time for validity filtering.
   * @returns Active directive durables.
   */
  listActiveAbstainDirectives(now?: Date): Promise<Durable[]>;
  /**
   * Lists active session-start proactive directives in the sandbox.
   *
   * @param now - Optional reference time for validity filtering.
   * @returns Active proactive directive durables.
   */
  listActiveSessionStartProactiveDirectives(now?: Date): Promise<Durable[]>;
  /**
   * Activates one profile snapshot fixture in the sandbox dream state.
   *
   * @param fixture - Profile snapshot fixture to seed.
   * @param provisionedAt - Default timestamp for omitted fixture fields.
   * @returns Activated profile snapshot id.
   */
  provisionProfileSnapshot(fixture: EvalProfileSnapshotFixture, provisionedAt: string): Promise<{ snapshotId: string }>;
  /**
   * Snapshot provenance metadata when the sandbox was seeded by copying
   * a corpus snapshot. Omitted for fixture-only sandboxes.
   */
  snapshot?: RecallEvalSnapshotMetadata;
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
