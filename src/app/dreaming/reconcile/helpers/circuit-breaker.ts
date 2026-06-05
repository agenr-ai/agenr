import {
  CLAIM_KEY_CONCENTRATION_RATIO,
  CLAIM_KEY_CONCENTRATION_THRESHOLD,
  COLLISION_SPIKE_RATIO,
  COLLISION_SPIKE_THRESHOLD,
  ENTITY_CONCENTRATION_RATIO,
  ENTITY_CONCENTRATION_THRESHOLD,
} from "../constants.js";
import type { ClaimKeyCircuitBreakerState, ClaimKeyCircuitBreakerTrip } from "../types.js";

export function createCircuitBreakerState(): ClaimKeyCircuitBreakerState {
  return {
    totalAutoMutations: 0,
    blockedCollisions: 0,
    appliedByClaimKey: new Map<string, number>(),
    appliedByEntity: new Map<string, number>(),
  };
}

export function recordCollision(state: ClaimKeyCircuitBreakerState): void {
  state.blockedCollisions += 1;
}

export function recordAppliedRepair(state: ClaimKeyCircuitBreakerState, claimKey: string): ClaimKeyCircuitBreakerTrip | null {
  state.totalAutoMutations += 1;
  state.appliedByClaimKey.set(claimKey, (state.appliedByClaimKey.get(claimKey) ?? 0) + 1);
  const entity = claimKey.split("/", 1)[0] ?? claimKey;
  state.appliedByEntity.set(entity, (state.appliedByEntity.get(entity) ?? 0) + 1);
  return evaluateCircuitBreaker(state);
}

export function evaluateCircuitBreaker(state: ClaimKeyCircuitBreakerState): ClaimKeyCircuitBreakerTrip | null {
  const largestClaimKeyCluster = maxCounterValue(state.appliedByClaimKey);
  if (
    state.totalAutoMutations >= CLAIM_KEY_CONCENTRATION_THRESHOLD &&
    largestClaimKeyCluster >= CLAIM_KEY_CONCENTRATION_THRESHOLD &&
    largestClaimKeyCluster / state.totalAutoMutations >= CLAIM_KEY_CONCENTRATION_RATIO
  ) {
    const target = maxCounterKey(state.appliedByClaimKey) ?? "unknown";
    return {
      kind: "claim_key_concentration",
      message: `Reconcile circuit breaker tripped: ${largestClaimKeyCluster}/${state.totalAutoMutations} auto-repairs converged onto "${target}".`,
    };
  }

  const largestEntityCluster = maxCounterValue(state.appliedByEntity);
  if (
    state.totalAutoMutations >= ENTITY_CONCENTRATION_THRESHOLD &&
    largestEntityCluster >= ENTITY_CONCENTRATION_THRESHOLD &&
    largestEntityCluster / state.totalAutoMutations >= ENTITY_CONCENTRATION_RATIO
  ) {
    const target = maxCounterKey(state.appliedByEntity) ?? "unknown";
    return {
      kind: "entity_prefix_concentration",
      message: `Reconcile circuit breaker tripped: ${largestEntityCluster}/${state.totalAutoMutations} auto-repairs converged onto entity prefix "${target}".`,
    };
  }

  if (
    state.blockedCollisions >= COLLISION_SPIKE_THRESHOLD &&
    state.totalAutoMutations + state.blockedCollisions > 0 &&
    state.blockedCollisions / (state.totalAutoMutations + state.blockedCollisions) >= COLLISION_SPIKE_RATIO
  ) {
    return {
      kind: "collision_spike",
      message: `Reconcile circuit breaker tripped: ${state.blockedCollisions} proposed repairs were blocked by collisions, suggesting non-convergent claim-key cleanup.`,
    };
  }

  return null;
}

function maxCounterValue(counter: Map<string, number>): number {
  let max = 0;
  for (const value of counter.values()) {
    max = Math.max(max, value);
  }

  return max;
}

function maxCounterKey(counter: Map<string, number>): string | null {
  let bestKey: string | null = null;
  let bestValue = -1;

  for (const [key, value] of counter.entries()) {
    if (value > bestValue) {
      bestKey = key;
      bestValue = value;
    }
  }

  return bestKey;
}
