import type { Durable } from "../../core/types.js";

/**
 * Minimal host session shape needed for tool-call provenance labels.
 */
export interface ToolSessionLike {
  /** Optional stable memory session key. */
  sessionKey?: string;
  /** Optional host session id. */
  sessionId?: string;
  /** Optional agent id. */
  agentId?: string;
}

/**
 * Host prefixes used in source-file labels for tool-call provenance.
 */
export type SessionSourcePrefix = "openclaw-session" | "skeln-session";

/**
 * Builds a stable source-file provenance label from a host session context.
 *
 * @param session - Tool invocation session context.
 * @param prefix - Host-specific source prefix.
 * @returns Source-file label for stored entries.
 */
export function buildSessionSourceFile(session: ToolSessionLike, prefix: SessionSourcePrefix): string {
  const target = session.sessionKey ?? session.sessionId ?? session.agentId ?? "unknown";
  return `${prefix}:${target}`;
}

/**
 * Builds conservative explicit tool-call support metadata for claim-key preservation.
 *
 * @param session - Tool invocation session context.
 * @param prefix - Host-specific source prefix.
 * @param toolName - Tool that carried the explicit claim key.
 * @param observedAt - Observation timestamp to persist alongside the support metadata.
 * @returns Support metadata suitable for explicit manual claim-key paths.
 */
export function buildToolCallClaimSupport(
  session: ToolSessionLike,
  prefix: SessionSourcePrefix,
  toolName: string,
  observedAt: string,
): Pick<Durable, "claim_support_source_kind" | "claim_support_locator" | "claim_support_observed_at" | "claim_support_mode"> {
  return {
    claim_support_source_kind: "tool_call",
    claim_support_locator: `${buildSessionSourceFile(session, prefix)}#${toolName}`,
    claim_support_observed_at: observedAt,
    claim_support_mode: "explicit",
  };
}
