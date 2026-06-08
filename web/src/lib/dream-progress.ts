import type { DreamJobEvent } from "../api/types";
import { formatIssueKind, titleCase } from "./format";

type DreamProgress = NonNullable<DreamJobEvent["progress"]>;
type DreamPhaseProgress = Extract<DreamProgress, { kind: "phase" }>;
type ReconcileProgress = Extract<DreamProgress, { kind: "reconcile_progress" }>;
type ProposalResolutionProgress = Extract<DreamProgress, { kind: "proposal_resolution_progress" }>;

/** A human-readable stage label and message for one job event. */
export interface ProgressLine {
  /** Short stage label shown in the feed gutter. */
  stage: string;
  /** Descriptive message for the event. */
  message: string;
}

/**
 * Describes one dreaming job event as a feed line.
 *
 * Translates the structured progress union and lifecycle status events into a
 * compact stage and message the live feed renders, so operators read run
 * progress without parsing raw JSON.
 *
 * @param event - One streamed job event.
 * @returns A stage label and message.
 */
export function describeEvent(event: DreamJobEvent): ProgressLine {
  if (event.kind === "status") {
    return describeStatusEvent(event);
  }

  const progress = event.progress;
  if (!progress) {
    return { stage: "progress", message: "Received a progress update." };
  }

  if (progress.kind === "phase") {
    return describePhaseEvent(progress);
  }

  if (progress.kind === "reconcile_progress") {
    return describeReconcileEvent(progress);
  }

  if (progress.kind === "proposal_resolution_progress") {
    return describeProposalResolutionEvent(progress);
  }

  return { stage: "progress", message: JSON.stringify(progress) };
}

/** Formats terminal job status events for the live feed. */
function describeStatusEvent(event: DreamJobEvent): ProgressLine {
  switch (event.status) {
    case "running":
      return { stage: "status", message: event.message ?? "Run is active." };
    case "completed":
      return { stage: "complete", message: event.message ?? "Run completed and history is refreshing." };
    case "failed":
      return { stage: "failed", message: event.message ?? "Run failed. Open the run details for the recorded error." };
    case "aborted":
      return { stage: "cancelled", message: event.message ?? "Run was cancelled by the operator." };
    default:
      return { stage: "status", message: event.message ?? "Received a status update." };
  }
}

/** Formats high-level run phase events for the live feed. */
function describePhaseEvent(progress: DreamPhaseProgress): ProgressLine {
  const mode = progress.apply ? "apply" : "dry-run";
  const tier = titleCase(progress.tier);

  switch (progress.phase) {
    case "start":
      return { stage: "start", message: `Created ${tier} ${mode} run and initialized progress tracking.` };
    case "backup_start":
      return { stage: "backup", message: "Creating a database backup before applying corpus changes." };
    case "backup_complete":
      return {
        stage: "backup",
        message: progress.backupPath ? `Backup complete. Saved database copy to ${progress.backupPath}.` : "Backup complete.",
      };
    case "load_working_set_start":
      return { stage: "load", message: "Loading candidate memories and proposal backlog for this run." };
    case "load_working_set_complete": {
      const parts = [`Loaded ${formatCount(progress.workingSetSize, "candidate memory", "candidate memories")}`];
      if (typeof progress.eligibleProposalBacklogCount === "number") {
        parts.push(`${formatCount(progress.eligibleProposalBacklogCount, "eligible proposal", "eligible proposals")} ready for resolution`);
      }
      return { stage: "load", message: `${parts.join("; ")}.` };
    }
    case "load_pass_context_start":
      return { stage: "context", message: "Loading claim-key health, trusted families, and pass context." };
    case "load_pass_context_complete":
      return { stage: "context", message: "Pass context loaded." };
    case "pass_start":
      return { stage: "pass", message: `Starting the ${tier} reconcile pass in ${mode} mode.` };
    default:
      return { stage: "phase", message: titleCase(progress.phase) };
  }
}

/** Formats deterministic reconcile progress for the live feed. */
function describeReconcileEvent(progress: ReconcileProgress): ProgressLine {
  const stage = formatReconcileStage(progress.stage);
  const totalText = `${progress.completed.toLocaleString()}/${progress.total.toLocaleString()} ${progress.unitLabel}`;
  const details = [`${formatReconcileStatus(progress.status)} ${totalText}`];

  if (typeof progress.previewQueued === "number" && progress.previewQueued > 0) {
    details.push(`${progress.previewQueued.toLocaleString()} queued for LLM preview`);
  }
  if (typeof progress.previewCompleted === "number" && typeof progress.previewTotal === "number" && progress.previewTotal > 0) {
    details.push(`${progress.previewCompleted.toLocaleString()}/${progress.previewTotal.toLocaleString()} previews completed`);
  }
  const totals = summarizeRepairCounts(progress.counts);
  if (totals.applied > 0 || totals.proposed > 0 || totals.skipped > 0) {
    details.push(`${totals.applied.toLocaleString()} applied, ${totals.proposed.toLocaleString()} proposed, ${totals.skipped.toLocaleString()} skipped`);
  }

  return { stage: "reconcile", message: `${stage}: ${details.join("; ")}.` };
}

/** Formats proposal-resolution progress for the live feed. */
function describeProposalResolutionEvent(progress: ProposalResolutionProgress): ProgressLine {
  if (progress.status === "no_work") {
    return { stage: "proposals", message: "No eligible proposals were ready to resolve." };
  }
  if (progress.status === "stalled") {
    return { stage: "proposals", message: "Proposal resolution stalled before all targeted entries were processed." };
  }

  const parts = [
    `${formatProposalStatus(progress.status)} ${progress.processedProposals.toLocaleString()}/${progress.totalProposals.toLocaleString()} proposals`,
    `${progress.appliedCount.toLocaleString()} applied`,
    `${progress.rejectedInactiveCount.toLocaleString()} inactive`,
    `${progress.rejectedInvalidCount.toLocaleString()} invalid`,
    `${progress.noChangeCount.toLocaleString()} unchanged`,
  ];
  if (progress.issueKind) {
    parts.push(`current issue ${formatIssueKind(progress.issueKind)}`);
  }
  if (progress.outcome) {
    parts.push(`last outcome ${titleCase(progress.outcome)}`);
  }

  return { stage: "proposals", message: `${parts.join("; ")}.` };
}

/** Formats a count with singular/plural labels. */
function formatCount(value: number | undefined, singular: string, plural: string): string {
  if (typeof value !== "number") {
    return `an unknown number of ${plural}`;
  }
  return `${value.toLocaleString()} ${value === 1 ? singular : plural}`;
}

/** Formats reconcile stage identifiers for operators. */
function formatReconcileStage(stage: string): string {
  switch (stage) {
    case "health":
      return "Claim-key health scan";
    case "invalid_noncanonical":
      return "Invalid noncanonical keys";
    case "missing":
      return "Missing claim keys";
    case "suspect_canonical":
      return "Suspect canonical keys";
    case "entity_family_convergence":
      return "Entity-family convergence";
    case "claim_key_alias_convergence":
      return "Claim-key alias convergence";
    case "mixed_key_groups":
      return "Mixed key groups";
    default:
      return titleCase(stage);
  }
}

/** Formats reconcile lifecycle status identifiers for operators. */
function formatReconcileStatus(status: string): string {
  switch (status) {
    case "snapshot":
      return "Snapshot";
    case "started":
      return "Started";
    case "preview_progress":
      return "Previewing";
    case "progress":
      return "Processing";
    case "completed":
      return "Completed";
    default:
      return titleCase(status);
  }
}

/** Formats proposal lifecycle status identifiers for operators. */
function formatProposalStatus(status: string): string {
  switch (status) {
    case "started":
      return "Started";
    case "proposal_processed":
      return "Processed";
    case "completed":
      return "Completed";
    default:
      return titleCase(status);
  }
}

/** Summarizes detailed reconcile counters for compact operator logging. */
function summarizeRepairCounts(counts: ReconcileProgress["counts"]): {
  applied: number;
  proposed: number;
  skipped: number;
} {
  return {
    applied:
      counts.appliedNormalizations +
      counts.appliedBackfills +
      counts.appliedMetadataRewrites +
      counts.appliedEntityFamilyConvergences +
      counts.appliedAliasConvergences,
    proposed: counts.proposalsEmitted + counts.flaggedAmbiguousProposals,
    skipped: counts.skippedNoClaim + counts.skippedLowConfidence + counts.skippedCollision,
  };
}
