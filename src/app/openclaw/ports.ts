import type { Entry } from "../../core/types.js";

/**
 * Recent recall event metadata returned by the OpenClaw trace tool.
 */
export interface OpenClawRecallEvent {
  query?: string;
  sessionKey?: string;
  recalledAt: string;
}

/**
 * Narrow claim-family lineage view returned by trace surfaces.
 */
export interface OpenClawClaimFamily {
  /** Shared claim key for the family. */
  claimKey: string;
  /** Family rows ordered oldest-first for lineage inspection. */
  entries: Entry[];
}

/**
 * Minimal provenance view available from the current v1 schema.
 */
export interface OpenClawEntryTrace {
  entry: Entry;
  supersededBy?: Entry;
  supersedes: Entry[];
  claimFamily?: OpenClawClaimFamily;
  recallEvents: OpenClawRecallEvent[];
}

/**
 * Aggregate memory status facts used by the OpenClaw memory runtime.
 */
export interface OpenClawMemoryStatusSnapshot {
  activeEntries: number;
  coreEntries: number;
  sourceFiles: number;
}

/**
 * OpenClaw-specific read model used by prompt injection, trace, and status flows.
 */
export interface OpenClawRepository {
  /**
   * Lists active core entries for session-start prompt injection.
   *
   * @param limit - Maximum number of entries to return.
   * @returns Core entries ordered for prompt use.
   */
  listCoreEntries(limit: number): Promise<Entry[]>;

  /**
   * Finds the most recent entry matching a subject string.
   *
   * @param subject - Free-form subject text to resolve.
   * @returns Matching entry, or `null` when no match exists.
   */
  findEntryBySubject(subject: string): Promise<Entry | null>;

  /**
   * Finds the most recently created entry from any state.
   *
   * @returns Newest entry, or `null` when none exist.
   */
  findMostRecentEntry(): Promise<Entry | null>;

  /**
   * Loads the current trace view for one entry.
   *
   * @param entryId - Entry identifier to inspect.
   * @returns Trace payload, or `null` when the entry is missing.
   */
  getEntryTrace(entryId: string): Promise<OpenClawEntryTrace | null>;

  /**
   * Reads aggregate counts for the OpenClaw status surface.
   *
   * @returns Current memory status snapshot.
   */
  getMemoryStatusSnapshot(): Promise<OpenClawMemoryStatusSnapshot>;

  /**
   * Checks whether the configured vector index is available.
   *
   * @returns `true` when vector search is usable.
   */
  probeVectorAvailability(): Promise<boolean>;
}
