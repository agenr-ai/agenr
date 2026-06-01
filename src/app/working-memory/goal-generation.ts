import type { WorkingSnapshot } from "./snapshot.js";

/** Initial goal generation assigned when a working set is created. */
const INITIAL_GOAL_GENERATION = 1;

export { INITIAL_GOAL_GENERATION };

/**
 * Reads the current goal generation from one snapshot, defaulting to the initial value.
 *
 * @param snapshot - Working snapshot that may carry goal generation.
 * @returns Monotonic goal generation counter.
 */
export function readGoalGeneration(snapshot: WorkingSnapshot | undefined): number {
  return snapshot?.goalGeneration ?? INITIAL_GOAL_GENERATION;
}

/**
 * Returns the next goal generation after applying one objective write.
 *
 * @param snapshot - Snapshot before the objective write.
 * @param nextObjective - Objective text being applied.
 * @returns Unchanged generation when the objective is identical, otherwise current + 1.
 */
export function nextGoalGenerationAfterObjectiveChange(snapshot: WorkingSnapshot, nextObjective: string): number {
  if (snapshot.objective === nextObjective) {
    return readGoalGeneration(snapshot);
  }

  return readGoalGeneration(snapshot) + 1;
}
