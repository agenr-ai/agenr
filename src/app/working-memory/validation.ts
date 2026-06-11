import { isTrustedHostMutationSource, type AgenrWorkMutationSource, type TrustedHostMutationSource } from "./constants.js";
import { utf8ByteLength, WORKING_SCRATCHPAD_MAX_BYTES } from "./limits.js";
import type { AgenrWorkTarget, ExplicitWorkingSetTarget } from "./mutations.js";
import type { WorkingBudgetState, WorkingUsageDelta } from "./snapshot.js";
import { createFailure, type WorkingMemoryFailure } from "./results.js";

const CREATE_REQUIRES_EXPLICIT_TARGET_MESSAGE = "agenr_work create requires an explicit session or goal target." as const;

export { CREATE_REQUIRES_EXPLICIT_TARGET_MESSAGE };

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

/** Normalizes a required reason string. */
export function normalizeRequiredString(value: string | undefined, message: string): { ok: true; value: string } | WorkingMemoryFailure {
  const trimmed = value?.trim();
  if (!trimmed) {
    return createFailure("invalid_request", message);
  }

  return { ok: true, value: trimmed };
}

/** Normalizes expected revision parameters. */
export function normalizeExpectedRevision(value: number | undefined): { ok: true; value: number } | WorkingMemoryFailure {
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    return createFailure("invalid_request", "expectedRevision must be a non-negative integer.");
  }

  return { ok: true, value: value };
}

/**
 * Returns true when a trusted host caller may inherit the selected working-set revision.
 *
 * @param source - Runtime surface that emitted the mutation.
 */
export function canDefaultExpectedRevision(source: AgenrWorkMutationSource | undefined): source is TrustedHostMutationSource {
  return isTrustedHostMutationSource(source);
}

/**
 * Resolves the revision to use after scope selection.
 *
 * Trusted host paths may omit expectedRevision and inherit the selected revision.
 * Model tool updates must supply an explicit observed revision.
 *
 * @param selectedRevision - Revision loaded from the selected working set.
 * @param providedRevision - Revision supplied by the caller, if any.
 * @param source - Runtime surface that emitted the mutation.
 * @returns Normalized revision or a stable failure.
 */
export function resolveExpectedRevision(
  selectedRevision: number,
  providedRevision: number | undefined,
  source?: AgenrWorkMutationSource,
): { ok: true; value: number } | WorkingMemoryFailure {
  if (providedRevision === undefined) {
    if (!canDefaultExpectedRevision(source)) {
      return createFailure("invalid_request", "expectedRevision must be a non-negative integer.");
    }

    return { ok: true, value: selectedRevision };
  }

  return normalizeExpectedRevision(providedRevision);
}

/** Validates trusted budget state values before storage. */
export function validateWorkingBudgetState(budget: WorkingBudgetState): { ok: true } | WorkingMemoryFailure {
  const entries: Array<[keyof WorkingBudgetState, number | undefined]> = [
    ["tokenBudget", budget.tokenBudget],
    ["tokenUsed", budget.tokenUsed],
    ["wallClockBudgetSeconds", budget.wallClockBudgetSeconds],
    ["wallClockUsedSeconds", budget.wallClockUsedSeconds],
    ["turnBudget", budget.turnBudget],
    ["turnsUsed", budget.turnsUsed],
    ["requireReviewAfterSeconds", budget.requireReviewAfterSeconds],
  ];

  for (const [key, value] of entries) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      return createFailure("invalid_request", `${key} must be a non-negative finite number.`);
    }
  }

  return { ok: true };
}

/** Validates freeform scratchpad content before storage. */
export function validateWorkingScratchpad(scratchpad: string): { ok: true } | WorkingMemoryFailure {
  const byteLength = utf8ByteLength(scratchpad);
  if (byteLength > WORKING_SCRATCHPAD_MAX_BYTES) {
    return createFailure("invalid_request", `scratchpad must be at most ${WORKING_SCRATCHPAD_MAX_BYTES} UTF-8 bytes.`, {
      byteLength,
      maxBytes: WORKING_SCRATCHPAD_MAX_BYTES,
    });
  }

  return { ok: true };
}

/** Validates additive usage deltas before accounting. */
export function validateWorkingUsageDelta(usage: WorkingUsageDelta): { ok: true } | WorkingMemoryFailure {
  const entries: Array<[keyof WorkingUsageDelta, number | undefined]> = [
    ["tokenDelta", usage.tokenDelta],
    ["wallClockSecondsDelta", usage.wallClockSecondsDelta],
    ["turnDelta", usage.turnDelta],
  ];
  const hasDelta = entries.some(([, value]) => value !== undefined);
  if (!hasDelta) {
    return createFailure("invalid_request", "account_usage requires at least one usage delta.");
  }

  for (const [key, value] of entries) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      return createFailure("invalid_request", `${key} must be a non-negative finite number.`);
    }
  }

  return { ok: true };
}
