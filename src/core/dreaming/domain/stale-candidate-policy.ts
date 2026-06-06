import type { Expiry } from "../../types.js";

import type { DreamRunAction } from "./action-types.js";

/** Subject phrases that strongly suggest a status-artifact memory. */
const STATUS_ARTIFACT_SUBJECT_HINTS = ["session handoff", "status update", "progress snapshot", "session summary", "next steps", "in progress"] as const;

/**
 * Action types that suppress same-run stale reconsideration.
 */
const DREAM_PRUNE_SAME_RUN_SUPPRESSION_ACTION_TYPES: Array<Extract<DreamRunAction["actionType"], "skip" | "stale" | "update_durable">> = [
  "skip",
  "stale",
  "update_durable",
];

/**
 * Action types that mark a candidate as recently evaluated for later stale runs.
 */
const DREAM_PRUNE_RECENT_EVALUATION_ACTION_TYPES: Array<Extract<DreamRunAction["actionType"], "skip" | "stale" | "update_durable">> = [
  "skip",
  "stale",
  "update_durable",
];

export { DREAM_PRUNE_RECENT_EVALUATION_ACTION_TYPES, DREAM_PRUNE_SAME_RUN_SUPPRESSION_ACTION_TYPES };

/**
 * Minimal candidate fields used by stale selection policy.
 */
export interface DreamStaleCandidatePolicyCandidate {
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
 * Returns whether one candidate belongs to the high-yield actionable stale scope.
 *
 * @param candidate - Candidate summary evaluated by stale policy.
 * @returns True when the candidate belongs to the actionable subset.
 */
export function isActionableStaleCandidate(candidate: Pick<DreamStaleCandidatePolicyCandidate, "type" | "importance" | "expiry" | "recallCount">): boolean {
  return (
    candidate.expiry === "temporary" ||
    (candidate.type === "milestone" && (candidate.importance <= 6 || candidate.expiry === "permanent")) ||
    (candidate.type === "fact" && candidate.importance <= 5 && candidate.recallCount === 0)
  );
}

/**
 * Compares two stale candidates using the current prioritization rules.
 *
 * @param left - Left candidate.
 * @param right - Right candidate.
 * @returns Sort comparator value.
 */
export function compareStaleCandidates(left: DreamStaleCandidatePolicyCandidate, right: DreamStaleCandidatePolicyCandidate): number {
  const tierDelta = getStaleCandidatePriorityTier(left) - getStaleCandidatePriorityTier(right);
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
export function looksLikeStaleStatusArtifact(subject: string): boolean {
  const normalized = subject.trim().toLowerCase();
  return normalized.startsWith("handoff") || STATUS_ARTIFACT_SUBJECT_HINTS.some((hint) => normalized.includes(hint));
}

/**
 * Assigns the current stale priority tier for one candidate.
 *
 * @param candidate - Candidate to classify.
 * @returns Tier number where lower values sort first.
 */
export function getStaleCandidatePriorityTier(candidate: Pick<DreamStaleCandidatePolicyCandidate, "subject" | "type" | "importance" | "expiry">): number {
  if (candidate.expiry === "temporary") {
    return 0;
  }

  if (candidate.type === "milestone" && candidate.importance <= 4) {
    return 1;
  }

  if (looksLikeStaleStatusArtifact(candidate.subject)) {
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
