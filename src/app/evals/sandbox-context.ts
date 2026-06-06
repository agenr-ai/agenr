import type { EvalDreamRunStore } from "./dream-run-fixture.js";

/** Common isolated sandbox state shared by internal eval seams. */
export interface EvalSandboxBaseContext {
  /** Sandbox root directory used for the case execution. */
  root: string;
  /** SQLite database path used by the isolated sandbox. */
  dbPath: string;
  /** Whether the sandbox should remain on disk after cleanup. */
  preserved: boolean;
  /** Dream-run fixture store backed by the isolated sandbox database. */
  dreamRunStore: EvalDreamRunStore;
  /**
   * Closes open resources and removes ephemeral sandbox state when needed.
   *
   * @returns Promise that resolves after cleanup finishes.
   */
  cleanup(): Promise<void>;
}
