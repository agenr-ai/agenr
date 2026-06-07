import { isGoalScopeKind, type WorkingScopeKind } from "./constants.js";
import type { WorkingSetRecord } from "./records.js";
import type { WorkingMemoryFailure } from "./results.js";
import type { WorkingSetListFilter } from "./repository.js";
import { createFailure } from "./results.js";
import type { AgenrWorkTarget, ExplicitWorkingSetTarget } from "./mutations.js";
import type { WorkingSetSelectionResult } from "./select-working-set.js";

const GOAL_WORKING_SETS_DISABLED_MESSAGE = "Goal working sets are disabled for this host." as const;

/** Host working-set exposure mode. */
export type HostWorkingSetMode = "session_and_goal" | "session_only";

/** Decision for rendering the goal section inside a working-context bundle. */
export type GoalBundleSectionDecision = { kind: "omit" } | { kind: "include"; workingSet: WorkingSetRecord } | { kind: "warn"; message: string };

/** Host policy governing session and goal working-set exposure. */
export interface HostWorkingSetPolicy {
  /** Whether goal working sets are exposed alongside session sets. */
  readonly mode: HostWorkingSetMode;
}

/**
 * Creates the host working-set policy used by selection, list, and run gates.
 *
 * @param goalWorkingSetsEnabled - Whether goal sets are exposed for the host.
 * @returns Canonical host policy object.
 */
export function createHostWorkingSetPolicy(goalWorkingSetsEnabled = true): HostWorkingSetPolicy {
  return {
    mode: goalWorkingSetsEnabled ? "session_and_goal" : "session_only",
  };
}

/** Returns true when goal working sets and goal-targeted mutations are enabled. */
export function goalsEnabled(policy: HostWorkingSetPolicy): boolean {
  return policy.mode === "session_and_goal";
}

/** Returns true when a request explicitly targets the goal working-set layer. */
export function requiresExplicitGoalTarget(target: AgenrWorkTarget | undefined): boolean {
  return target === "goal";
}

/** Returns true when bundle rendering should resolve a goal working set. */
export function shouldResolveGoalSelection(policy: HostWorkingSetPolicy): boolean {
  return goalsEnabled(policy);
}

/**
 * Builds a failure when a disabled host selects a goal working set.
 *
 * @param policy - Host working-set policy.
 * @param workingSet - Selected working set.
 */
export function validateSelectedWorkingSet(policy: HostWorkingSetPolicy, workingSet: Pick<WorkingSetRecord, "scopeKind">): WorkingMemoryFailure | undefined {
  return !goalsEnabled(policy) && isGoalScopeKind(workingSet.scopeKind) ? createFailure("invalid_request", GOAL_WORKING_SETS_DISABLED_MESSAGE) : undefined;
}

/**
 * Resolves how a goal selection should appear in a projection bundle.
 *
 * Session failures fail the bundle. Goal ambiguity renders as a warning section.
 * Missing goal sets are omitted quietly.
 *
 * @param policy - Host working-set policy.
 * @param selection - Goal working-set selection result, or null when goals are disabled.
 */
export function goalBundleSectionFromSelection(policy: HostWorkingSetPolicy, selection: WorkingSetSelectionResult | null): GoalBundleSectionDecision {
  if (!goalsEnabled(policy) || selection === null) {
    return { kind: "omit" };
  }

  if (selection.ok) {
    return { kind: "include", workingSet: selection.workingSet };
  }

  if (selection.code === "missing_active_set" || selection.code === "missing_scope") {
    return { kind: "omit" };
  }

  return { kind: "warn", message: selection.message };
}

/** Repository list filter fragment limiting output when goals are disabled. */
export function listFilter(policy: HostWorkingSetPolicy): Pick<WorkingSetListFilter, "scopeKinds"> {
  return goalsEnabled(policy) ? {} : { scopeKinds: ["session" satisfies WorkingScopeKind] };
}

/** Ordered layers attempted by auto selection. */
export function layersForAutoSelect(policy: HostWorkingSetPolicy): ExplicitWorkingSetTarget[] {
  return goalsEnabled(policy) ? ["goal", "session"] : ["session"];
}

/**
 * Layers included by list for one target selection.
 *
 * @param policy - Host working-set policy.
 * @param target - Requested working-set target.
 */
export function layersForList(policy: HostWorkingSetPolicy, target: AgenrWorkTarget | undefined): ExplicitWorkingSetTarget[] {
  if (target === "session") {
    return ["session"];
  }

  if (target === "goal") {
    return goalsEnabled(policy) ? ["goal"] : [];
  }

  const layers: ExplicitWorkingSetTarget[] = ["session"];
  if (goalsEnabled(policy)) {
    layers.push("goal");
  }

  return layers;
}

/** Stable failure when goal working sets are disabled. */
export function goalWorkingSetsDisabledFailure(): WorkingMemoryFailure {
  return createFailure("invalid_request", GOAL_WORKING_SETS_DISABLED_MESSAGE);
}

export { GOAL_WORKING_SETS_DISABLED_MESSAGE };
