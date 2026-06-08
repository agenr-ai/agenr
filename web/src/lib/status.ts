import type { Status } from "../components/primitives";
import type { Durable, DreamJobStatus, DreamRunStatus } from "../api/types";

/**
 * Maps a persisted dreaming run status to a badge variant.
 *
 * @param status - Run status.
 * @returns Semantic status variant.
 */
export function runStatusVariant(status: DreamRunStatus): Status {
  switch (status) {
    case "completed":
      return "success";
    case "running":
      return "accent";
    case "failed":
    case "stalled":
      return "danger";
    case "aborted":
    case "budget_exhausted":
    case "cost_capped":
      return "warning";
    case "no_work":
      return "neutral";
    default:
      return "neutral";
  }
}

/**
 * Maps a live job status to a badge variant.
 *
 * @param status - Job status.
 * @returns Semantic status variant.
 */
export function jobStatusVariant(status: DreamJobStatus): Status {
  switch (status) {
    case "completed":
      return "success";
    case "running":
      return "accent";
    case "failed":
      return "danger";
    case "aborted":
      return "warning";
    default:
      return "neutral";
  }
}

/** Lifecycle state derived from durable timestamps. */
export type DurableState = "active" | "stale" | "superseded";

/**
 * Derives a durable's lifecycle state from its supersession and valid window.
 *
 * @param durable - Durable to classify.
 * @returns The derived lifecycle state.
 */
export function durableState(durable: Durable): DurableState {
  if (durable.superseded_by) {
    return "superseded";
  }
  if (durable.valid_to && Date.parse(durable.valid_to) <= Date.now()) {
    return "stale";
  }
  return "active";
}

/**
 * Maps a durable lifecycle state to a badge variant.
 *
 * @param state - Lifecycle state.
 * @returns Semantic status variant.
 */
export function durableStateVariant(state: DurableState): Status {
  switch (state) {
    case "active":
      return "success";
    case "stale":
      return "warning";
    case "superseded":
      return "neutral";
    default:
      return "neutral";
  }
}

/**
 * Maps a claim-key lifecycle status to a badge variant.
 *
 * @param status - Claim-key status string.
 * @returns Semantic status variant.
 */
export function claimStatusVariant(status: string | undefined): Status {
  switch (status) {
    case "trusted":
      return "success";
    case "tentative":
      return "warning";
    case "unresolved":
      return "danger";
    default:
      return "neutral";
  }
}
