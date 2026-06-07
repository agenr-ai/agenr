import type { ClaimSlotPolicy } from "../../core/claim-slot-policy.js";
import type { Durable } from "../../core/types.js";

/**
 * Recent recall event metadata returned by memory trace surfaces.
 */
export interface DurableRecallEvent {
  query?: string;
  sessionKey?: string;
  recalledAt: string;
}

/**
 * Recall summary returned by the trace read model.
 */
export interface DurableTraceRecallSummary {
  /** Total persisted recall events for the durable. */
  totalCount: number;
  /** Most recent recall events, ordered newest first. */
  recentEvents: DurableRecallEvent[];
}

/**
 * Dreaming audit action linked to one traced durable.
 */
export interface DurableTraceDreamAction {
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
export interface DurableTraceProfileSnapshot {
  id: string;
  asOf: string;
  runId: string | null;
  createdAt: string;
  role: "profile" | "directive";
}

/**
 * Provenance facts surfaced by the trace read model.
 */
export interface DurableTraceProvenance {
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
export interface DurableTraceTimelineEvent {
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
  durables: Durable[];
}

/**
 * Unified provenance and audit view for one durable.
 */
export interface DurableTrace {
  durable: Durable;
  supersededBy?: Durable;
  supersedes: Durable[];
  claimFamily?: ClaimFamily;
  recall: DurableTraceRecallSummary;
  provenance: DurableTraceProvenance;
  dreamActions: DurableTraceDreamAction[];
  profileSnapshots: DurableTraceProfileSnapshot[];
  timeline: DurableTraceTimelineEvent[];
}

/**
 * Aggregate memory status facts used by host memory runtimes.
 */
export interface MemoryStatusSnapshot {
  activeDurables: number;
  coreDurables: number;
  sourceFiles: number;
}

/**
 * Host-neutral memory read model used by prompt injection, trace, and status flows.
 */
export interface MemoryRepository {
  /**
   * Finds the most recent durable matching a subject string.
   *
   * @param subject - Free-form subject text to resolve.
   * @returns Matching durable, or `null` when no match exists.
   */
  findDurableBySubject(subject: string): Promise<Durable | null>;

  /**
   * Finds the most recently created durable from any state.
   *
   * @returns Newest durable, or `null` when none exist.
   */
  findMostRecentDurable(): Promise<Durable | null>;

  /**
   * Loads the current trace view for one durable.
   *
   * @param durableId - Durable identifier to inspect.
   * @returns Trace payload, or `null` when the durable is missing.
   */
  getDurableTrace(durableId: string): Promise<DurableTrace | null>;

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
