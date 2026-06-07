import type { WorkingBudgetLimitReason, WorkingCandidatePromotionStatus, WorkingContinuationPolicy } from "./constants.js";

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
 * External reference attached to a working set.
 */
export interface WorkingReference {
  /** Display label for the reference. */
  label: string;
  /** Optional URI or stable identifier. */
  uri?: string;
  /** Reference kind. */
  kind?: "doc" | "issue" | "pr" | "url" | "entry" | "episode";
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
  /** Success criteria for the task. */
  successCriteria?: string[];
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
  /** Open questions that block or shape the task. */
  openQuestions?: string[];
  /** Current blockers. */
  blockers?: string[];
  /** External references used by the task. */
  references?: WorkingReference[];
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
