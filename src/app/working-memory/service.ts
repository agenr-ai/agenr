import { handleClose } from "./handlers/close.js";
import { handleCreate } from "./handlers/create.js";
import { handleGet } from "./handlers/get.js";
import { handleList } from "./handlers/list.js";
import { handlePrepareExternalGoalMutation } from "./handlers/prepare-external-mutation.js";
import { handleUpdate } from "./handlers/update.js";
import { createWorkingContextFullProjection, createWorkingContextStubProjection } from "./projection-render.js";
import type { AgenrWorkParams, PrepareExternalGoalMutationParams } from "./mutations.js";
import type { WorkingContextProjection } from "./projection.js";
import type { WorkingMemoryRepository } from "./repository.js";
import type { WorkingMemoryResult } from "./results.js";
import { selectWorkingSet } from "./select-working-set.js";
import type { WorkingScope } from "./scope.js";
import type { WorkingMemoryFeatureFlags } from "../features/types.js";
import { workingMemoryNotReadyFailure, WORKING_MEMORY_MISCONFIGURED_MESSAGE } from "./ready.js";

export type {
  WorkingMemoryCloseSuccess,
  WorkingMemoryCreateSuccess,
  WorkingMemoryErrorCode,
  WorkingMemoryFailure,
  WorkingMemoryGetSuccess,
  WorkingMemoryListSuccess,
  WorkingMemoryPrepareExternalMutationSuccess,
  WorkingMemoryResult,
  WorkingMemoryUpdateSuccess,
} from "./results.js";

/** Input accepted by projection rendering. */
export interface WorkingProjectionRequest {
  /** Stable source reference for the render decision. */
  sourceRef: string;
  /** Explicit working set id when known. */
  workingSetId?: string;
  /** Raw scope facts used to find an active set. */
  scope?: Partial<WorkingScope>;
}

/** Dependencies used by the working-memory service. */
export interface WorkingMemoryServiceDeps {
  /** Repository that persists schema v11 working sets and events. */
  repository?: WorkingMemoryRepository;
  /** Timestamp provider, mainly for deterministic tests. */
  now?: () => Date;
  /** Adapter or runtime source label stored on new rows. */
  sourceLabel?: string;
}

/** Working-memory service surface. */
export interface WorkingMemoryService {
  /**
   * Handles `agenr_work` actions.
   *
   * @param params - Tool parameters from the host adapter.
   * @returns Working-memory action result.
   */
  run(params: AgenrWorkParams): Promise<WorkingMemoryResult>;

  /**
   * Accounts progress before a trusted host mutates goal state externally.
   *
   * @param params - Trusted external mutation preparation request.
   * @returns Preparation result, including any committed accounting events.
   */
  prepareExternalGoalMutation(params: PrepareExternalGoalMutationParams): Promise<WorkingMemoryResult>;

  /**
   * Builds a transient working-context projection for host adapters.
   *
   * @param input - Source reference or full projection request.
   * @returns A full projection when an active set resolves, otherwise a conservative stub.
   */
  renderProjection(input: string | WorkingProjectionRequest): Promise<WorkingContextProjection>;
}

/**
 * Creates the Phase 1 working-memory service.
 *
 * @param featureFlags - Resolved runtime feature flags.
 * @param deps - Optional persistence and runtime dependencies.
 * @returns A feature-gated working-memory service.
 */
export function createWorkingMemoryService(featureFlags: WorkingMemoryFeatureFlags, deps: WorkingMemoryServiceDeps = {}): WorkingMemoryService {
  const featureEnabled = featureFlags.workingMemory;
  const repository = deps.repository;
  const now = () => (deps.now ? deps.now().toISOString() : new Date().toISOString());
  const readiness = () => workingMemoryNotReadyFailure({ featureEnabled, repository });

  return {
    async run(params) {
      const notReady = readiness();
      if (notReady) {
        return notReady;
      }

      switch (params.action) {
        case "get":
          return handleGet(params, repository!, now());
        case "list":
          return handleList(params, repository!);
        case "create":
          return handleCreate(params, repository!, now(), deps.sourceLabel);
        case "update":
          return handleUpdate(params, repository!, now());
        case "close":
          return handleClose(params, repository!, now());
      }
    },
    async prepareExternalGoalMutation(params) {
      const notReady = readiness();
      if (notReady) {
        return notReady;
      }

      return handlePrepareExternalGoalMutation(params, repository!, now());
    },
    async renderProjection(input) {
      const request = typeof input === "string" ? { sourceRef: input } : input;
      if (!featureEnabled) {
        return createWorkingContextStubProjection({
          reason: "feature_disabled",
          sourceRef: request.sourceRef,
        });
      }

      if (!repository) {
        return createWorkingContextStubProjection({
          reason: "misconfigured",
          sourceRef: request.sourceRef,
        });
      }

      const selection = await selectWorkingSet({ workingSetId: request.workingSetId, scope: request.scope }, repository);
      if (!selection.ok) {
        return createWorkingContextStubProjection({
          reason: selection.code === "ambiguous_scope" ? "ambiguous_scope" : "missing_active_set",
          sourceRef: request.sourceRef,
        });
      }

      return createWorkingContextFullProjection(selection.workingSet, request.sourceRef);
    },
  };
}

export { WORKING_MEMORY_MISCONFIGURED_MESSAGE };
