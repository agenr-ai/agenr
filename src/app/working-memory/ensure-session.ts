import type { WorkingSetRecord } from "./records.js";
import { isWorkingSetCreateFailure, type WorkingMemoryRepository } from "./repository.js";
import { createFailure, type WorkingMemoryFailure } from "./results.js";
import { lookupCurrentWorkingSetsForTarget } from "./find-current-set.js";
import type { WorkingScope } from "./scope.js";

/** Input used to ensure a session working set exists. */
export interface EnsureSessionWorkingSetInput {
  /** Raw host scope facts. */
  scope?: Partial<WorkingScope>;
  /** Actor that initialized the set when creation is needed. */
  actor?: "model" | "user" | "runtime" | "system";
  /** Source that initialized the set when creation is needed. */
  source?: "tool" | "goal_command" | "lifecycle_hook" | "consolidation_job";
  /** Adapter or runtime source label stored on new rows. */
  sourceLabel?: string;
  /** Timestamp used for creation provenance. */
  timestamp: string;
}

/** Successful ensure result without tool projection overhead. */
export interface EnsureSessionWorkingSetSuccess {
  /** Success discriminator. */
  ok: true;
  /** Existing or newly created session working set. */
  workingSet: WorkingSetRecord;
  /** Whether a new working set was created during ensure. */
  created: boolean;
}

/** Result of ensuring a session working set. */
export type EnsureSessionWorkingSetResult = EnsureSessionWorkingSetSuccess | WorkingMemoryFailure;

/**
 * Loads or creates the active session working set for one host session.
 *
 * @param input - Scope, provenance, and timestamp facts.
 * @param repository - Working-memory persistence port.
 * @returns Existing or newly created session working set.
 */
export async function ensureSessionWorkingSet(
  input: EnsureSessionWorkingSetInput,
  repository: WorkingMemoryRepository,
): Promise<EnsureSessionWorkingSetResult> {
  const lookup = await lookupCurrentWorkingSetsForTarget(input.scope, repository, "session");
  if (!lookup.ok) {
    return lookup;
  }

  if (lookup.matches.length === 1) {
    return {
      ok: true,
      workingSet: lookup.matches[0],
      created: false,
    };
  }

  const created = await repository.createWorkingSet({
    scope: lookup.scope,
    status: "active",
    snapshot: {},
    actor: input.actor,
    source: input.source,
    sourceLabel: input.sourceLabel,
    sessionId: lookup.scope.sessionId,
    now: input.timestamp,
  });

  if (isWorkingSetCreateFailure(created)) {
    const retry = await lookupCurrentWorkingSetsForTarget(input.scope, repository, "session");
    if (!retry.ok) {
      return retry;
    }

    if (retry.matches.length === 1) {
      return {
        ok: true,
        workingSet: retry.matches[0],
        created: false,
      };
    }

    return createFailure("ambiguous_scope", "Session working-set create conflicted, but retry lookup did not find exactly one active set.", {
      scopeKey: created.scopeKey,
      matchCount: retry.matches.length,
    });
  }

  return {
    ok: true,
    workingSet: created.workingSet,
    created: true,
  };
}
