import type { WorkingBudgetLimitReason, WorkingCandidatePromotionStatus, WorkingContinuationPolicy } from "./constants.js";
import { normalizeBoundedUnique, truncateUtf8ToMaxBytes, WORKING_SCRATCHPAD_MAX_BYTES, WORKING_SNAPSHOT_ARRAY_LIMITS } from "./limits.js";

/**
 * One next action in a working snapshot.
 */
export interface WorkingNextAction {
  /** Human-readable action text. */
  text: string;
  /** Current action status. */
  status?: "pending" | "in_progress" | "blocked" | "done";
  /** Optional reference to a file, issue, or event. */
  ref?: string;
}

/**
 * Checkpoint payload used before handoff, compaction, fork, or shutdown.
 */
export interface WorkingCheckpoint {
  /** Compact summary of current progress. */
  summary: string;
  /** ISO timestamp when the checkpoint was recorded. */
  recordedAt: string;
  /** Expected next actions after the checkpoint. */
  nextActions?: string[];
  /** Known blockers at checkpoint time. */
  blockers?: string[];
}

/**
 * File observation attached to a working set.
 */
export interface WorkingFileNote {
  /** File path as observed by the host or model. */
  path: string;
  /** Optional note about why the file matters. */
  note?: string;
  /** ISO timestamp when the observation was made. */
  observedAt?: string;
}

/**
 * Command observation attached to a working set.
 */
export interface WorkingCommandNote {
  /** Command text. */
  command: string;
  /** Compact observed outcome. */
  outcome?: string;
  /** ISO timestamp when the command was observed. */
  observedAt?: string;
}

/**
 * Decision note attached to a working set.
 */
export interface WorkingDecisionNote {
  /** Decision text. */
  decision: string;
  /** Optional rationale. */
  rationale?: string;
  /** ISO timestamp when the decision was made. */
  decidedAt?: string;
}

/**
 * Assumption note attached to a working set.
 */
export interface WorkingAssumptionNote {
  /** Assumption text. */
  assumption: string;
  /** Confidence in the assumption. */
  confidence?: "low" | "medium" | "high";
  /** Whether the assumption has been validated. */
  validated?: boolean;
}

/**
 * Continuation state stored for future host-side schedulers.
 */
export interface WorkingContinuationState {
  /** Host continuation policy. */
  policy?: WorkingContinuationPolicy;
  /** ISO timestamp after which the host may resume. */
  resumeAfter?: string;
  /** ISO timestamp after which context should be treated as stale. */
  staleAfter?: string;
  /** Reason continuation is currently stopped. */
  stopReason?: string;
}

/**
 * Budget state stored for future host-side schedulers.
 */
export interface WorkingBudgetState {
  /** Token budget assigned by the host. */
  tokenBudget?: number;
  /** Tokens used so far according to the host. */
  tokenUsed?: number;
  /** Wall-clock budget in seconds. */
  wallClockBudgetSeconds?: number;
  /** Wall-clock seconds used so far according to the host. */
  wallClockUsedSeconds?: number;
  /** Maximum continuation turns allowed by the host. */
  turnBudget?: number;
  /** Continuation turns used so far according to the host. */
  turnsUsed?: number;
  /** Review interval in seconds before the host should pause for user review. */
  requireReviewAfterSeconds?: number;
  /** ISO timestamp when review becomes due. */
  reviewDueAt?: string;
  /** Budget dimension that most recently limited continuation. */
  limitReason?: WorkingBudgetLimitReason;
  /** ISO timestamp when a budget limit was reached. */
  limitedAt?: string;
}

/**
 * Delta supplied by host accounting hooks after a goal turn or tool result.
 */
export interface WorkingUsageDelta {
  /** Additional tokens consumed since the last accounting write. */
  tokenDelta?: number;
  /** Additional wall-clock seconds consumed since the last accounting write. */
  wallClockSecondsDelta?: number;
  /** Additional continuation turns consumed since the last accounting write. */
  turnDelta?: number;
  /** ISO timestamp when the host recorded this accounting update. */
  recordedAt?: string;
}

/**
 * Provenance for a memory candidate derived from working events.
 */
export interface CandidateProvenance {
  /** Working-event sequence numbers that support the candidate. */
  evidenceEventSequences: number[];
  /** Optional compact source reference. */
  sourceRef?: string;
  /** Optional reviewer note. */
  note?: string;
}

/**
 * Episode candidate emitted by close or consolidation.
 */
export interface WorkingEpisodicCandidate {
  /** Candidate discriminator. */
  kind: "episodic";
  /** Candidate episode summary. */
  summary: string;
  /** Event-level provenance for the candidate. */
  provenance: CandidateProvenance;
  /** Promotion lifecycle state. */
  promotionStatus: WorkingCandidatePromotionStatus;
}

/**
 * Semantic or procedural candidate emitted by close or consolidation.
 */
export interface WorkingDurableCandidate {
  /** Candidate discriminator. */
  kind: "semantic" | "procedural";
  /** Suggested durable subject or procedure name. */
  subject: string;
  /** Suggested durable content. */
  content: string;
  /** Optional suggested claim key for semantic promotion. */
  suggestedClaimKey?: string;
  /** Event-level provenance for the candidate. */
  provenance: CandidateProvenance;
  /** Promotion lifecycle state. */
  promotionStatus: WorkingCandidatePromotionStatus;
}

/**
 * Candidate emitted from a working set for later review.
 */
export type WorkingCandidate = WorkingEpisodicCandidate | WorkingDurableCandidate;

/**
 * Snapshot JSON stored for the active task state.
 *
 * This is the authoritative task-state payload. Row-level indexes may mirror
 * scope facts, but task content lives here only.
 */
export interface WorkingSnapshot {
  /** Monotonic goal identity generation; assigned on create and bumps on objective replace. */
  goalGeneration?: number;
  /** Current task objective. */
  objective?: string;
  /** Compact task-state summary. */
  summary?: string;
  /** Current ordered plan steps. */
  currentPlan?: string[];
  /** Next actions the agent or user expects. */
  nextActions?: WorkingNextAction[];
  /** Completed task steps. */
  completedSteps?: string[];
  /** Latest checkpoint for handoff or lifecycle transitions. */
  checkpoint?: WorkingCheckpoint;
  /** Freeform transient scratchpad for session or goal-local notes. */
  scratchpad?: string;
  /** File observations relevant to the active task. */
  files?: WorkingFileNote[];
  /** Command observations relevant to the active task. */
  commands?: WorkingCommandNote[];
  /** Decisions made during the active task. */
  decisions?: WorkingDecisionNote[];
  /** Assumptions that may need validation. */
  assumptions?: WorkingAssumptionNote[];
  /** Current blockers. */
  blockers?: string[];
  /** Candidate memories emitted from the working set. */
  candidates?: WorkingCandidate[];
  /** Continuation state stored for the host scheduler. */
  continuation?: WorkingContinuationState;
  /** Budget state stored for the host scheduler. */
  budgets?: WorkingBudgetState;
  /** ISO timestamp or short reason for the last material change. */
  lastMaterialChange?: string;
}

/**
 * Snapshot fields copied from a session working set when seeding a new goal.
 *
 * Goal-only fields such as `objective`, `goalGeneration`, and `summary` are
 * intentionally excluded. Update this list and `cloneForkableSnapshotFields`
 * together when the fork contract changes.
 */
const FORKABLE_SNAPSHOT_FIELD_KEYS = [
  "currentPlan",
  "nextActions",
  "checkpoint",
  "scratchpad",
  "files",
  "commands",
  "decisions",
  "assumptions",
] as const satisfies readonly (keyof WorkingSnapshot)[];

export { FORKABLE_SNAPSHOT_FIELD_KEYS };

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

/** Snapshot field keys copied when seeding a new goal from a session set. */
type ForkableSnapshotFieldKey = (typeof FORKABLE_SNAPSHOT_FIELD_KEYS)[number];

/** Forkable snapshot fields copied when seeding a new goal. */
type ForkableSnapshot = Pick<WorkingSnapshot, ForkableSnapshotFieldKey>;

/** Per-field cloners keyed by {@link FORKABLE_SNAPSHOT_FIELD_KEYS}. */
const FORKABLE_FIELD_CLONERS: {
  [K in ForkableSnapshotFieldKey]: (value: NonNullable<WorkingSnapshot[K]>) => NonNullable<WorkingSnapshot[K]>;
} = {
  currentPlan: (value) => [...value],
  nextActions: (value) => value.map((action) => ({ ...action })),
  checkpoint: (value) => ({
    ...value,
    ...(value.nextActions ? { nextActions: [...value.nextActions] } : {}),
    ...(value.blockers ? { blockers: [...value.blockers] } : {}),
  }),
  scratchpad: (value) => truncateUtf8ToMaxBytes(value, WORKING_SCRATCHPAD_MAX_BYTES),
  files: (value) => (normalizeBoundedUnique(value, WORKING_SNAPSHOT_ARRAY_LIMITS.files) ?? []).map((file) => ({ ...file })),
  commands: (value) => (normalizeBoundedUnique(value, WORKING_SNAPSHOT_ARRAY_LIMITS.commands) ?? []).map((command) => ({ ...command })),
  decisions: (value) => (normalizeBoundedUnique(value, WORKING_SNAPSHOT_ARRAY_LIMITS.decisions) ?? []).map((decision) => ({ ...decision })),
  assumptions: (value) => (normalizeBoundedUnique(value, WORKING_SNAPSHOT_ARRAY_LIMITS.assumptions) ?? []).map((assumption) => ({ ...assumption })),
};

/**
 * Copies one forkable field from a source snapshot into a target snapshot.
 *
 * @param target - Mutable forkable snapshot accumulator.
 * @param source - Source session snapshot.
 * @param key - Forkable field key to copy.
 */
function copyForkableField<K extends ForkableSnapshotFieldKey>(target: ForkableSnapshot, source: WorkingSnapshot, key: K): void {
  const value = source[key];
  if (value === undefined) {
    return;
  }

  target[key] = FORKABLE_FIELD_CLONERS[key](value);
}

/**
 * Shallow-copies {@link FORKABLE_SNAPSHOT_FIELD_KEYS} from one session snapshot.
 *
 * @param snapshot - Source session snapshot, when present.
 * @returns Forkable snapshot fields safe to merge into a new goal snapshot.
 */
export function cloneForkableSnapshotFields(snapshot: WorkingSnapshot | undefined): WorkingSnapshot {
  if (!snapshot) {
    return {};
  }

  const cloned: ForkableSnapshot = {};
  for (const key of FORKABLE_SNAPSHOT_FIELD_KEYS) {
    copyForkableField(cloned, snapshot, key);
  }

  return cloned;
}
