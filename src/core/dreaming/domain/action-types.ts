/**
 * Supported dreaming action identifiers.
 *
 * `merge` records one content-level duplicate exclusive-slot collapse: a
 * non-survivor durable superseded by the slot's canonical survivor.
 */
export type DreamActionType = "stale" | "merge" | "update_durable" | "insert_durable" | "supersede_durable" | "flag_review";

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
