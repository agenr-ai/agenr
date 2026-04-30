import type { ClaimSlotPolicy } from "../../core/claim-slot-policy.js";
import type { Entry } from "../../core/types.js";

/**
 * Recent recall event metadata returned by memory trace surfaces.
 */
export interface EntryRecallEvent {
  query?: string;
  sessionKey?: string;
  recalledAt: string;
}

/**
 * Narrow claim-family lineage view returned by trace surfaces.
 */
export interface ClaimFamily {
  /** Shared claim key for the family. */
  claimKey: string;
  /** Runtime slot-policy used when reading this lineage. */
  slotPolicy: ClaimSlotPolicy;
  /** Human-readable explanation of how the slot policy was chosen. */
  slotPolicyReason?: string;
  /** Family rows ordered oldest-first for lineage inspection. */
  entries: Entry[];
}

/**
 * Minimal provenance view available from the current v1 schema.
 */
export interface EntryTrace {
  entry: Entry;
  supersededBy?: Entry;
  supersedes: Entry[];
  claimFamily?: ClaimFamily;
  recallEvents: EntryRecallEvent[];
}

/**
 * Aggregate memory status facts used by host memory runtimes.
 */
export interface MemoryStatusSnapshot {
  activeEntries: number;
  coreEntries: number;
  sourceFiles: number;
}

/**
 * Host-neutral memory read model used by prompt injection, trace, and status flows.
 */
export interface MemoryRepository {
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
  getEntryTrace(entryId: string): Promise<EntryTrace | null>;

  /**
   * Reads aggregate counts for host status surfaces.
   *
   * @returns Current memory status snapshot.
   */
  getMemoryStatusSnapshot(): Promise<MemoryStatusSnapshot>;

  /**
   * Checks whether the configured vector index is available.
   *
   * @returns `true` when vector search is usable.
   */
  probeVectorAvailability(): Promise<boolean>;
}
