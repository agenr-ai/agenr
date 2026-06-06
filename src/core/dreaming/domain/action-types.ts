/**
 * Supported dreaming action identifiers.
 */
export type DreamActionType =
  | "stale"
  | "merge"
  | "log_conflict"
  | "resolve_conflict"
  | "update_durable"
  | "insert_durable"
  | "supersede_durable"
  | "flag_review"
  | "skip";

/**
 * Audit log record for one action emitted during a dreaming run.
 */
export interface DreamRunAction {
  id: string;
  runId: string;
  actionType: DreamActionType;
  durableIds: string[];
  reasoning: string;
  details?: Record<string, unknown> | null;
  createdAt: string;
}
