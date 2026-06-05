import type { ClaimSlotPolicyConfig } from "../../core/claim-slot-policy.js";
import type { RecallPorts } from "../../core/ports.js";
import type { Durable } from "../../core/types.js";

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
  listCoreEntries(limit: number): Promise<Durable[]>;
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
}
