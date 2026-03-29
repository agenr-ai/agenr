/**
 * Lifecycle states for one surgeon run.
 */
export type SurgeonRunStatus = "running" | "completed" | "failed" | "aborted" | "budget_exhausted" | "cost_capped";

/**
 * Minimal persisted completion summary for a surgeon run.
 */
export interface SurgeonCompletionSummary {
  actions_taken: number;
  entries_skipped: Array<{
    entry_id?: string;
    reason: string;
  }>;
  observations: string[];
  recommendations: string[];
}
