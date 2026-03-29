/**
 * Supported surgeon action identifiers.
 */
export type SurgeonActionType = "retire" | "merge" | "log_conflict" | "resolve_conflict" | "update_entry" | "flag_review" | "skip";

/**
 * Snapshot of top recall results before or after a surgeon action.
 */
export interface RecallDeltaSnapshot {
  query: string;
  topResults: Array<{ entryId: string; subject: string; score: number }>;
}

/**
 * Audit log record for one action emitted during a surgeon run.
 */
export interface SurgeonRunAction {
  id: string;
  runId: string;
  actionType: SurgeonActionType;
  entryIds: string[];
  reasoning: string;
  recallDelta?: { before: RecallDeltaSnapshot; after: RecallDeltaSnapshot } | null;
  createdAt: string;
}
