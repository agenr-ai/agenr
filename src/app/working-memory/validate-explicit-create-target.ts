import type { AgenrWorkTarget, ExplicitWorkingSetTarget } from "./mutations.js";
import { createFailure, type WorkingMemoryFailure } from "./results.js";

const CREATE_REQUIRES_EXPLICIT_TARGET_MESSAGE = "agenr_work create requires an explicit session or goal target." as const;

/** Successful explicit create-target validation. */
export interface ValidatedExplicitCreateTarget {
  /** Success discriminator. */
  ok: true;
  /** Canonical create layer. */
  target: ExplicitWorkingSetTarget;
}

/** Result returned when validating create target selection. */
export type ValidateExplicitCreateTargetResult = ValidatedExplicitCreateTarget | WorkingMemoryFailure;

/**
 * Validates that create requests name an explicit session or goal layer.
 *
 * @param target - Requested working-set target.
 * @returns Explicit create layer or a stable invalid-request failure.
 */
export function validateExplicitCreateTarget(target: AgenrWorkTarget | undefined): ValidateExplicitCreateTargetResult {
  if (target === "session" || target === "goal") {
    return { ok: true, target };
  }

  return createFailure("invalid_request", CREATE_REQUIRES_EXPLICIT_TARGET_MESSAGE);
}

export { CREATE_REQUIRES_EXPLICIT_TARGET_MESSAGE };
