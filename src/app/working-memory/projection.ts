import type { AgenrWorkAction } from "./constants.js";
import { goalBundleSectionFromSelection, shouldResolveGoalSelection, type HostWorkingSetPolicy } from "./host-working-set-policy.js";
import { truncateUtf8ToMaxBytes, utf8ByteLength, WORKING_CONTEXT_PROJECTION_MAX_BYTES } from "./limits.js";
import type { WorkingSetRecord } from "./records.js";
import type { WorkingMemoryRepository } from "./repository.js";
import type { WorkingMemoryFailure } from "./results.js";
import type { WorkingScope } from "./scope.js";
import { selectWorkingSet } from "./selection.js";
import type { WorkingCandidate, WorkingNextAction } from "./snapshot.js";

/** Section heading for the session working set in multi-set projections. */
const WORKING_CONTEXT_SESSION_SECTION_LABEL = "Session working set" as const;

/** Section heading for the goal working set in multi-set projections. */
const WORKING_CONTEXT_GOAL_SECTION_LABEL = "Goal working set" as const;

export { WORKING_CONTEXT_GOAL_SECTION_LABEL, WORKING_CONTEXT_SESSION_SECTION_LABEL };

/**
 * Non-persistent projection returned to host adapters for model-visible context.
 */
export interface WorkingContextProjection {
  /** Projection discriminator used by host adapters. */
  kind: "working_set";
  /** Rendering depth selected by agenr. */
  renderMode: "stub" | "full";
  /** Fully rendered context block or conservative stub. */
  content: string;
  /** Working set that produced the projection when one was selected. */
  workingSetId?: string;
  /** Snapshot revision represented by the projection. */
  revision?: number;
  /** Stable provenance pointer for audits and debugging. */
  sourceRef: string;
  /** UTF-8 byte length of `content`. */
  byteLength: number;
}

/**
 * Compact audit pointer a host may persist outside replay text.
 */
export interface WorkingContextAuditPointer {
  /** Pointer source discriminator. */
  source: "agenr_work";
  /** Working set that produced the rendered projection. */
  workingSetId: string;
  /** Snapshot revision represented by the projection. */
  revision: number;
  /** Stable provenance pointer for audits and debugging. */
  sourceRef: string;
  /** UTF-8 byte length of the rendered projection. */
  bytes: number;
  /** Optional compact summary safe for audit views. */
  summary?: string;
}

/** One working-set section rendered into a projection. */
export interface WorkingContextProjectionSection {
  /** Optional section heading for multi-set projections. */
  label?: string;
  /** Working set rendered into the section body. */
  workingSet: WorkingSetRecord;
}

/** Warning rendered into a projection when a companion section cannot load. */
export interface WorkingContextProjectionWarningSection {
  /** Section heading for the warning. */
  label: string;
  /** Warning text rendered into the section body. */
  warning: string;
}

/** Projection entry rendered as either a working set or a warning section. */
export type WorkingContextProjectionEntry = WorkingContextProjectionSection | WorkingContextProjectionWarningSection;

/**
 * Builds a full projection for successful `agenr_work` tool responses.
 *
 * @param workingSet - Working set returned by the mutation.
 * @param action - Tool action that produced the projection.
 * @param timestamp - ISO timestamp used in the provenance pointer.
 * @returns Rendered transient working-context projection.
 */
export function createToolSuccessProjection(
  workingSet: WorkingSetRecord,
  action: Extract<AgenrWorkAction, "get" | "create" | "update">,
  timestamp: string,
): WorkingContextProjection {
  return createWorkingContextFullProjection(workingSet, `agenr_work:${action}:${timestamp}`);
}

/**
 * Returns whether one projection should be injected into model context.
 *
 * @param projection - Rendered working-context projection.
 * @returns True when a full active-set projection should be injected.
 */
export function shouldInjectWorkingContext(projection: WorkingContextProjection): boolean {
  return projection.renderMode === "full" && projection.content.trim().length > 0;
}

/**
 * Builds a compact audit pointer from one rendered projection.
 *
 * @param projection - Rendered working-context projection.
 * @returns Audit pointer when provenance is complete, otherwise undefined.
 */
export function toWorkingContextAuditPointer(projection: WorkingContextProjection): WorkingContextAuditPointer | undefined {
  if (projection.workingSetId === undefined || projection.revision === undefined) {
    return undefined;
  }

  return {
    source: "agenr_work",
    workingSetId: projection.workingSetId,
    revision: projection.revision,
    sourceRef: projection.sourceRef,
    bytes: projection.byteLength,
    summary:
      projection.renderMode === "full" ? `Working set ${projection.workingSetId} rev ${projection.revision}` : `Working memory stub (${projection.sourceRef})`,
  };
}

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

/** Input used to render a session and optional goal working-context bundle. */
export interface WorkingProjectionBundleRequest {
  /** Stable source reference for the render decision. */
  sourceRef: string;
  /** Raw scope facts used to find active sets when no pre-resolved session set is supplied. */
  scope?: Partial<WorkingScope>;
  /** Pre-resolved session working set when the caller already loaded one. */
  sessionWorkingSet?: WorkingSetRecord;
}

/** Successful bundle render. */
export interface WorkingProjectionBundleSuccess {
  /** Success discriminator. */
  ok: true;
  /** Rendered transient working-context projection. */
  projection: WorkingContextProjection;
}

/** Failed bundle render with a selection failure code. */
export interface WorkingProjectionBundleSelectionFailure {
  /** Failure discriminator. */
  ok: false;
  /** Failure code from working-set selection. */
  code: WorkingMemoryFailure["code"];
}

/** Result returned by working-context bundle rendering. */
export type WorkingProjectionBundleResult = WorkingProjectionBundleSuccess | WorkingProjectionBundleSelectionFailure;

/**
 * Renders a working-context projection containing session and optional goal sections.
 *
 * @param repository - Working-memory persistence port.
 * @param policy - Host policy governing goal section inclusion.
 * @param input - Scope, source reference, and optional pre-resolved session set.
 * @returns Combined projection or a session-selection failure code.
 */
export async function renderWorkingContextBundle(
  repository: WorkingMemoryRepository,
  policy: HostWorkingSetPolicy,
  input: WorkingProjectionBundleRequest,
): Promise<WorkingProjectionBundleResult> {
  const session =
    input.sessionWorkingSet !== undefined
      ? { ok: true as const, workingSet: input.sessionWorkingSet }
      : await selectWorkingSet({ scope: input.scope, target: "session" }, repository, { policy });
  if (!session.ok) {
    return { ok: false, code: session.code };
  }

  const goal = shouldResolveGoalSelection(policy) ? await selectWorkingSet({ scope: input.scope, target: "goal" }, repository, { policy }) : null;
  const sections: WorkingContextProjectionEntry[] = [{ label: WORKING_CONTEXT_SESSION_SECTION_LABEL, workingSet: session.workingSet }];
  const goalSection = goalBundleSectionFromSelection(policy, goal);
  switch (goalSection.kind) {
    case "omit":
      break;
    case "include":
      sections.push({ label: WORKING_CONTEXT_GOAL_SECTION_LABEL, workingSet: goalSection.workingSet });
      break;
    case "warn":
      sections.push({
        label: WORKING_CONTEXT_GOAL_SECTION_LABEL,
        warning: `Goal working set could not be selected: ${goalSection.message}`,
      });
      break;
    default: {
      const exhaustive: never = goalSection;
      return exhaustive;
    }
  }

  return {
    ok: true,
    projection: createWorkingContextProjectionFromSections(sections, input.sourceRef),
  };
}

/** Successful projection readiness with a configured repository. */
export interface ProjectionReadinessReady {
  /** Success discriminator. */
  ok: true;
  /** Repository used to load working sets for projection. */
  repository: WorkingMemoryRepository;
}

/** Failed projection readiness with a conservative stub projection. */
export interface ProjectionReadinessBlocked {
  /** Failure discriminator. */
  ok: false;
  /** Stub projection returned to callers. */
  projection: WorkingContextProjection;
}

/** Result of checking whether projection rendering can proceed. */
export type ProjectionReadinessResult = ProjectionReadinessReady | ProjectionReadinessBlocked;

/**
 * Resolves whether working-context projection rendering can proceed.
 *
 * @param featureEnabled - Whether working memory is enabled for the host.
 * @param repository - Optional working-memory repository.
 * @param sourceRef - Stable source reference for stub projections.
 * @returns Ready repository or a conservative stub projection.
 */
function resolveProjectionReadiness(featureEnabled: boolean, repository: WorkingMemoryRepository | undefined, sourceRef: string): ProjectionReadinessResult {
  if (!featureEnabled) {
    return {
      ok: false,
      projection: createWorkingContextStubProjection({
        reason: "feature_disabled",
        sourceRef,
      }),
    };
  }

  if (!repository) {
    return {
      ok: false,
      projection: createWorkingContextStubProjection({
        reason: "misconfigured",
        sourceRef,
      }),
    };
  }

  return { ok: true, repository };
}

/**
 * Renders a working-context projection after readiness and selection-failure guards.
 *
 * @param featureEnabled - Whether working memory is enabled for the host.
 * @param repository - Optional working-memory repository.
 * @param sourceRef - Stable source reference for stub projections.
 * @param render - Repository-backed render function.
 * @returns Rendered projection or a conservative stub.
 */
export async function renderWithProjectionReadiness(
  featureEnabled: boolean,
  repository: WorkingMemoryRepository | undefined,
  sourceRef: string,
  render: (readyRepository: WorkingMemoryRepository) => Promise<WorkingProjectionBundleResult>,
): Promise<WorkingContextProjection> {
  const readinessResult = resolveProjectionReadiness(featureEnabled, repository, sourceRef);
  if (!readinessResult.ok) {
    return readinessResult.projection;
  }

  const rendered = await render(readinessResult.repository);
  if (!rendered.ok) {
    return createWorkingContextStubProjection({
      reason: selectionFailureToStubReason(rendered.code),
      sourceRef,
    });
  }

  return rendered.projection;
}

/** Maps selection failures to conservative stub reasons. */
function selectionFailureToStubReason(code: WorkingMemoryFailure["code"]): WorkingContextStubReason {
  if (code === "ambiguous_scope") {
    return "ambiguous_scope";
  }

  if (code === "missing_active_set" || code === "missing_scope") {
    return "missing_active_set";
  }

  return "selection_failed";
}
