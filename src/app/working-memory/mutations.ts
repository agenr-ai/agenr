import type {
  AgenrWorkAction,
  AgenrWorkMutationActor,
  AgenrWorkMutationSource,
  TrustedHostMutationSource,
  WorkingContinuationPolicy,
  WorkingSetStatus,
} from "./constants.js";
import type { WorkingScope } from "./scope.js";
import type {
  WorkingCandidate,
  WorkingCheckpoint,
  WorkingFileNote,
  WorkingCommandNote,
  WorkingDecisionNote,
  WorkingAssumptionNote,
  WorkingNextAction,
  WorkingBudgetState,
  WorkingUsageDelta,
  WorkingSnapshot,
} from "./snapshot.js";

/** Working-set target selected by model, trusted host, or default resolution. */
export type AgenrWorkTarget = "auto" | "session" | "goal";

/** Explicit session or goal target without auto resolution. */
export type ExplicitWorkingSetTarget = Extract<AgenrWorkTarget, "session" | "goal">;

/**
 * Typed mutation operations accepted by the normal working-memory tool path.
 */
export type AgenrWorkUpdateOperation =
  | { type: "set_objective"; objective: string; title?: string }
  | { type: "replace_plan"; currentPlan: string[]; nextActions?: WorkingNextAction[] }
  | { type: "merge_checkpoint"; checkpoint: WorkingCheckpoint }
  | { type: "set_scratchpad"; scratchpad: string }
  | { type: "add_file_note"; file: WorkingFileNote }
  | { type: "add_command_note"; command: WorkingCommandNote }
  | { type: "record_decision"; decision: WorkingDecisionNote }
  | { type: "record_assumption"; assumption: WorkingAssumptionNote }
  | { type: "set_next_actions"; nextActions: WorkingNextAction[] }
  | { type: "set_status"; status: WorkingSetStatus }
  | { type: "add_candidate"; candidate: WorkingCandidate }
  | { type: "configure_budget"; budget: WorkingBudgetState }
  | { type: "account_usage"; usage: WorkingUsageDelta }
  | { type: "set_continuation_policy"; policy: WorkingContinuationPolicy; resumeAfter?: string; staleAfter?: string; stopReason?: string };

/** External goal mutation intents that require progress accounting first. */
export type WorkingExternalGoalMutationKind = "set" | "clear" | "pause" | "resume" | "compact" | "fork" | "handoff" | "scheduled_delay" | "shutdown" | "other";

/**
 * Envelope required for all working-memory mutations.
 */
export interface AgenrWorkMutationEnvelope {
  /** Granular operation to apply. */
  operation: AgenrWorkUpdateOperation;
  /** Revision the caller observed before mutating the set. */
  expectedRevision: number;
  /** Human-readable reason for audit and review. */
  updateReason: string;
  /** Actor that initiated the mutation. */
  actor?: AgenrWorkMutationActor;
  /** Runtime surface that emitted the mutation. */
  source?: AgenrWorkMutationSource;
}

/** Explicit terminal intent for close actions. */
export type AgenrWorkCloseMode = "close" | "abandon";

/**
 * Parameters accepted by the `agenr_work` tool.
 */
export interface AgenrWorkParams {
  /** Action to execute. */
  action: AgenrWorkAction;
  /** Working-set target when multiple active set kinds can exist. */
  target?: AgenrWorkTarget;
  /** Explicit working-set id when known. */
  workingSetId?: string;
  /** Raw scope facts supplied by the host. */
  scope?: Partial<WorkingScope>;
  /** Granular operation for `create` and `update`. */
  operation?: AgenrWorkUpdateOperation;
  /** Required observed revision for update and close operations. */
  expectedRevision?: number;
  /** Required audit reason for create and update operations. */
  updateReason?: string;
  /** Actor that initiated update or close. */
  actor?: AgenrWorkMutationActor;
  /** Runtime surface that emitted update or close. */
  source?: AgenrWorkMutationSource;
  /** Whether event details should be included in read responses. */
  includeEvents?: boolean;
  /** Maximum event count to include in read responses. */
  eventLimit?: number;
  /** Maximum working sets to return for list responses. */
  listLimit?: number;
  /** Optional working-set statuses to include in list responses. */
  statuses?: WorkingSetStatus[];
  /** Reason supplied when closing or abandoning a working set. */
  closeReason?: string;
  /** Explicit terminal intent for close actions. */
  closeMode?: AgenrWorkCloseMode;
  /** Whether close should request an episode when thresholds pass. */
  createEpisode?: boolean;
  /** Initial budget state supplied by a goal alias or host command. */
  initialBudget?: WorkingBudgetState;
  /** Initial continuation policy supplied by a trusted host command. */
  continuationPolicy?: WorkingContinuationPolicy;
  /** Internal initial snapshot fields copied from another working set. */
  initialSnapshot?: WorkingSnapshot;
}

/**
 * Trusted host request to account progress before mutating goal state externally.
 */
export interface PrepareExternalGoalMutationParams {
  /** External mutation that is about to run. */
  mutationKind: WorkingExternalGoalMutationKind;
  /** Working-set target when multiple active set kinds can exist. */
  target?: AgenrWorkTarget;
  /** Explicit working-set id when known. */
  workingSetId?: string;
  /** Raw scope facts supplied by the host. */
  scope?: Partial<WorkingScope>;
  /** Optional checkpoint to merge before the external mutation. */
  checkpoint?: WorkingCheckpoint;
  /** Optional usage delta to account before the external mutation. */
  usage?: WorkingUsageDelta;
  /** Whether an active goal must have a checkpoint before the mutation proceeds. */
  requireCheckpoint?: boolean;
  /** Actor that initiated the external mutation. */
  actor?: AgenrWorkMutationActor;
  /** Trusted host surface that emitted the mutation. */
  source: TrustedHostMutationSource;
  /** Optional audit reason used for generated accounting writes. */
  updateReason?: string;
}
