import type { Expiry } from "../../types.js";

import type { DreamRunAction } from "./action-types.js";

/** Subject phrases that strongly suggest a status-artifact memory. */
const STATUS_ARTIFACT_SUBJECT_HINTS = ["session handoff", "status update", "progress snapshot", "session summary", "next steps", "in progress"] as const;

/**
 * Action types that suppress same-run retirement reconsideration.
 */
const SURGEON_RETIREMENT_SAME_RUN_SUPPRESSION_ACTION_TYPES: Array<Extract<DreamRunAction["actionType"], "skip" | "retire" | "update_durable">> = [
  "skip",
  "retire",
  "update_durable",
];

/**
 * Action types that mark a candidate as recently evaluated for later retirement runs.
 */
const SURGEON_RETIREMENT_RECENT_EVALUATION_ACTION_TYPES: Array<Extract<DreamRunAction["actionType"], "skip" | "retire" | "update_durable">> = [
  "skip",
  "retire",
  "update_durable",
];

export { SURGEON_RETIREMENT_RECENT_EVALUATION_ACTION_TYPES, SURGEON_RETIREMENT_SAME_RUN_SUPPRESSION_ACTION_TYPES };

/**
 * Minimal candidate fields used by retirement selection policy.
 */
export interface DreamRetirementPolicyCandidate {
  id: string;
  subject: string;
  type: string;
  importance: number;
  expiry: Expiry | string;
  recallCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Returns whether one candidate belongs to the high-yield actionable retirement scope.
 *
 * @param candidate - Candidate summary evaluated by retirement policy.
 * @returns True when the candidate belongs to the actionable subset.
 */
export function isActionableRetirementCandidate(candidate: Pick<DreamRetirementPolicyCandidate, "type" | "importance" | "expiry" | "recallCount">): boolean {
  return (
    candidate.expiry === "temporary" ||
    (candidate.type === "milestone" && (candidate.importance <= 6 || candidate.expiry === "permanent")) ||
    (candidate.type === "fact" && candidate.importance <= 5 && candidate.recallCount === 0)
  );
}

/**
 * Compares two retirement candidates using the current prioritization rules.
 *
 * @param left - Left candidate.
 * @param right - Right candidate.
 * @returns Sort comparator value.
 */
export function compareRetirementCandidates(left: DreamRetirementPolicyCandidate, right: DreamRetirementPolicyCandidate): number {
  const tierDelta = getRetirementCandidatePriorityTier(left) - getRetirementCandidatePriorityTier(right);
  if (tierDelta !== 0) {
    return tierDelta;
  }

  const leftNeverRecalled = left.recallCount === 0;
  const rightNeverRecalled = right.recallCount === 0;
  if (leftNeverRecalled !== rightNeverRecalled) {
    return leftNeverRecalled ? -1 : 1;
  }

  const createdDelta = parseTimestamp(left.createdAt) - parseTimestamp(right.createdAt);
  if (createdDelta !== 0) {
    return createdDelta;
  }

  if (left.importance !== right.importance) {
    return left.importance - right.importance;
  }

  const updatedDelta = left.updatedAt.localeCompare(right.updatedAt);
  if (updatedDelta !== 0) {
    return updatedDelta;
  }

  return left.id.localeCompare(right.id);
}

/**
 * Detects whether a subject looks like a status-artifact memory.
 *
 * @param subject - Candidate subject text.
 * @returns True when the subject matches status-artifact heuristics.
 */
export function looksLikeRetirementStatusArtifact(subject: string): boolean {
  const normalized = subject.trim().toLowerCase();
  return normalized.startsWith("handoff") || STATUS_ARTIFACT_SUBJECT_HINTS.some((hint) => normalized.includes(hint));
}

/**
 * Assigns the current retirement priority tier for one candidate.
 *
 * @param candidate - Candidate to classify.
 * @returns Tier number where lower values sort first.
 */
export function getRetirementCandidatePriorityTier(candidate: Pick<DreamRetirementPolicyCandidate, "subject" | "type" | "importance" | "expiry">): number {
  if (candidate.expiry === "temporary") {
    return 0;
  }

  if (candidate.type === "milestone" && candidate.importance <= 4) {
    return 1;
  }

  if (looksLikeRetirementStatusArtifact(candidate.subject)) {
    return 2;
  }

  return 3;
}

/**
 * Parses an ISO timestamp into a sortable numeric value.
 *
 * @param value - Timestamp text.
 * @returns Parsed timestamp or a max sentinel for invalid input.
 */
function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}
