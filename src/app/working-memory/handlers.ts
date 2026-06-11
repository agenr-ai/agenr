import { applyOperation, commitAppliedWorkingSetChange, isAppliedWorkingSetCommitFailure } from "./apply-operation.js";
import { CURRENT_WORKING_SET_STATUSES, isCloseManagedStatus, isMutableWorkingSetStatus, isTrustedHostMutationSource } from "./constants.js";
import type { HostWorkingSetPolicy } from "./host-working-set-policy.js";
import { listFilter } from "./host-working-set-policy.js";
import { CLOSE_EVENT_HISTORY_LIMIT, normalizeEventLimit, normalizeListLimit } from "./limits.js";
import { isHostOnlyOperationType, type AgenrWorkCloseMode, type AgenrWorkParams } from "./mutations.js";
import { createToolSuccessProjection } from "./projection.js";
import type { WorkingSetRecord } from "./records.js";
import {
  isWorkingSetCreateFailure,
  isWorkingSetWriteFailure,
  type WorkingMemoryRepository,
  type WorkingSetListFilter,
  type WorkingSetWriteResult,
} from "./repository.js";
import { createFailure, writeFailureToResult, type WorkingMemoryResult } from "./results.js";
import type { ResolvedWorkingScope } from "./scope.js";
import { resolveCreateScope, resolveListScopes, selectWorkingSet } from "./selection.js";
import { cloneForkableSnapshotFields, INITIAL_GOAL_GENERATION, type WorkingCandidate, type WorkingCheckpoint, type WorkingSnapshot } from "./snapshot.js";
import { normalizeRequiredString, resolveExpectedRevision, validateExplicitCreateTarget, validateWorkingBudgetState } from "./validation.js";

/** Shared dependencies passed to working-memory action handlers. */
export interface WorkingMemoryHandlerContext {
  /** Working-memory persistence port. */
  repository: WorkingMemoryRepository;
  /** ISO timestamp used for projections and writes. */
  timestamp: string;
  /** Adapter or runtime source label stored on new rows. */
  sourceLabel?: string;
  /** Host policy governing session and goal working-set exposure. */
  policy: HostWorkingSetPolicy;
}

/** Handles the read action. */
export async function handleGet(params: AgenrWorkParams, ctx: WorkingMemoryHandlerContext): Promise<WorkingMemoryResult> {
  const selection = await selectWorkingSet(params, ctx.repository, { policy: ctx.policy });
  if (!selection.ok) {
    return selection;
  }

  const events = params.includeEvents ? await ctx.repository.listWorkingEvents(selection.workingSet.id, normalizeEventLimit(params.eventLimit)) : undefined;
  return {
    ok: true,
    action: "get",
    workingSet: selection.workingSet,
    ...(events ? { events } : {}),
    projection: createToolSuccessProjection(selection.workingSet, "get", ctx.timestamp),
  };
}

/** Handles the list action. */
export async function handleList(params: AgenrWorkParams, ctx: WorkingMemoryHandlerContext): Promise<WorkingMemoryResult> {
  const limit = normalizeListLimit(params.listLimit);
  const listQuery = buildListQuery(params, listFilter(ctx.policy));

  if (!params.scope) {
    const workingSets = await ctx.repository.listWorkingSets({
      ...listQuery,
      limit,
    });
    return {
      ok: true,
      action: "list",
      workingSets,
    };
  }

  const scopeResolution = resolveListScopes(params.scope, params.target, ctx.policy);
  if (!scopeResolution.ok) {
    return scopeResolution;
  }

  const workingSets = await listWorkingSetsForScopes(ctx.repository, scopeResolution.scopes, limit, listQuery);
  return {
    ok: true,
    action: "list",
    workingSets,
  };
}

/** Lists working sets for one or more resolved scopes and applies the global limit. */
async function listWorkingSetsForScopes(
  repository: WorkingMemoryHandlerContext["repository"],
  scopes: ResolvedWorkingScope[],
  limit: number,
  listQuery: Pick<WorkingSetListFilter, "scopeKinds" | "statuses">,
): Promise<WorkingSetRecord[]> {
  if (scopes.length === 1) {
    return repository.listWorkingSets({
      scope: scopes[0],
      ...listQuery,
      limit,
    });
  }

  const batches = await Promise.all(
    scopes.map((scope) =>
      repository.listWorkingSets({
        scope,
        ...listQuery,
        limit,
      }),
    ),
  );

  const merged = new Map<string, WorkingSetRecord>();
  for (const batch of batches) {
    for (const workingSet of batch) {
      merged.set(workingSet.id, workingSet);
    }
  }

  return [...merged.values()].sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt)).slice(0, limit);
}

/** Builds shared list query filters from request params and host policy. */
function buildListQuery(
  params: AgenrWorkParams,
  policyFilter: Pick<WorkingSetListFilter, "scopeKinds">,
): Pick<WorkingSetListFilter, "scopeKinds" | "statuses"> {
  return {
    ...policyFilter,
    statuses: params.statuses && params.statuses.length > 0 ? params.statuses : [...CURRENT_WORKING_SET_STATUSES],
  };
}

/** Handles creation of a new scoped working set. */
export async function handleCreate(params: AgenrWorkParams, ctx: WorkingMemoryHandlerContext): Promise<WorkingMemoryResult> {
  const operation = params.operation;
  if (!operation || operation.type !== "set_objective") {
    return createFailure("invalid_request", "agenr_work create requires a set_objective operation.");
  }

  const updateReason = normalizeRequiredString(params.updateReason, "agenr_work create requires updateReason.");
  if (!updateReason.ok) {
    return updateReason;
  }

  const createTarget = validateExplicitCreateTarget(params.target);
  if (!createTarget.ok) {
    return createTarget;
  }

  const scopeResolution = await resolveCreateScope({ ...params, target: createTarget.target }, ctx.repository);
  if (!scopeResolution.ok) {
    return scopeResolution;
  }

  const { scope } = scopeResolution;
  const initialBudget = params.initialBudget ? validateWorkingBudgetState(params.initialBudget) : { ok: true as const };
  if (!initialBudget.ok) {
    return initialBudget;
  }

  const created = await ctx.repository.createWorkingSet({
    scope,
    title: operation.title,
    objective: operation.objective,
    status: "active",
    snapshot: {
      ...cloneForkableSnapshotFields(params.initialSnapshot),
      goalGeneration: INITIAL_GOAL_GENERATION,
      objective: operation.objective,
      continuation: { policy: params.continuationPolicy ?? "manual" },
      ...(params.initialBudget ? { budgets: params.initialBudget } : {}),
      lastMaterialChange: updateReason.value,
    },
    actor: params.actor,
    source: params.source,
    sourceLabel: ctx.sourceLabel,
    sessionId: scope.sessionId,
    now: ctx.timestamp,
  });

  if (isWorkingSetCreateFailure(created)) {
    return createFailure("active_set_exists", "A working set already exists for this scope.", {
      scopeKey: created.scopeKey,
    });
  }

  return {
    ok: true,
    action: "create",
    workingSet: created.workingSet,
    event: created.event,
    projection: createToolSuccessProjection(created.workingSet, "create", ctx.timestamp),
  };
}

/** Handles typed update operations against an existing working set. */
export async function handleUpdate(params: AgenrWorkParams, ctx: WorkingMemoryHandlerContext): Promise<WorkingMemoryResult> {
  const operation = params.operation;
  if (!operation) {
    return createFailure("invalid_request", "agenr_work update requires a typed operation.");
  }

  if (isHostOnlyOperationType(operation.type) && !isTrustedHostMutationSource(params.source)) {
    return createFailure("invalid_request", `${operation.type} is reserved for trusted host runtime paths.`);
  }

  const updateReason = normalizeRequiredString(params.updateReason, "agenr_work update requires updateReason.");
  if (!updateReason.ok) {
    return updateReason;
  }

  const selection = await selectWorkingSet(params, ctx.repository, { policy: ctx.policy });
  if (!selection.ok) {
    return selection;
  }

  const expectedRevision = resolveExpectedRevision(selection.workingSet.revision, params.expectedRevision, params.source);
  if (!expectedRevision.ok) {
    return expectedRevision;
  }

  if (!isMutableWorkingSetStatus(selection.workingSet.status)) {
    return createFailure("terminal_status", `Working set ${selection.workingSet.id} is already ${selection.workingSet.status}.`, {
      workingSetId: selection.workingSet.id,
      status: selection.workingSet.status,
    });
  }

  const applied = applyOperation(selection.workingSet, operation, updateReason.value);
  if (!applied.ok) {
    return applied;
  }

  const writeResult = await commitAppliedWorkingSetChange(ctx.repository, {
    workingSetId: selection.workingSet.id,
    expectedRevision: expectedRevision.value,
    operation,
    previousStatus: selection.workingSet.status,
    updateReason: updateReason.value,
    applied,
    actor: params.actor,
    source: params.source,
    now: ctx.timestamp,
  });
  if (isAppliedWorkingSetCommitFailure(writeResult)) {
    return writeFailureToResult(selection.workingSet.id, writeResult);
  }

  return {
    ok: true,
    action: "update",
    workingSet: writeResult.workingSet,
    ...(writeResult.event ? { event: writeResult.event } : {}),
    projection: createToolSuccessProjection(writeResult.workingSet, "update", ctx.timestamp),
  };
}

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

/** Handles deterministic close. */
export async function handleClose(params: AgenrWorkParams, ctx: WorkingMemoryHandlerContext): Promise<WorkingMemoryResult> {
  if (!isTrustedHostMutationSource(params.source)) {
    return createFailure(
      "close_not_allowed",
      "agenr_work close is reserved for /goal clear. Record progress with merge_checkpoint and leave the working set open.",
    );
  }

  const closeReason = normalizeRequiredString(params.closeReason, "agenr_work close requires closeReason.");
  if (!closeReason.ok) {
    return closeReason;
  }

  const selection = await selectWorkingSet(params, ctx.repository, { policy: ctx.policy });
  if (!selection.ok) {
    return selection;
  }

  const expectedRevision = resolveExpectedRevision(selection.workingSet.revision, params.expectedRevision, params.source);
  if (!expectedRevision.ok) {
    return expectedRevision;
  }

  if (isCloseManagedStatus(selection.workingSet.status)) {
    return createFailure("terminal_status", `Working set ${selection.workingSet.id} is already ${selection.workingSet.status}.`, {
      workingSetId: selection.workingSet.id,
      status: selection.workingSet.status,
    });
  }

  const events = await ctx.repository.listWorkingEvents(selection.workingSet.id, CLOSE_EVENT_HISTORY_LIMIT);
  const terminalStatus = resolveCloseTerminalStatus(params.closeMode);
  const closePayload = buildWorkingCloseSnapshot({
    workingSetId: selection.workingSet.id,
    snapshot: selection.workingSet.snapshot,
    currentRevision: selection.workingSet.revision,
    closeReason: closeReason.value,
    createEpisode: params.createEpisode,
    eventSequences: events.map((event) => event.sequence),
    now: ctx.timestamp,
  });
  const writeResult = await ctx.repository.updateWorkingSet({
    workingSetId: selection.workingSet.id,
    expectedRevision: expectedRevision.value,
    eventType: terminalStatus,
    payload: {
      closeReason: closeReason.value,
      closeMode: params.closeMode ?? "close",
      candidates: closePayload.candidates,
      sourceRef: `working_set:${selection.workingSet.id}#rev:${selection.workingSet.revision}`,
    },
    status: terminalStatus,
    snapshot: closePayload.snapshot,
    title: selection.workingSet.title,
    objective: selection.workingSet.snapshot.objective,
    closedAt: ctx.timestamp,
    closeReason: closeReason.value,
    actor: params.actor,
    source: params.source,
    now: ctx.timestamp,
  });

  return toCloseResult(selection.workingSet.id, writeResult, closePayload.candidates);
}

/** Maps repository close responses to service results. */
function toCloseResult(workingSetId: string, writeResult: WorkingSetWriteResult, candidates: WorkingCandidate[]): WorkingMemoryResult {
  if (isWorkingSetWriteFailure(writeResult)) {
    return writeFailureToResult(workingSetId, writeResult);
  }

  return {
    ok: true,
    action: "close",
    workingSet: writeResult.workingSet,
    event: writeResult.event,
    candidates,
  };
}
