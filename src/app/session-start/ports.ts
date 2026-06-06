import type { ClaimSlotPolicyConfig } from "../../core/claim-slot-policy.js";
import type { RecallPorts } from "../../core/ports.js";
import type { Durable } from "../../core/types.js";

/** Active profile snapshot metadata used by session-start selection. */
export interface SessionStartProfileSnapshot {
  id: string;
  durableIds: string[];
  directiveIds: string[];
  asOf: string;
  runId: string | null;
  createdAt: string;
}

/**
 * Feature-scoped durable-memory lookup contract used by session-start selection.
 */
export interface SessionStartRepository {
  /**
   * Lists active always-on core entries ordered for session-start use.
   *
   * @param limit - Maximum number of core entries to return.
   * @returns Ordered active core entries.
   */
  listCoreEntries(limit: number, now?: Date): Promise<Durable[]>;
  /**
   * Loads the active profile snapshot when it is fresh enough.
   *
   * @param maxAgeMs - Maximum snapshot age in milliseconds.
   * @returns Fresh active snapshot, or null.
   */
  getActiveProfileSnapshot(maxAgeMs: number, now?: Date): Promise<SessionStartProfileSnapshot | null>;
  /**
   * Hydrates active durables by id while preserving the caller's id order.
   *
   * @param ids - Ordered durable ids to hydrate.
   * @returns Hydrated active durables in requested order.
   */
  listEntriesByIds(ids: string[]): Promise<Durable[]>;
}

/**
 * Dependencies needed by the app-layer session-start service.
 */
export interface SessionStartDeps {
  /** Feature-scoped repository for always-on core memory lookup. */
  repository: SessionStartRepository;
  /** Shared durable recall ports reused for artifact-grounded memory selection. */
  recall: RecallPorts;
  /** Optional runtime claim-slot-policy overrides used during claim-aware shaping. */
  slotPolicyConfig?: ClaimSlotPolicyConfig;
  /** Optional semantic clock used for validity, freshness, and recall decisions. */
  now?: Date;
  /**
   * Optional lookup for active user memory directives.
   *
   * When wired, the service drops directive rows from injection and suppresses
   * any surfaced durable that mentions a directive's blocked topic. Callers that
   * omit it skip directive abstention entirely.
   */
  listActiveAbstainDirectives?: () => Promise<Durable[]>;
  /** Optional lookup for proactive session-start directives. */
  listActiveProactiveDirectives?: () => Promise<Durable[]>;
}
