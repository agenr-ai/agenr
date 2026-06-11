import type { AgenrWorkCloseMode } from "./mutations.js";
import type { WorkingCandidate, WorkingCheckpoint, WorkingSnapshot } from "./snapshot.js";

/** Input used by deterministic working-set close handling. */
export interface BuildWorkingCloseSnapshotInput {
  /** Working-set id being closed. */
  workingSetId: string;
  /** Snapshot observed before close. */
  snapshot: WorkingSnapshot;
  /** Closing revision before the close event is appended. */
  currentRevision: number;
  /** Human-readable close reason. */
  closeReason: string;
  /** Whether the caller requests an episodic handoff candidate. */
  createEpisode?: boolean;
  /** Event sequences already recorded for the set. */
  eventSequences: number[];
  /** Timestamp used for the final checkpoint. */
  now: string;
}

/** Resolves the terminal status for a close request. */
export function resolveCloseTerminalStatus(closeMode: AgenrWorkCloseMode | undefined): "closed" | "abandoned" {
  return closeMode === "abandon" ? "abandoned" : "closed";
}

/** Deterministic close output persisted by the service. */
export interface WorkingCloseSnapshotResult {
  /** Final snapshot with a close checkpoint. */
  snapshot: WorkingSnapshot;
  /** Candidates retained or emitted by close. */
  candidates: WorkingCandidate[];
}

/**
 * Builds the deterministic final snapshot used by working-set close.
 *
 * @param input - Current snapshot, close reason, and provenance facts.
 * @returns Final snapshot plus candidate payloads for review.
 */
export function buildWorkingCloseSnapshot(input: BuildWorkingCloseSnapshotInput): WorkingCloseSnapshotResult {
  const finalCheckpoint = buildFinalCheckpoint(input);
  const candidates = [...(input.snapshot.candidates ?? [])];
  if (input.createEpisode && !candidates.some((candidate) => candidate.kind === "episodic")) {
    candidates.push({
      kind: "episodic",
      summary: finalCheckpoint.summary,
      provenance: {
        evidenceEventSequences: input.eventSequences,
        sourceRef: `working_set:${input.workingSetId}#rev:${input.currentRevision}`,
        note: input.closeReason,
      },
      promotionStatus: "pending",
    });
  }

  return {
    snapshot: {
      ...input.snapshot,
      checkpoint: finalCheckpoint,
      candidates: candidates.length > 0 ? candidates : undefined,
      lastMaterialChange: input.closeReason,
    },
    candidates,
  };
}

/** Builds a compact final checkpoint from the current snapshot. */
function buildFinalCheckpoint(input: BuildWorkingCloseSnapshotInput): WorkingCheckpoint {
  const summary = normalizeSummary(input.closeReason) ?? input.snapshot.summary ?? input.snapshot.objective ?? "Working set closed.";
  return {
    summary,
    recordedAt: input.now,
    ...(input.snapshot.nextActions && input.snapshot.nextActions.length > 0
      ? { nextActions: input.snapshot.nextActions.map((action) => action.text).filter((text) => text.trim().length > 0) }
      : {}),
    ...(input.snapshot.blockers && input.snapshot.blockers.length > 0 ? { blockers: input.snapshot.blockers } : {}),
  };
}

/** Normalizes a close reason into a usable checkpoint summary. */
function normalizeSummary(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
