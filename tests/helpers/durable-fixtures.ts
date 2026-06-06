import { applyDefaultClaimKeyLifecycle } from "../../src/app/fixtures/default-claim-key-lifecycle.js";
import type { Durable } from "../../src/core/types.js";

/**
 * Applies default claim-key lifecycle metadata for test durables that carry a
 * claim key without explicit lifecycle fields.
 *
 * @param durable - Partial durable fixture payload.
 * @returns Durable with lifecycle defaults filled when needed.
 */
export function finalizeTestDurable(durable: Durable): Durable {
  return applyDefaultClaimKeyLifecycle(durable, "test fixture");
}
