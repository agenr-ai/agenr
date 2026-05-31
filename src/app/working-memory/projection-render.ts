import type { WorkingContextProjection } from "./projection.js";
import type { WorkingSetRecord } from "./records.js";
import type { WorkingCandidate, WorkingNextAction } from "./snapshot.js";

const UTF8_BYTE_LENGTH = new TextEncoder();

/** Returns the UTF-8 byte length of one string. */
function byteLength(content: string): number {
  return UTF8_BYTE_LENGTH.encode(content).length;
}

/**
 * Reasons a working-context projection can be reduced to a stub.
 */
export type WorkingContextStubReason = "feature_disabled" | "missing_active_set" | "ambiguous_scope" | "misconfigured";

/**
 * Inputs used to build a conservative working-context stub projection.
 */
export interface WorkingContextStubProjectionInput {
  /** Reason the full working context is unavailable. */
  reason: WorkingContextStubReason;
  /** Stable provenance pointer for the projection decision. */
  sourceRef: string;
  /** Working set selected before rendering failed or degraded. */
  workingSetId?: string;
  /** Working-set revision selected before rendering failed or degraded. */
  revision?: number;
}

/**
 * Builds a non-persistent stub projection for host adapters.
 *
 * @param input - Stub reason and optional working-set provenance.
 * @returns A model-visible projection that carries no durable facts.
 */
export function createWorkingContextStubProjection(input: WorkingContextStubProjectionInput): WorkingContextProjection {
  const content = [
    "<agenr_work_context>",
    "Working memory is unavailable for this turn.",
    `Reason: ${input.reason}`,
    "Treat this as transient task-state metadata, not durable truth.",
    "</agenr_work_context>",
  ].join("\n");

  return {
    kind: "working_set",
    renderMode: "stub",
    content,
    ...(input.workingSetId ? { workingSetId: input.workingSetId } : {}),
    ...(input.revision !== undefined ? { revision: input.revision } : {}),
    sourceRef: input.sourceRef,
    byteLength: byteLength(content),
  };
}

/**
 * Builds a full non-persistent projection from one active working set.
 *
 * @param workingSet - Active set selected by scope resolution.
 * @param sourceRef - Stable provenance pointer for this render decision.
 * @returns Rendered transient working-context projection.
 */
export function createWorkingContextFullProjection(workingSet: WorkingSetRecord, sourceRef: string): WorkingContextProjection {
  const snapshot = workingSet.snapshot;
  const lines = [
    "<agenr_work_context>",
    "This is transient working memory for the current task, not durable truth.",
    "It may be stale or hypothetical. Prefer current filesystem, git, tests, tool output, and the user's latest message for current-state claims.",
    "",
    `Scope: ${escapeText(workingSet.scopeKind)} ${escapeText(workingSet.scopeKey)}`,
    `Working set: ${escapeText(workingSet.id)}`,
    `Revision: ${workingSet.revision}`,
    `Status: ${escapeText(workingSet.status)}`,
    ...optionalLine("Objective", snapshot.objective ?? workingSet.title),
    ...optionalLine("Summary", snapshot.summary),
    ...renderStringList("Current plan", snapshot.currentPlan),
    ...renderCheckpoint(snapshot.checkpoint?.summary),
    ...renderNextActions(snapshot.nextActions),
    ...renderLabeledNotes(
      "Touched files",
      snapshot.files,
      (file) => file.path.trim().length > 0,
      (file) => {
        const note = file.note ? ` - ${escapeText(file.note)}` : "";
        return `${escapeText(file.path)}${note}`;
      },
    ),
    ...renderLabeledNotes(
      "Recent commands",
      snapshot.commands,
      (command) => command.command.trim().length > 0,
      (command) => {
        const outcome = command.outcome ? ` - ${escapeText(command.outcome)}` : "";
        return `${escapeText(command.command)}${outcome}`;
      },
    ),
    ...renderLabeledNotes(
      "Decisions",
      snapshot.decisions,
      (decision) => decision.decision.trim().length > 0,
      (decision) => {
        const rationale = decision.rationale ? ` - ${escapeText(decision.rationale)}` : "";
        return `${escapeText(decision.decision)}${rationale}`;
      },
    ),
    ...renderLabeledNotes(
      "Assumptions",
      snapshot.assumptions,
      (assumption) => assumption.assumption.trim().length > 0,
      (assumption) => {
        const confidence = assumption.confidence ? ` [${assumption.confidence}]` : "";
        const validated = assumption.validated === true ? " (validated)" : assumption.validated === false ? " (unvalidated)" : "";
        return `${escapeText(assumption.assumption)}${confidence}${validated}`;
      },
    ),
    ...renderStringList("Blockers", snapshot.blockers),
    ...renderStringList("Open questions", snapshot.openQuestions),
    ...renderCandidates(snapshot.candidates),
    "",
    "Rules:",
    "- Update this working set when material task state changes.",
    "- Leave a checkpoint before pausing, handing off, compacting, forking, or waiting.",
    "- Do not close this working set; only the user clears goals with /goal clear.",
    "- Do not store transient WIP with agenr_store.",
    "- Promote only durable facts, decisions, preferences, or reusable procedures explicitly.",
    "</agenr_work_context>",
  ];
  const content = lines.join("\n");

  return {
    kind: "working_set",
    renderMode: "full",
    content,
    workingSetId: workingSet.id,
    revision: workingSet.revision,
    sourceRef,
    byteLength: byteLength(content),
  };
}

/** Escapes model-visible values inside the XML-like projection block. */
function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Renders an optional single-line field. */
function optionalLine(label: string, value: string | undefined): string[] {
  const normalized = value?.trim();
  return normalized ? [`${label}: ${escapeText(normalized)}`] : [];
}

/** Renders an optional string list section. */
function renderStringList(title: string, values: string[] | undefined): string[] {
  const items = (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
  if (items.length === 0) {
    return [];
  }

  return ["", `${title}:`, ...items.map((item) => `- ${escapeText(item)}`)];
}

/** Renders the latest checkpoint section. */
function renderCheckpoint(summary: string | undefined): string[] {
  const normalized = summary?.trim();
  return normalized ? ["", "Last checkpoint:", escapeText(normalized)] : [];
}

/** Renders a labeled note list section. */
function renderLabeledNotes<T>(title: string, items: T[] | undefined, isValid: (item: T) => boolean, formatLine: (item: T) => string): string[] {
  const filtered = (items ?? []).filter(isValid);
  if (filtered.length === 0) {
    return [];
  }

  return ["", `${title}:`, ...filtered.map((item) => `- ${formatLine(item)}`)];
}

/** Renders next actions with their optional status. */
function renderNextActions(actions: WorkingNextAction[] | undefined): string[] {
  const items = (actions ?? []).filter((action) => action.text.trim().length > 0);
  if (items.length === 0) {
    return [];
  }

  return [
    "",
    "Next actions:",
    ...items.map((action) => {
      const status = action.status ? ` [${action.status}]` : "";
      const ref = action.ref ? ` (${escapeText(action.ref)})` : "";
      return `- ${escapeText(action.text)}${status}${ref}`;
    }),
  ];
}

/** Renders pending candidate summaries without promoting them. */
function renderCandidates(candidates: WorkingCandidate[] | undefined): string[] {
  const pending = (candidates ?? []).filter((candidate) => candidate.promotionStatus === "pending");
  if (pending.length === 0) {
    return [];
  }

  return [
    "",
    "Pending memory candidates:",
    ...pending.map((candidate) => {
      if (candidate.kind === "episodic") {
        return `- episodic: ${escapeText(candidate.summary)}`;
      }

      return `- ${candidate.kind}: ${escapeText(candidate.subject)}`;
    }),
  ];
}
