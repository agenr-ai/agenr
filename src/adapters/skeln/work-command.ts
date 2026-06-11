import type { ExtensionContext } from "./skeln-types.js";

import type { AgenrWorkMutationActor, TrustedHostMutationSource } from "../../app/working-memory/constants.js";
import type {
  AgenrWorkCloseMode,
  AgenrWorkParams,
  AgenrWorkTarget,
  AgenrWorkUpdateOperation,
  WorkingExternalGoalMutationKind,
} from "../../app/working-memory/mutations.js";
import type { WorkingScope } from "../../app/working-memory/scope.js";
import type { WorkingBudgetState, WorkingCheckpoint, WorkingUsageDelta } from "../../app/working-memory/snapshot.js";
import type { WorkingContinuationPolicy } from "../../app/working-memory/constants.js";
import type { GoalContinuationResult } from "../../app/goal-continuation/service.js";
import type { AgenrSkelnGoalContinuationCommandParams } from "./goal-continuation-command.js";
import { workingMemoryResultToToolOutcome } from "../shared/work-tools.js";
import { scheduleWorkingSetConsolidation } from "../shared/working-set-consolidation.js";
import { scheduleSkelnGoalCloseEpisodePromotion } from "./episode/goal-close-episode.js";
import type { createAgenrSkelnServices } from "./runtime.js";
import { toWorkingScopeFromSkelnSession } from "./session/scope.js";
import type { AgenrSkelnSessionScope } from "./types.js";

/** Trusted Skeln host surfaces allowed to bypass model-facing work-tool limits. */
export type AgenrSkelnWorkCommandSource = TrustedHostMutationSource;

/** Shared trusted mutation metadata for Skeln work-command calls. */
export interface AgenrSkelnWorkCommandMutationMetadata {
  /** Actor that initiated the trusted host command. */
  actor?: AgenrWorkMutationActor;
  /** Trusted host surface that emitted the command. */
  source: AgenrSkelnWorkCommandSource;
}

/** Read command accepted by the trusted Skeln work-command controller. */
export interface AgenrSkelnWorkGetCommandParams {
  /** Read the current working set. */
  action: "get";
  /** Working-set target to read. */
  target?: AgenrWorkTarget;
  /** Explicit working-set id when known. */
  workingSetId?: string;
  /** Raw scope facts supplied by Skeln. */
  scope?: Partial<WorkingScope>;
  /** Whether recent event details should be included. */
  includeEvents?: boolean;
  /** Maximum event count to include. */
  eventLimit?: number;
}

/** List command accepted by the trusted Skeln work-command controller. */
export interface AgenrSkelnWorkListCommandParams {
  /** List working sets. */
  action: "list";
  /** Working-set target used to resolve the list scope. */
  target?: AgenrWorkTarget;
  /** Raw scope facts supplied by Skeln. */
  scope?: Partial<WorkingScope>;
  /** Maximum working sets to return. */
  listLimit?: number;
  /** Optional working-set statuses to include. */
  statuses?: AgenrWorkParams["statuses"];
}

/** Create command accepted by the trusted Skeln work-command controller. */
export interface AgenrSkelnWorkCreateCommandParams extends AgenrSkelnWorkCommandMutationMetadata {
  /** Create one scoped working set. */
  action: "create";
  /** Working-set target to create. */
  target?: AgenrWorkTarget;
  /** Raw scope facts supplied by Skeln. */
  scope?: Partial<WorkingScope>;
  /** Initial objective operation. */
  operation: Extract<AgenrWorkUpdateOperation, { type: "set_objective" }>;
  /** Human-readable audit reason. */
  updateReason: string;
  /** Initial budget state supplied by the trusted host command. */
  initialBudget?: WorkingBudgetState;
  /** Initial continuation policy supplied by trusted Skeln `/goal set`. */
  continuationPolicy?: WorkingContinuationPolicy;
}

/** Update command accepted by the trusted Skeln work-command controller. */
export interface AgenrSkelnWorkUpdateCommandParams extends AgenrSkelnWorkCommandMutationMetadata {
  /** Update an existing working set. */
  action: "update";
  /** Working-set target to update. */
  target?: AgenrWorkTarget;
  /** Explicit working-set id when known. */
  workingSetId?: string;
  /** Raw scope facts supplied by Skeln. */
  scope?: Partial<WorkingScope>;
  /** Revision observed before mutation. Omit to inherit the selected working-set revision. */
  expectedRevision?: number;
  /** Granular mutation operation. */
  operation: AgenrWorkUpdateOperation;
  /** Human-readable audit reason. */
  updateReason: string;
}

/** Close command accepted by the trusted Skeln work-command controller. */
export interface AgenrSkelnWorkCloseCommandParams extends AgenrSkelnWorkCommandMutationMetadata {
  /** Close or abandon an existing working set. */
  action: "close";
  /** Working-set target to close. */
  target?: AgenrWorkTarget;
  /** Explicit working-set id when known. */
  workingSetId?: string;
  /** Raw scope facts supplied by Skeln. */
  scope?: Partial<WorkingScope>;
  /** Revision observed before close. Omit to inherit the selected working-set revision. */
  expectedRevision?: number;
  /** User-visible close reason. */
  closeReason: string;
  /** Explicit terminal close intent. */
  closeMode?: AgenrWorkCloseMode;
  /** Whether close should request episode creation when thresholds pass. */
  createEpisode?: boolean;
}

/** Prepare command accepted before trusted external goal mutations. */
export interface AgenrSkelnWorkPrepareExternalGoalMutationCommandParams extends AgenrSkelnWorkCommandMutationMetadata {
  /** Account progress before a host mutates goal state externally. */
  action: "prepare_external_goal_mutation";
  /** Working-set target to prepare. */
  target?: AgenrWorkTarget;
  /** External mutation that is about to run. */
  mutationKind: WorkingExternalGoalMutationKind;
  /** Explicit working-set id when known. */
  workingSetId?: string;
  /** Raw scope facts supplied by Skeln. */
  scope?: Partial<WorkingScope>;
  /** Optional checkpoint to merge before the external mutation. */
  checkpoint?: WorkingCheckpoint;
  /** Optional usage delta to account before the external mutation. */
  usage?: WorkingUsageDelta;
  /** Whether an active goal must have a checkpoint before the mutation proceeds. */
  requireCheckpoint?: boolean;
  /** Optional audit reason used for generated accounting writes. */
  updateReason?: string;
}

/** Trusted command params accepted by the Skeln controller. */
export type AgenrSkelnWorkCommandParams =
  | AgenrSkelnWorkGetCommandParams
  | AgenrSkelnWorkListCommandParams
  | AgenrSkelnWorkCreateCommandParams
  | AgenrSkelnWorkUpdateCommandParams
  | AgenrSkelnWorkCloseCommandParams
  | AgenrSkelnWorkPrepareExternalGoalMutationCommandParams;

/** Trusted working-memory command result returned to Skeln UI code. */
export interface AgenrSkelnWorkCommandOutcome {
  /** Text formatted the same way as the model-facing agenr_work tool. */
  text: string;
  /** Structured details formatted the same way as the model-facing agenr_work tool. */
  details: Record<string, unknown>;
  /** True when Agenr returned a failed working-memory result. */
  failed: boolean;
}

/** Trusted host command capability returned by {@link registerAgenrSkelnMemory}. */
export interface AgenrSkelnMemoryController {
  /**
   * Executes a working-memory command from trusted Skeln UI or lifecycle code.
   *
   * @param context - Active Skeln extension context.
   * @param params - Working-memory params supplied by the trusted host command.
   * @returns Host-neutral working-memory outcome.
   */
  executeWorkCommand(context: ExtensionContext, params: AgenrSkelnWorkCommandParams): Promise<AgenrSkelnWorkCommandOutcome>;

  /**
   * Routes a trusted continuation command through the goal-continuation boundary.
   *
   * Schedule commands inherit the resolved session scope and are checked
   * against goal eligibility before the registered host port is invoked.
   *
   * @param context - Active Skeln extension context.
   * @param params - Trusted continuation command params.
   * @returns Goal-continuation result from the app boundary.
   */
  executeGoalContinuationCommand(context: ExtensionContext, params: AgenrSkelnGoalContinuationCommandParams): Promise<GoalContinuationResult>;
}

/**
 * Executes one trusted working-memory command through the Skeln runtime services.
 *
 * @param servicesPromise - Lazily initialized Skeln services.
 * @param resolveScope - Resolves the active session scope for the command.
 * @param context - Active Skeln extension context.
 * @param params - Trusted working-memory params.
 * @returns Host-neutral working-memory outcome.
 */
export async function executeAgenrSkelnWorkCommand(
  servicesPromise: ReturnType<typeof createAgenrSkelnServices>,
  resolveScope: (context: ExtensionContext) => Promise<AgenrSkelnSessionScope>,
  context: ExtensionContext,
  params: AgenrSkelnWorkCommandParams,
): Promise<AgenrSkelnWorkCommandOutcome> {
  const [services, scope] = await Promise.all([servicesPromise, resolveScope(context)]);
  const workingScope = {
    ...toWorkingScopeFromSkelnSession(scope),
    ...(params.scope ?? {}),
  };
  const result =
    params.action === "prepare_external_goal_mutation"
      ? await services.workingMemory.prepareExternalGoalMutation({
          ...params,
          target: params.target ?? "goal",
          scope: workingScope,
        })
      : await services.workingMemory.run({
          ...toAgenrWorkParams(params),
          scope: workingScope,
        });
  if (!result.ok) {
    return workingMemoryResultToToolOutcome(result);
  }
  if (params.action === "close" && result.action === "close") {
    if (params.createEpisode) {
      scheduleSkelnGoalCloseEpisodePromotion({
        context,
        services,
        closeResult: result,
      });
    }

    scheduleWorkingSetConsolidation({
      services,
      workingSetId: result.workingSet.id,
      candidates: result.candidates,
    });
  }
  return workingMemoryResultToToolOutcome(result);
}

/** Maps trusted Skeln work-command params to the app working-memory contract. */
export function toAgenrWorkParams(params: AgenrSkelnWorkCommandParams): AgenrWorkParams {
  switch (params.action) {
    case "get":
      return {
        action: "get",
        ...(params.target !== undefined ? { target: params.target } : {}),
        ...(params.workingSetId !== undefined ? { workingSetId: params.workingSetId } : {}),
        ...(params.includeEvents !== undefined ? { includeEvents: params.includeEvents } : {}),
        ...(params.eventLimit !== undefined ? { eventLimit: params.eventLimit } : {}),
      };
    case "list":
      return {
        action: "list",
        ...(params.target !== undefined ? { target: params.target } : {}),
        ...(params.listLimit !== undefined ? { listLimit: params.listLimit } : {}),
        ...(params.statuses !== undefined ? { statuses: params.statuses } : {}),
      };
    case "create":
      return {
        action: "create",
        target: params.target ?? "goal",
        operation: params.operation,
        updateReason: params.updateReason,
        source: params.source,
        ...(params.actor !== undefined ? { actor: params.actor } : {}),
        ...(params.initialBudget !== undefined ? { initialBudget: params.initialBudget } : {}),
        ...(params.continuationPolicy !== undefined ? { continuationPolicy: params.continuationPolicy } : {}),
      };
    case "update":
      return {
        action: "update",
        target: params.target ?? "goal",
        operation: params.operation,
        updateReason: params.updateReason,
        source: params.source,
        ...(params.expectedRevision !== undefined ? { expectedRevision: params.expectedRevision } : {}),
        ...(params.workingSetId !== undefined ? { workingSetId: params.workingSetId } : {}),
        ...(params.actor !== undefined ? { actor: params.actor } : {}),
      };
    case "close":
      return {
        action: "close",
        target: params.target ?? "goal",
        closeReason: params.closeReason,
        source: params.source,
        ...(params.expectedRevision !== undefined ? { expectedRevision: params.expectedRevision } : {}),
        ...(params.workingSetId !== undefined ? { workingSetId: params.workingSetId } : {}),
        ...(params.actor !== undefined ? { actor: params.actor } : {}),
        ...(params.closeMode !== undefined ? { closeMode: params.closeMode } : {}),
        ...(params.createEpisode !== undefined ? { createEpisode: params.createEpisode } : {}),
      };
    case "prepare_external_goal_mutation":
      throw new Error("prepare_external_goal_mutation must be executed through prepareExternalGoalMutation.");
  }
}
