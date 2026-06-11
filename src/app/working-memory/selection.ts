import { layersForAutoSelect, layersForList, validateSelectedWorkingSet, type HostWorkingSetPolicy } from "./host-working-set-policy.js";
import type { AgenrWorkParams, AgenrWorkTarget, ExplicitWorkingSetTarget } from "./mutations.js";
import type { WorkingSetRecord } from "./records.js";
import { isWorkingSetCreateFailure, type WorkingMemoryRepository } from "./repository.js";
import { createFailure, type WorkingMemoryFailure } from "./results.js";
import { resolveScopeForLayer, type ResolvedWorkingScope, type WorkingScope, type WorkingScopeResolutionResult } from "./scope.js";

/** Successful scope lookup with current working-set matches. */
export interface CurrentWorkingSetLookup {
  /** Success discriminator. */
  ok: true;
  /** Resolved scope used for the lookup. */
  scope: ResolvedWorkingScope;
  /** Current working sets for the scope, possibly empty. */
  matches: WorkingSetRecord[];
}

/** Result returned when looking up current working sets by scope. */
export type CurrentWorkingSetLookupResult = CurrentWorkingSetLookup | WorkingMemoryFailure;

/**
 * Resolves a target-specific scope and loads current working sets for it.
 *
 * @param scope - Raw scope facts supplied by the host.
 * @param repository - Working-memory persistence port.
 * @param target - Target scope kind to resolve.
 * @returns Resolved scope and matching sets, or a stable failure.
 */
export async function lookupCurrentWorkingSetsForTarget(
  scope: Partial<WorkingScope> | undefined,
  repository: WorkingMemoryRepository,
  target: ExplicitWorkingSetTarget,
): Promise<CurrentWorkingSetLookupResult> {
  const scopeResolution = resolveScopeForLayer(scope, target);
  if (!scopeResolution.ok) {
    return createFailure("missing_scope", scopeResolution.message);
  }

  const matches = await repository.findCurrentWorkingSets(scopeResolution.scope);
  if (matches.length > 1) {
    return createFailure("ambiguous_scope", "Multiple current working sets matched the resolved scope.", {
      scopeKey: scopeResolution.scope.scopeKey,
      workingSetIds: matches.map((match) => match.id),
    });
  }

  return {
    ok: true,
    scope: scopeResolution.scope,
    matches,
  };
}

/** Successful lookup of a unique current working set for one scope. */
export interface UniqueCurrentWorkingSet {
  /** Success discriminator. */
  ok: true;
  /** Matched working set. */
  workingSet: WorkingSetRecord;
  /** Resolved scope used for the lookup. */
  scope: ResolvedWorkingScope;
}

/** Result returned when resolving a unique current working set by scope. */
export type UniqueCurrentWorkingSetResult = UniqueCurrentWorkingSet | WorkingMemoryFailure;

/**
 * Finds the unique current working set for one target-specific scope.
 *
 * @param scope - Raw scope facts supplied by the host.
 * @param repository - Working-memory persistence port.
 * @param target - Target scope kind to resolve.
 * @returns Selected set or a stable failure.
 */
export async function findUniqueCurrentWorkingSetForTarget(
  scope: Partial<WorkingScope> | undefined,
  repository: WorkingMemoryRepository,
  target: ExplicitWorkingSetTarget,
): Promise<UniqueCurrentWorkingSetResult> {
  const lookup = await lookupCurrentWorkingSetsForTarget(scope, repository, target);
  if (!lookup.ok) {
    return lookup;
  }

  if (lookup.matches.length === 0) {
    return createFailure("missing_active_set", "No current working set matched the resolved scope.", {
      scopeKey: lookup.scope.scopeKey,
    });
  }

  return {
    ok: true,
    workingSet: lookup.matches[0],
    scope: lookup.scope,
  };
}

/** Options that tune working-set selection behavior. */
export interface SelectWorkingSetOptions {
  /** Host policy governing session and goal working-set exposure. */
  policy: HostWorkingSetPolicy;
}

/** Successful working-set selection. */
export interface WorkingSetSelection {
  /** Success discriminator. */
  ok: true;
  /** Selected working set. */
  workingSet: WorkingSetRecord;
  /** Resolved scope when selection used scope facts. */
  scope?: ResolvedWorkingScope;
}

/** Result returned when selecting a working set by id or scope. */
export type WorkingSetSelectionResult = WorkingSetSelection | WorkingMemoryFailure;

/**
 * Selects a working set by explicit id or resolved current scope.
 *
 * @param params - Selection inputs from a tool call.
 * @param repository - Working-memory persistence port.
 * @param options - Host policy governing selection behavior.
 * @returns Selected set or a stable failure.
 */
export async function selectWorkingSet(
  params: Pick<AgenrWorkParams, "workingSetId" | "scope" | "target">,
  repository: WorkingMemoryRepository,
  options: SelectWorkingSetOptions,
): Promise<WorkingSetSelectionResult> {
  const { policy } = options;
  const workingSetId = params.workingSetId?.trim();
  if (workingSetId) {
    const workingSet = await repository.getWorkingSet(workingSetId);
    if (!workingSet) {
      return createFailure("not_found", `Working set ${workingSetId} was not found.`, { workingSetId });
    }

    const policyFailure = validateSelectedWorkingSet(policy, workingSet);
    if (policyFailure) {
      return policyFailure;
    }

    return { ok: true, workingSet };
  }

  const target = params.target ?? "auto";
  if (target === "goal" || target === "session") {
    return selectByExplicitTarget(params.scope, repository, target, policy);
  }

  let lastFailure: WorkingMemoryFailure | undefined;
  for (const explicitTarget of layersForAutoSelect(policy)) {
    const result = await selectByExplicitTarget(params.scope, repository, explicitTarget, policy);
    if (result.ok) {
      return result;
    }

    lastFailure = result;
    if (result.code !== "missing_active_set" && result.code !== "missing_scope") {
      return result;
    }
  }

  return (
    lastFailure ??
    createFailure("missing_active_set", "No current working set matched the resolved scope.", {
      scopeKey: "unknown",
    })
  );
}

/** Selects the unique current working set for one explicit layer. */
async function selectByExplicitTarget(
  scope: Partial<WorkingScope> | undefined,
  repository: WorkingMemoryRepository,
  target: ExplicitWorkingSetTarget,
  policy: HostWorkingSetPolicy,
): Promise<WorkingSetSelectionResult> {
  const current = await findUniqueCurrentWorkingSetForTarget(scope, repository, target);
  if (!current.ok) {
    return current;
  }

  const policyFailure = validateSelectedWorkingSet(policy, current.workingSet);
  if (policyFailure) {
    return policyFailure;
  }

  return {
    ok: true,
    workingSet: current.workingSet,
    scope: current.scope,
  };
}

/** Successful list scope resolution. */
export interface ResolvedListScopes {
  /** Success discriminator. */
  ok: true;
  /** Canonical scopes used to filter listed working sets. */
  scopes: ResolvedWorkingScope[];
}

/** Result used to filter list output by scope. */
export type ResolveListScopesResult = ResolvedListScopes | Extract<WorkingScopeResolutionResult, { ok: false }>;

/**
 * Resolves the scope filters used by list for target-aware requests.
 *
 * Explicit targets require a resolvable scope for that layer. Auto includes every
 * layer that can be resolved from the supplied host facts.
 *
 * @param scope - Raw scope facts supplied by the host.
 * @param target - Requested working-set target.
 * @param policy - Host policy governing goal layer inclusion.
 * @returns Resolved scopes or a stable missing-scope failure.
 */
export function resolveListScopes(scope: Partial<WorkingScope>, target: AgenrWorkTarget | undefined, policy: HostWorkingSetPolicy): ResolveListScopesResult {
  const layers = layersForList(policy, target);
  if (layers.length === 0) {
    return {
      ok: false,
      code: "missing_scope",
      message: "Goal working memory needs a task, conversation, or git scope.",
    };
  }

  if (target === "session" || target === "goal") {
    const resolution = resolveScopeForLayer(scope, layers[0]);
    if (!resolution.ok) {
      return resolution;
    }

    return { ok: true, scopes: [resolution.scope] };
  }

  const scopes: ResolvedWorkingScope[] = [];
  for (const layer of layers) {
    const resolution = resolveScopeForLayer(scope, layer);
    if (resolution.ok) {
      scopes.push(resolution.scope);
    }
  }

  if (scopes.length === 0) {
    return {
      ok: false,
      code: "missing_scope",
      message: "Working memory needs a session id or a task, conversation, or git scope.",
    };
  }

  return { ok: true, scopes };
}

/** Successful create-scope resolution. */
export interface CreateScopeResolution {
  /** Success discriminator. */
  ok: true;
  /** Canonical scope for the new working set. */
  scope: ResolvedWorkingScope;
}

/** Result returned when resolving scope for create. */
export type CreateScopeResult = CreateScopeResolution | WorkingMemoryFailure;

/**
 * Resolves scope for create and verifies no current working set already exists.
 *
 * @param params - Create inputs with optional working set id or scope facts.
 * @param repository - Working-memory persistence port.
 * @returns Resolved scope ready for create, or a stable failure.
 */
export async function resolveCreateScope(
  params: Pick<AgenrWorkParams, "workingSetId" | "scope"> & { target: ExplicitWorkingSetTarget },
  repository: WorkingMemoryRepository,
): Promise<CreateScopeResult> {
  const workingSetId = params.workingSetId?.trim();
  if (workingSetId) {
    const workingSet = await repository.getWorkingSet(workingSetId);
    if (workingSet) {
      return createFailure("active_set_exists", "A working set is already active for this scope.", {
        workingSetId: workingSet.id,
        scopeKey: workingSet.scopeKey,
      });
    }

    return createFailure("not_found", `Working set ${workingSetId} was not found.`, { workingSetId });
  }

  const lookup = await lookupCurrentWorkingSetsForTarget(params.scope, repository, params.target);
  if (!lookup.ok) {
    return lookup;
  }

  if (lookup.matches.length === 1) {
    const existing = lookup.matches[0];
    return createFailure("active_set_exists", "A working set already exists for this scope.", {
      workingSetId: existing.id,
      scopeKey: lookup.scope.scopeKey,
    });
  }

  return {
    ok: true,
    scope: lookup.scope,
  };
}

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
