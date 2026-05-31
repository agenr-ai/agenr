import type { WorkingMemoryRepository } from "./repository.js";
import { createFailure, type WorkingMemoryFailure } from "./results.js";

const WORKING_MEMORY_DISABLED_MESSAGE = "Working memory is disabled by the workingMemory feature flag." as const;
const WORKING_MEMORY_MISCONFIGURED_MESSAGE = "Working memory is enabled, but no working-memory repository was wired into the runtime." as const;

/** Input required to verify working-memory readiness. */
export interface WorkingMemoryReadyInput {
  /** Resolved workingMemory feature flag. */
  featureEnabled: boolean;
  /** Optional repository wired by the runtime. */
  repository?: WorkingMemoryRepository;
}

/**
 * Returns a stable failure when working memory is disabled or misconfigured.
 *
 * @param input - Feature flag and repository wiring state.
 * @returns Failure result when not ready, otherwise null.
 */
export function workingMemoryNotReadyFailure(input: WorkingMemoryReadyInput): WorkingMemoryFailure | null {
  if (!input.featureEnabled) {
    return createFailure("feature_disabled", WORKING_MEMORY_DISABLED_MESSAGE);
  }

  if (!input.repository) {
    return createFailure("misconfigured", WORKING_MEMORY_MISCONFIGURED_MESSAGE);
  }

  return null;
}

export { WORKING_MEMORY_DISABLED_MESSAGE, WORKING_MEMORY_MISCONFIGURED_MESSAGE };
