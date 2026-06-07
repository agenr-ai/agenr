import {
  goalBundleSectionFromSelection,
  shouldResolveGoalSelection,
  type GoalBundleSectionDecision,
  type HostWorkingSetPolicy,
} from "./host-working-set-policy.js";
import type { AgenrWorkTarget } from "./mutations.js";
import type { WorkingContextProjection } from "./projection.js";
import { WORKING_CONTEXT_GOAL_SECTION_LABEL, WORKING_CONTEXT_SESSION_SECTION_LABEL } from "./projection-section-labels.js";
import { createWorkingContextFullProjection, createWorkingContextMultiProjection } from "./projection-render.js";
import type { WorkingMemoryRepository } from "./repository.js";
import type { WorkingSetRecord } from "./records.js";
import type { WorkingMemoryFailure } from "./results.js";
import type { WorkingScope } from "./scope.js";
import { selectWorkingSet, type WorkingSetSelectionResult } from "./select-working-set.js";

/** Input used to render a session and optional goal working-context bundle. */
export interface WorkingProjectionBundleRequest {
  /** Stable source reference for the render decision. */
  sourceRef: string;
  /** Raw scope facts used to find active sets when no pre-resolved session set is supplied. */
  scope?: Partial<WorkingScope>;
  /** Pre-resolved session working set when the caller already loaded one. */
  sessionWorkingSet?: WorkingSetRecord;
}

/** Input used to render one selected working set into a projection. */
export interface WorkingProjectionSingleRequest {
  /** Stable source reference for the render decision. */
  sourceRef: string;
  /** Explicit working set id when known. */
  workingSetId?: string;
  /** Working-set target when multiple active set kinds can exist. */
  target?: AgenrWorkTarget;
  /** Raw scope facts used to find an active set. */
  scope?: Partial<WorkingScope>;
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
  const { session, goal } = await resolveBundleSelections(repository, policy, input);
  if (!session.ok) {
    return { ok: false, code: session.code };
  }

  return {
    ok: true,
    projection: createWorkingContextMultiProjection(buildWorkingContextBundleSections(policy, session.workingSet, goal), input.sourceRef),
  };
}

/**
 * Renders a working-context projection from one selected working set.
 *
 * @param repository - Working-memory persistence port.
 * @param policy - Host policy governing selection behavior.
 * @param input - Selection inputs and source reference.
 * @returns Rendered projection or a selection failure code.
 */
export async function renderWorkingContextSingleProjection(
  repository: WorkingMemoryRepository,
  policy: HostWorkingSetPolicy,
  input: WorkingProjectionSingleRequest,
): Promise<WorkingProjectionBundleResult> {
  const selection = await selectWorkingSet({ workingSetId: input.workingSetId, scope: input.scope, target: input.target }, repository, { policy });
  if (!selection.ok) {
    return { ok: false, code: selection.code };
  }

  return {
    ok: true,
    projection: createWorkingContextFullProjection(selection.workingSet, input.sourceRef),
  };
}

/** Resolves session and optional goal selections for one bundle render. */
async function resolveBundleSelections(
  repository: WorkingMemoryRepository,
  policy: HostWorkingSetPolicy,
  input: WorkingProjectionBundleRequest,
): Promise<{ session: WorkingSetSelectionResult; goal: WorkingSetSelectionResult | null }> {
  const session = await resolveSessionForBundle(repository, policy, input);
  if (!session.ok) {
    return { session, goal: null };
  }

  const goal = await selectGoalWorkingSetForBundle(policy, input.scope, repository);
  return { session, goal };
}

/** Resolves the session working set used by one bundle render. */
async function resolveSessionForBundle(
  repository: WorkingMemoryRepository,
  policy: HostWorkingSetPolicy,
  input: WorkingProjectionBundleRequest,
): Promise<WorkingSetSelectionResult> {
  if (input.sessionWorkingSet !== undefined) {
    return { ok: true, workingSet: input.sessionWorkingSet };
  }

  return selectWorkingSet({ scope: input.scope, target: "session" }, repository, { policy });
}

/** Selects the goal working set for one bundle render when policy allows it. */
async function selectGoalWorkingSetForBundle(
  policy: HostWorkingSetPolicy,
  scope: Partial<WorkingScope> | undefined,
  repository: WorkingMemoryRepository,
): Promise<WorkingSetSelectionResult | null> {
  if (!shouldResolveGoalSelection(policy)) {
    return null;
  }

  return selectWorkingSet({ scope, target: "goal" }, repository, { policy });
}

/** Builds labeled bundle sections from session and optional goal selection results. */
function buildWorkingContextBundleSections(
  policy: HostWorkingSetPolicy,
  sessionWorkingSet: WorkingSetRecord,
  goal: WorkingSetSelectionResult | null,
): Array<{ label: string; workingSet: WorkingSetRecord } | { label: string; warning: string }> {
  const sections: Array<{ label: string; workingSet: WorkingSetRecord } | { label: string; warning: string }> = [
    { label: WORKING_CONTEXT_SESSION_SECTION_LABEL, workingSet: sessionWorkingSet },
  ];

  const goalSection = goalBundleSectionFromSelection(policy, goal);
  appendGoalBundleSection(sections, goalSection);

  return sections;
}

/** Appends one goal bundle section from a typed policy decision. */
function appendGoalBundleSection(
  sections: Array<{ label: string; workingSet: WorkingSetRecord } | { label: string; warning: string }>,
  decision: GoalBundleSectionDecision,
): void {
  if (decision.kind === "omit") {
    return;
  }

  if (decision.kind === "include") {
    sections.push({ label: WORKING_CONTEXT_GOAL_SECTION_LABEL, workingSet: decision.workingSet });
    return;
  }

  sections.push({
    label: WORKING_CONTEXT_GOAL_SECTION_LABEL,
    warning: `Goal working set could not be selected: ${decision.message}`,
  });
}
