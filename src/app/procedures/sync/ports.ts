import type { EmbeddingPort, ProcedureDatabasePort } from "../../../core/ports.js";

/**
 * Filesystem contract used by the procedure sync workflow.
 */
export interface ProcedureFilePort {
  /**
   * Discovers procedure YAML files from a target file or directory path.
   *
   * @param targetPath - File or directory to inspect for procedure files.
   * @param options - Optional discovery flags.
   * @returns Sorted absolute procedure file paths.
   */
  discoverFiles(targetPath: string, options?: { recursive?: boolean }): Promise<string[]>;

  /**
   * Reads the raw authored procedure source text.
   *
   * @param filePath - Absolute procedure file path.
   * @returns Raw UTF-8 procedure source text.
   */
  readFile(filePath: string): Promise<string>;
}

/**
 * Transaction-capable procedure database contract used by sync execution.
 */
export interface ProcedureSyncDatabasePort extends ProcedureDatabasePort {
  /**
   * Runs a callback inside one write transaction.
   *
   * @param fn - Callback executed with a transaction-scoped database adapter.
   * @returns Value returned by the callback after commit succeeds.
   */
  withTransaction<T>(fn: (db: ProcedureSyncDatabasePort) => Promise<T>): Promise<T>;
}

/**
 * Ports required by the procedure sync workflow.
 */
export interface ProcedureSyncPorts {
  /** Filesystem adapter used for discovery and source reads. */
  files: ProcedureFilePort;
  /** Database adapter used for active-key lookups and writes. */
  db: ProcedureSyncDatabasePort;
  /** Embedding adapter used for persisted procedure recall text. */
  embedding: EmbeddingPort;
}
