import type { DreamJobEvent } from "../api/types";
import { titleCase } from "./format";

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
    return { stage: "status", message: event.message ?? titleCase(event.status ?? "update") };
  }

  const progress = toRecord(event.progress);
  const kind = typeof progress.kind === "string" ? progress.kind : "progress";

  if (kind === "phase") {
    const phase = typeof progress.phase === "string" ? progress.phase : "phase";
    const extras: string[] = [];
    if (typeof progress.workingSetSize === "number") {
      extras.push(`working set ${progress.workingSetSize}`);
    }
    if (typeof progress.backupPath === "string") {
      extras.push("backup saved");
    }
    return { stage: "phase", message: `${titleCase(phase)}${extras.length > 0 ? ` \u00b7 ${extras.join(", ")}` : ""}` };
  }

  if (kind === "reconcile_progress") {
    const stage = typeof progress.stage === "string" ? progress.stage : "reconcile";
    const status = typeof progress.status === "string" ? progress.status : "";
    const completed = numberOr(progress.completed, 0);
    const total = numberOr(progress.total, 0);
    const unit = typeof progress.unitLabel === "string" ? progress.unitLabel : "";
    return { stage: `reconcile`, message: `${titleCase(stage)} \u00b7 ${status} ${completed}/${total} ${unit}`.trim() };
  }

  if (kind === "proposal_resolution_progress") {
    const status = typeof progress.status === "string" ? progress.status : "";
    const processed = numberOr(progress.processedProposals, 0);
    const total = numberOr(progress.totalProposals, 0);
    const applied = numberOr(progress.appliedCount, 0);
    return { stage: "proposals", message: `${titleCase(status)} \u00b7 ${processed}/${total} processed, ${applied} applied` };
  }

  return { stage: kind, message: typeof progress.message === "string" ? progress.message : JSON.stringify(progress) };
}

/** Coerces an unknown value to a number with a fallback. */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Converts a structured progress union into a generic display record. */
function toRecord(value: DreamJobEvent["progress"]): Record<string, unknown> {
  return value ? Object.fromEntries(Object.entries(value)) : {};
}
