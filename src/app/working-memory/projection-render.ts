import { truncateUtf8ToMaxBytes, utf8ByteLength, WORKING_CONTEXT_PROJECTION_MAX_BYTES } from "./limits.js";
import type { WorkingContextProjection } from "./projection.js";
import { WORKING_CONTEXT_SESSION_SECTION_LABEL } from "./projection-section-labels.js";
import type { WorkingSetRecord } from "./records.js";
import type { WorkingCandidate, WorkingNextAction } from "./snapshot.js";

/**
 * Reasons a working-context projection can be reduced to a stub.
 */
export type WorkingContextStubReason = "feature_disabled" | "missing_active_set" | "ambiguous_scope" | "misconfigured" | "selection_failed";

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
    byteLength: utf8ByteLength(content),
  };
}

/** One working-set section rendered into a projection. */
interface WorkingContextProjectionSection {
  /** Optional section heading for multi-set projections. */
  label?: string;
  /** Working set rendered into the section body. */
  workingSet: WorkingSetRecord;
}

/** Warning rendered into a projection when a companion section cannot load. */
interface WorkingContextProjectionWarningSection {
  /** Section heading for the warning. */
  label: string;
  /** Warning text rendered into the section body. */
  warning: string;
}

/** Projection entry rendered as either a working set or a warning section. */
type WorkingContextProjectionEntry = WorkingContextProjectionSection | WorkingContextProjectionWarningSection;

/**
 * Builds a full non-persistent projection from one active working set.
 *
 * @param workingSet - Active set selected by scope resolution.
 * @param sourceRef - Stable provenance pointer for this render decision.
 * @returns Rendered transient working-context projection.
 */
export function createWorkingContextFullProjection(workingSet: WorkingSetRecord, sourceRef: string): WorkingContextProjection {
  return createWorkingContextProjectionFromSections([{ workingSet }], sourceRef);
}

/**
 * Builds a full non-persistent projection from multiple active working sets.
 *
 * @param sections - Labeled working sets selected for injection.
 * @param sourceRef - Stable provenance pointer for this render decision.
 * @returns Rendered transient working-context projection.
 */
export function createWorkingContextMultiProjection(
  sections: Array<{ label: string; workingSet: WorkingSetRecord } | { label: string; warning: string }>,
  sourceRef: string,
): WorkingContextProjection {
  return createWorkingContextProjectionFromSections(sections, sourceRef);
}

/**
 * Builds a full non-persistent projection from one or more working-set sections.
 *
 * @param sections - Working sets to render, with optional section headings.
 * @param sourceRef - Stable provenance pointer for this render decision.
 * @returns Rendered transient working-context projection.
 */
function createWorkingContextProjectionFromSections(sections: WorkingContextProjectionEntry[], sourceRef: string): WorkingContextProjection {
  const auditProvenance = resolveAuditProvenance(sections);
  const lines = [
    "<agenr_work_context>",
    "This is transient working memory for the current task, not durable truth.",
    "It may be stale or hypothetical. Prefer current filesystem, git, tests, tool output, and the user's latest message for current-state claims.",
    ...sections.flatMap(renderProjectionEntry),
    "",
    ...renderWorkingContextRules(),
    "</agenr_work_context>",
  ];
  const content = enforceProjectionBudget(lines.join("\n"));

  return {
    kind: "working_set",
    renderMode: "full",
    content,
    ...auditProvenance,
    sourceRef,
    byteLength: utf8ByteLength(content),
  };
}

/** Enforces the rendered working-context projection byte budget with a model-visible marker. */
function enforceProjectionBudget(content: string): string {
  if (utf8ByteLength(content) <= WORKING_CONTEXT_PROJECTION_MAX_BYTES) {
    return content;
  }

  const contentWithoutClosingTag = content.replace(/\n<\/agenr_work_context>$/u, "");
  const marker = `\n[agenr_work_context truncated: exceeded ${WORKING_CONTEXT_PROJECTION_MAX_BYTES} UTF-8 byte projection budget.]\n</agenr_work_context>`;
  const prefixBudget = WORKING_CONTEXT_PROJECTION_MAX_BYTES - utf8ByteLength(marker);
  return `${truncateUtf8ToMaxBytes(contentWithoutClosingTag, prefixBudget)}${marker}`;
}

/** Resolves audit provenance from bundle sections, preferring the session working set. */
function resolveAuditProvenance(sections: WorkingContextProjectionEntry[]): Pick<WorkingContextProjection, "workingSetId" | "revision"> {
  const sessionSection = sections.find(
    (section): section is WorkingContextProjectionSection & { label: string } =>
      "workingSet" in section && section.label === WORKING_CONTEXT_SESSION_SECTION_LABEL,
  );
  const fallbackSection = sections.find((section): section is WorkingContextProjectionSection => "workingSet" in section);
  const auditSection = sessionSection ?? fallbackSection;
  if (!auditSection) {
    return {};
  }

  return {
    workingSetId: auditSection.workingSet.id,
    revision: auditSection.workingSet.revision,
  };
}

/** Renders one working-context projection entry. */
function renderProjectionEntry(section: WorkingContextProjectionEntry): string[] {
  return [
    "",
    ...(section.label ? [`## ${escapeText(section.label)}`] : []),
    ...("workingSet" in section ? renderWorkingSetSection(section.workingSet) : [`Warning: ${escapeText(section.warning)}`]),
  ];
}

/** Renders one working-set section. */
function renderWorkingSetSection(workingSet: WorkingSetRecord): string[] {
  const snapshot = workingSet.snapshot;
  return [
    `Scope: ${escapeText(workingSet.scopeKind)} ${escapeText(workingSet.scopeKey)}`,
    `Working set: ${escapeText(workingSet.id)}`,
    `Revision: ${workingSet.revision}`,
    `Status: ${escapeText(workingSet.status)}`,
    ...optionalLine("Objective", snapshot.objective ?? workingSet.title),
    ...optionalLine("Summary", snapshot.summary),
    ...renderStringList("Current plan", snapshot.currentPlan),
    ...renderCheckpoint(snapshot.checkpoint?.summary),
    ...optionalMultiline("Scratchpad", snapshot.scratchpad),
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
  ];
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

/** Renders an optional multiline field. */
function optionalMultiline(label: string, value: string | undefined): string[] {
  const normalized = value?.trim();
  return normalized ? ["", `${label}:`, escapeText(normalized)] : [];
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

/** Renders shared model-facing working-context rules. */
function renderWorkingContextRules(): string[] {
  return [
    "Rules:",
    "- Update the relevant working set when material task state changes.",
    "- Leave a checkpoint before pausing, handing off, compacting, forking, or waiting.",
    "- Do not close working sets with agenr_work.",
    "- Do not store transient WIP with agenr_store.",
    "- Promote only durable facts, decisions, preferences, or reusable procedures explicitly.",
  ];
}
