import type { ClaimSlotPolicyConfig } from "../../core/claim-slot-policy.js";
import type { ProcedureDatabasePort, RecallPorts } from "../../core/ports.js";

/**
 * Dependencies needed by the app-layer before-turn service.
 */
export interface BeforeTurnDeps {
  /** Shared durable recall ports reused for turn-time memory selection. */
  recall: RecallPorts;
  /** Dedicated procedure database port used for proactive procedure selection. */
  procedures: ProcedureDatabasePort;
  /** Optional semantic embedding helper reused by dedicated procedure recall. */
  embedQuery?: (text: string) => Promise<number[]>;
  /** Optional runtime claim-slot-policy overrides used during claim-aware shaping. */
  slotPolicyConfig?: ClaimSlotPolicyConfig;
}
