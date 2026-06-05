/**
 * Supported dreaming action identifiers.
 */
export type DreamActionType = "retire" | "merge" | "log_conflict" | "resolve_conflict" | "update_durable" | "flag_review" | "skip";

/**
 * Snapshot of top recall results before or after a dreaming action.
 */
export interface RecallDeltaSnapshot {
  query: string;
  topResults: Array<{ durableId: string; subject: string; score: number }>;
}

/**
 * Audit log record for one action emitted during a dreaming run.
 */
export interface DreamRunAction {
  id: string;
  runId: string;
  actionType: DreamActionType;
  durableIds: string[];
  reasoning: string;
  recallDelta?: { before: RecallDeltaSnapshot; after: RecallDeltaSnapshot } | null;
  details?: Record<string, unknown> | null;
  createdAt: string;
}
