import type { ClaimKeyCircuitBreakerTrip } from "../types.js";
import type { ReconcilePassContext } from "../pass-context.js";
import { evaluateCircuitBreaker, recordAppliedRepair, recordCollision } from "./circuit-breaker.js";

const USER_ABORT_ERROR = "Run aborted by user (SIGINT).";

/**
 * Marks the pass as aborted when the run signal has been cancelled.
 *
 * @param ctx - Mutable reconcile pass context.
 * @returns True when the pass was marked aborted.
 */
export function markAbortedIfSignalled(ctx: ReconcilePassContext): boolean {
  if (ctx.options.signal?.aborted === true) {
    ctx.telemetry.terminalStatus = "aborted";
    ctx.telemetry.terminalError = USER_ABORT_ERROR;
    return true;
  }

  return false;
}

/**
 * Records one circuit-breaker trip and marks the pass failed.
 *
 * @param ctx - Mutable reconcile pass context.
 * @param breaker - Circuit-breaker trip to persist, when present.
 */
export function tripCircuitBreaker(ctx: ReconcilePassContext, breaker: ClaimKeyCircuitBreakerTrip | null): void {
  if (!breaker) {
    return;
  }

  ctx.telemetry.circuitBreaker = breaker;
  ctx.telemetry.terminalStatus = "failed";
  ctx.telemetry.terminalError = breaker.message;
}

/**
 * Records one applied repair and trips the breaker when thresholds are exceeded.
 *
 * @param ctx - Mutable reconcile pass context.
 * @param claimKey - Canonical claim key that was repaired.
 * @param projected - Whether the projected working set was updated.
 */
export function recordRepairOutcome(ctx: ReconcilePassContext, claimKey: string, projected: boolean): void {
  if (!projected) {
    return;
  }

  tripCircuitBreaker(ctx, recordAppliedRepair(ctx.telemetry.circuitBreakerState, claimKey));
}

/**
 * Records one blocked collision and evaluates whether the breaker should trip.
 *
 * The first breaker trip wins; later collision events do not re-evaluate thresholds.
 *
 * @param ctx - Mutable reconcile pass context.
 */
export function recordCollisionOutcome(ctx: ReconcilePassContext): void {
  recordCollision(ctx.telemetry.circuitBreakerState);
  if (ctx.telemetry.circuitBreaker) {
    return;
  }

  tripCircuitBreaker(ctx, evaluateCircuitBreaker(ctx.telemetry.circuitBreakerState));
}
