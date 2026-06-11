import { truncateUtf8ToMaxBytes, utf8ByteLength } from "./limits.js";
import type { WorkingSnapshot } from "./snapshot.js";

/** Maximum UTF-8 byte length of one rendered close distillation. */
const WORKING_CLOSE_DISTILLATION_MAX_BYTES = 4096;

export { WORKING_CLOSE_DISTILLATION_MAX_BYTES };

/**
 * Renders a closing working snapshot into a compact plain-text distillation.
 *
 * The output is intended as curated, high-signal input for goal-close episode
 * generation: objective, final checkpoint, plan state, decisions, assumptions,
 * and blockers. Sections without content are omitted.
 *
 * @param snapshot - Final snapshot persisted by working-set close.
 * @returns Bounded distillation text, or undefined when the snapshot has no
 *   material content to distill.
 */
export function renderWorkingSnapshotDistillation(snapshot: WorkingSnapshot): string | undefined {
  const lines: string[] = [];

  appendLine(lines, "Objective", snapshot.objective);
  appendLine(lines, "Status summary", snapshot.summary);
  appendLine(lines, "Final checkpoint", snapshot.checkpoint?.summary);
  appendList(lines, "Plan", snapshot.currentPlan);
  appendList(lines, "Completed steps", snapshot.completedSteps);
  appendList(
    lines,
    "Next actions",
    snapshot.nextActions?.map((action) => (action.status ? `${action.text} (${action.status})` : action.text)),
  );
  appendList(
    lines,
    "Decisions",
    snapshot.decisions?.map((note) => (note.rationale ? `${note.decision} (rationale: ${note.rationale})` : note.decision)),
  );
  appendList(
    lines,
    "Assumptions",
    snapshot.assumptions?.map((note) => {
      const qualifiers = [
        ...(note.confidence ? [`confidence: ${note.confidence}`] : []),
        ...(note.validated === undefined ? [] : [note.validated ? "validated" : "unvalidated"]),
      ];
      return qualifiers.length > 0 ? `${note.assumption} (${qualifiers.join(", ")})` : note.assumption;
    }),
  );
  appendList(lines, "Blockers", snapshot.blockers);

  if (lines.length === 0) {
    return undefined;
  }

  const rendered = lines.join("\n");
  if (utf8ByteLength(rendered) <= WORKING_CLOSE_DISTILLATION_MAX_BYTES) {
    return rendered;
  }

  return truncateUtf8ToMaxBytes(rendered, WORKING_CLOSE_DISTILLATION_MAX_BYTES);
}

/** Appends one labeled single-line section when the value is non-empty. */
function appendLine(lines: string[], label: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (!trimmed) {
    return;
  }

  lines.push(`${label}: ${trimmed}`);
}

/** Appends one labeled bullet-list section when at least one item is non-empty. */
function appendList(lines: string[], label: string, items: string[] | undefined): void {
  const filtered = (items ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
  if (filtered.length === 0) {
    return;
  }

  lines.push(`${label}:`);
  for (const item of filtered) {
    lines.push(`- ${item}`);
  }
}
