import type { Durable } from "../../core/types.js";

/**
 * Applies default claim-key lifecycle metadata when a fixture carries a claim key
 * without explicit lifecycle fields.
 *
 * @param durable - Fixture durable payload.
 * @param rationale - Default rationale stored when the fixture omits one.
 * @returns Durable with lifecycle defaults filled when needed.
 */
export function applyDefaultClaimKeyLifecycle(durable: Durable, rationale: string): Durable {
  const claimKey = durable.claim_key?.trim();
  if (!claimKey || durable.claim_key_status) {
    return durable;
  }

  return {
    ...durable,
    claim_key_status: "trusted",
    claim_key_source: durable.claim_key_source ?? "manual",
    claim_key_confidence: durable.claim_key_confidence ?? 1,
    claim_key_rationale: durable.claim_key_rationale ?? rationale,
  };
}
