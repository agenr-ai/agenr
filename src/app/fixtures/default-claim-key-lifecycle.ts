import { buildManualClaimKeyLifecycle } from "../../core/claim-key-lifecycle.js";
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

  const lifecycle = buildManualClaimKeyLifecycle({
    claimKey,
    rawClaimKey: durable.claim_key_raw ?? durable.claim_key,
    supportSourceKind: durable.claim_support_source_kind,
    supportLocator: durable.claim_support_locator,
    supportObservedAt: durable.claim_support_observed_at,
    supportMode: durable.claim_support_mode,
  });

  return {
    ...durable,
    claim_key_raw: durable.claim_key_raw ?? lifecycle.claim_key_raw,
    claim_key_status: lifecycle.claim_key_status,
    claim_key_source: durable.claim_key_source ?? lifecycle.claim_key_source,
    claim_key_confidence: durable.claim_key_confidence ?? lifecycle.claim_key_confidence,
    claim_key_rationale: durable.claim_key_rationale ?? rationale,
    claim_support_source_kind: durable.claim_support_source_kind ?? lifecycle.claim_support_source_kind,
    claim_support_locator: durable.claim_support_locator ?? lifecycle.claim_support_locator,
    claim_support_observed_at: durable.claim_support_observed_at ?? lifecycle.claim_support_observed_at,
    claim_support_mode: durable.claim_support_mode ?? lifecycle.claim_support_mode,
  };
}
