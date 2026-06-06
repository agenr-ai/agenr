import type { ClaimSlotPolicyConfig } from "../../core/claim-slot-policy.js";
import type { ProcedureDatabasePort, RecallPorts } from "../../core/ports.js";
import type { Durable } from "../../core/types.js";

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
  /** Optional semantic clock used for recall validity and recency decisions. */
  now?: Date;
  /**
   * Optional lookup for active user memory directives.
   *
   * When wired, the service drops directive rows from injection and suppresses
   * any surfaced durable that mentions a directive's blocked topic. Callers that
   * omit it skip directive abstention entirely.
   */
  listActiveAbstainDirectives?: () => Promise<Durable[]>;
  /**
   * Optional lookup for active proactive directives with `topic:` triggers.
   *
   * When wired, the service may inject matching directives during before-turn
   * selection before the abstain filter runs.
   */
  listActiveTopicProactiveDirectives?: () => Promise<Durable[]>;
}
