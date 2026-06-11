/**
 * Status values accepted by working sets.
 */
const WORKING_SET_STATUSES = ["active", "paused", "blocked", "waiting", "needs_review", "budget_limited", "complete", "closed", "abandoned"] as const;

/**
 * Status values that accept normal update operations.
 */
const OPEN_WORKING_SET_STATUSES = ["active", "paused", "blocked", "waiting", "needs_review", "budget_limited"] as const;

/**
 * Status values that remain selectable as the current goal for a scope.
 */
const CURRENT_WORKING_SET_STATUSES = [...OPEN_WORKING_SET_STATUSES, "complete"] as const;

/**
 * Status values that are managed only by the close path.
 */
const CLOSE_MANAGED_WORKING_SET_STATUSES = ["closed", "abandoned"] as const;

/**
 * Canonical scope kinds produced by the working-memory scope resolver.
 */
const WORKING_SCOPE_KINDS = ["task", "conversation", "git_branch", "git_cwd", "session", "session_id"] as const;

/**
 * Scope kinds that belong to the goal working-set layer.
 */
const GOAL_WORKING_SCOPE_KINDS = ["task", "conversation", "git_branch", "git_cwd", "session_id"] as const;

/**
 * Supported working-memory tool actions.
 */
const AGENR_WORK_ACTIONS = ["get", "list", "create", "update", "close"] as const;

/**
 * Actors allowed to mutate the working-memory ledger.
 */
const AGENR_WORK_MUTATION_ACTORS = ["model", "user", "runtime", "system"] as const;

/**
 * Source surfaces that can emit working-memory mutations.
 */
const AGENR_WORK_MUTATION_SOURCES = ["tool", "goal_command", "lifecycle_hook", "consolidation_job"] as const;

/**
 * Trusted host surfaces allowed to close working sets and omit expectedRevision.
 */
const TRUSTED_HOST_MUTATION_SOURCES = ["goal_command", "lifecycle_hook", "consolidation_job"] as const;

/**
 * Candidate promotion states emitted by close and consolidation paths.
 *
 * `rejected` marks candidates the promotion pipeline refused (validation or
 * store rejection); `dismissed` remains the manual model or user dismissal.
 */
const WORKING_CANDIDATE_PROMOTION_STATUSES = ["pending", "promoted", "rejected", "dismissed"] as const;

/**
 * Host continuation policies stored on active working sets.
 */
const WORKING_CONTINUATION_POLICIES = ["manual", "on_idle"] as const;

/**
 * Budget dimensions that can stop autonomous goal continuation.
 */
const WORKING_BUDGET_LIMIT_REASONS = ["token", "wall_clock", "turn"] as const;

export {
  AGENR_WORK_ACTIONS,
  AGENR_WORK_MUTATION_ACTORS,
  AGENR_WORK_MUTATION_SOURCES,
  CLOSE_MANAGED_WORKING_SET_STATUSES,
  CURRENT_WORKING_SET_STATUSES,
  OPEN_WORKING_SET_STATUSES,
  WORKING_CANDIDATE_PROMOTION_STATUSES,
  WORKING_BUDGET_LIMIT_REASONS,
  WORKING_CONTINUATION_POLICIES,
  WORKING_SCOPE_KINDS,
  TRUSTED_HOST_MUTATION_SOURCES,
  WORKING_SET_STATUSES,
};

/**
 * Union of all supported working-set statuses.
 */
export type WorkingSetStatus = (typeof WORKING_SET_STATUSES)[number];

/**
 * Union of statuses that accept normal update operations.
 */
export type OpenWorkingSetStatus = (typeof OPEN_WORKING_SET_STATUSES)[number];

/**
 * Union of statuses selectable as the current scoped goal.
 */
export type CurrentWorkingSetStatus = (typeof CURRENT_WORKING_SET_STATUSES)[number];

/**
 * Union of canonical working-scope kinds.
 */
export type WorkingScopeKind = (typeof WORKING_SCOPE_KINDS)[number];

/** Returns true when a scope kind belongs to the goal working-set layer. */
export function isGoalScopeKind(scopeKind: WorkingScopeKind): boolean {
  return GOAL_WORKING_SCOPE_KINDS.includes(scopeKind as (typeof GOAL_WORKING_SCOPE_KINDS)[number]);
}

/**
 * Union of supported working-memory tool actions.
 */
export type AgenrWorkAction = (typeof AGENR_WORK_ACTIONS)[number];

/**
 * Union of actors that can mutate a working set.
 */
export type AgenrWorkMutationActor = (typeof AGENR_WORK_MUTATION_ACTORS)[number];

/**
 * Union of surfaces that can emit working-memory mutations.
 */
export type AgenrWorkMutationSource = (typeof AGENR_WORK_MUTATION_SOURCES)[number];

/**
 * Union of trusted host surfaces that may close working sets and default revision.
 */
export type TrustedHostMutationSource = (typeof TRUSTED_HOST_MUTATION_SOURCES)[number];

/**
 * Union of candidate promotion states.
 */
export type WorkingCandidatePromotionStatus = (typeof WORKING_CANDIDATE_PROMOTION_STATUSES)[number];

/**
 * Union of host continuation policies.
 */
export type WorkingContinuationPolicy = (typeof WORKING_CONTINUATION_POLICIES)[number];

/**
 * Union of budget dimensions that can stop continuation.
 */
export type WorkingBudgetLimitReason = (typeof WORKING_BUDGET_LIMIT_REASONS)[number];

/** Returns true for statuses that accept normal update operations. */
export function isMutableWorkingSetStatus(status: WorkingSetStatus): boolean {
  return OPEN_WORKING_SET_STATUSES.includes(status as OpenWorkingSetStatus);
}

/** Returns true for statuses selectable as the current scoped goal. */
export function isCurrentWorkingSetStatus(status: WorkingSetStatus): boolean {
  return CURRENT_WORKING_SET_STATUSES.includes(status as CurrentWorkingSetStatus);
}

/** Returns true for statuses that must be reached through agenr_work close. */
export function isCloseManagedStatus(status: WorkingSetStatus): boolean {
  return CLOSE_MANAGED_WORKING_SET_STATUSES.includes(status as (typeof CLOSE_MANAGED_WORKING_SET_STATUSES)[number]);
}

/**
 * Returns true when a mutation source is a trusted host surface.
 *
 * @param source - Runtime surface that emitted the mutation.
 */
export function isTrustedHostMutationSource(source: AgenrWorkMutationSource | undefined): source is TrustedHostMutationSource {
  return source !== undefined && TRUSTED_HOST_MUTATION_SOURCES.includes(source as TrustedHostMutationSource);
}
