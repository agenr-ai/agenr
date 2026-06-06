import type { ClaimSlotPolicy } from "../../core/claim-slot-policy.js";
import type { Durable } from "../../core/types.js";

/**
 * Recent recall event metadata returned by memory trace surfaces.
 */
export interface EntryRecallEvent {
  query?: string;
  sessionKey?: string;
  recalledAt: string;
}

/**
 * Recall summary returned by the trace read model.
 */
export interface EntryTraceRecallSummary {
  /** Total persisted recall events for the durable. */
  totalCount: number;
  /** Most recent recall events, ordered newest first. */
  recentEvents: EntryRecallEvent[];
}

/**
 * Dreaming audit action linked to one traced durable.
 */
export interface EntryTraceDreamAction {
  id: string;
  runId: string;
  actionType: string;
  reasoning: string;
  details?: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * Profile snapshot that included one traced durable.
 */
export interface EntryTraceProfileSnapshot {
  id: string;
  asOf: string;
  runId: string | null;
  createdAt: string;
  role: "profile" | "directive";
}

/**
 * Provenance facts surfaced by the trace read model.
 */
export interface EntryTraceProvenance {
  sourceFile?: string;
  sourceContext?: string;
  claimKeySource?: string;
  claimSupportLocator?: string;
  claimSupportObservedAt?: string;
  project?: string;
  userId?: string;
}

/**
 * One chronological audit event in a durable trace timeline.
 */
export interface EntryTraceTimelineEvent {
  at: string;
  kind: "created" | "updated" | "dream" | "recall" | "profile";
  label: string;
  detail?: string;
  runId?: string;
  actionType?: string;
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
  entries: Durable[];
}

/**
 * Unified provenance and audit view for one durable.
 */
export interface EntryTrace {
  entry: Durable;
  supersededBy?: Durable;
  supersedes: Durable[];
  claimFamily?: ClaimFamily;
  recall: EntryTraceRecallSummary;
  provenance: EntryTraceProvenance;
  dreamActions: EntryTraceDreamAction[];
  profileSnapshots: EntryTraceProfileSnapshot[];
  timeline: EntryTraceTimelineEvent[];
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
  findEntryBySubject(subject: string): Promise<Durable | null>;

  /**
   * Finds the most recently created entry from any state.
   *
   * @returns Newest entry, or `null` when none exist.
   */
  findMostRecentEntry(): Promise<Durable | null>;

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
