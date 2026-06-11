/**
 * Persistence port for reviewable procedure proposals.
 *
 * Proposals are produced by the working-memory consolidation job from
 * procedural candidates and reviewed through the procedures pipeline.
 */

/** Ordered list of procedure-proposal review statuses. */
const PROCEDURE_PROPOSAL_STATUSES = ["open", "applying", "applied", "rejected"] as const;

export { PROCEDURE_PROPOSAL_STATUSES };

/** Union of procedure-proposal review statuses. */
export type ProcedureProposalStatus = (typeof PROCEDURE_PROPOSAL_STATUSES)[number];

/** One persisted reviewable procedure proposal. */
export interface ProcedureProposalRecord {
  /** Primary key. */
  id: string;
  /** Closed working set that produced the procedural candidate. */
  workingSetId: string;
  /** Stable candidate fingerprint used for idempotent consolidation re-runs. */
  candidateFingerprint: string;
  /** Suggested procedure subject. */
  subject: string;
  /** Suggested procedure content. */
  content: string;
  /** Working-event sequence numbers that support the candidate. */
  evidenceEventSequences: number[];
  /** Optional compact source reference from the candidate provenance. */
  sourceRef?: string;
  /** Review lifecycle status. */
  status: ProcedureProposalStatus;
  /** Reviewer-provided reason recorded at review time. */
  reviewReason?: string;
  /** Review timestamp for terminal statuses. */
  reviewedAt?: string;
  /** Relative procedure YAML path written when the proposal was applied. */
  appliedProcedurePath?: string;
  /** Creation timestamp. */
  createdAt: string;
}

/** Input used to persist one open procedure proposal. */
export interface CreateProcedureProposalInput {
  /** Closed working set that produced the candidate. */
  workingSetId: string;
  /** Stable candidate fingerprint used for idempotency. */
  candidateFingerprint: string;
  /** Suggested procedure subject. */
  subject: string;
  /** Suggested procedure content. */
  content: string;
  /** Working-event sequence numbers that support the candidate. */
  evidenceEventSequences: number[];
  /** Optional compact source reference. */
  sourceRef?: string;
  /** Timestamp to use for row creation. */
  now: string;
}

/** Input used to settle one open procedure proposal. */
export interface ReviewProcedureProposalInput {
  /** Proposal id to settle. */
  proposalId: string;
  /** Terminal review decision. */
  decision: Extract<ProcedureProposalStatus, "applied" | "rejected">;
  /** Required reviewer reason. */
  reason: string;
  /** Relative procedure YAML path written on apply. */
  appliedProcedurePath?: string;
  /** Timestamp to use for the review write. */
  now: string;
}

/** Input used to claim one open proposal for external apply side effects. */
export interface ClaimProcedureProposalApplyInput {
  /** Proposal id to claim. */
  proposalId: string;
}

/** Input used to finalize one claimed proposal after external apply succeeds. */
export interface CompleteProcedureProposalApplyInput {
  /** Proposal id to finalize. */
  proposalId: string;
  /** Required reviewer reason. */
  reason: string;
  /** Relative procedure YAML path written by the apply step. */
  appliedProcedurePath: string;
  /** Timestamp to use for the review write. */
  now: string;
}

/** Input used to release a failed apply claim back to open review. */
export interface ReleaseProcedureProposalApplyInput {
  /** Proposal id to release. */
  proposalId: string;
}

/** Failure returned when a proposal review cannot apply. */
export type ProcedureProposalReviewFailure = { kind: "not_found" } | { kind: "already_reviewed"; status: ProcedureProposalStatus };

/** Repository response for proposal review writes. */
export type ProcedureProposalReviewResult = { proposal: ProcedureProposalRecord } | ProcedureProposalReviewFailure;

/** Returns true when a proposal review result is a failure. */
export function isProcedureProposalReviewFailure(result: ProcedureProposalReviewResult): result is ProcedureProposalReviewFailure {
  return "kind" in result;
}

/** Filter accepted by proposal list queries. */
export interface ProcedureProposalListFilter {
  /** Optional explicit statuses to include. */
  statuses?: ProcedureProposalStatus[];
  /** Maximum number of rows to return. */
  limit?: number;
}

/** Persistence port for procedure proposals. */
export interface ProcedureProposalRepository {
  /**
   * Loads one proposal by id.
   *
   * @param id - Proposal identifier.
   * @returns Stored proposal, or null when it does not exist.
   */
  getProposal(id: string): Promise<ProcedureProposalRecord | null>;

  /**
   * Lists proposals for review surfaces, newest first.
   *
   * @param filter - Optional status and limit filters.
   * @returns Matching proposals ordered by recency.
   */
  listProposals(filter: ProcedureProposalListFilter): Promise<ProcedureProposalRecord[]>;

  /**
   * Finds one proposal by its idempotency key.
   *
   * @param workingSetId - Closed working set that produced the candidate.
   * @param candidateFingerprint - Stable candidate fingerprint.
   * @returns Stored proposal, or null when none exists.
   */
  findProposalByFingerprint(workingSetId: string, candidateFingerprint: string): Promise<ProcedureProposalRecord | null>;

  /**
   * Lists working-set ids that still have open procedure proposals.
   *
   * @param workingSetIds - Candidate working-set ids to check.
   * @returns Matching ids that should block retention reaping.
   */
  listOpenProposalWorkingSetIds(workingSetIds: string[]): Promise<Set<string>>;

  /**
   * Persists one open proposal.
   *
   * @param input - Proposal content and provenance.
   * @returns Persisted proposal row.
   */
  createProposal(input: CreateProcedureProposalInput): Promise<ProcedureProposalRecord>;

  /**
   * Claims one open proposal for external apply side effects.
   *
   * @param input - Proposal id and claim timestamp.
   * @returns Claimed proposal, or a stable review failure.
   */
  claimApply(input: ClaimProcedureProposalApplyInput): Promise<ProcedureProposalReviewResult>;

  /**
   * Finalizes one claimed proposal after external apply side effects succeed.
   *
   * @param input - Proposal id, reason, applied path, and timestamp.
   * @returns Applied proposal, or a stable review failure.
   */
  completeApply(input: CompleteProcedureProposalApplyInput): Promise<ProcedureProposalReviewResult>;

  /**
   * Releases a failed apply claim so the proposal can be retried.
   *
   * @param input - Proposal id to release.
   */
  releaseApply(input: ReleaseProcedureProposalApplyInput): Promise<void>;

  /**
   * Settles one open proposal with a terminal review decision.
   *
   * @param input - Decision, reason, and optional applied path.
   * @returns Updated proposal, or a stable review failure.
   */
  reviewProposal(input: ReviewProcedureProposalInput): Promise<ProcedureProposalReviewResult>;
}
