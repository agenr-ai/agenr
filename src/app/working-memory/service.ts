import { handleClose } from "./handlers/close.js";
import { handleCreate } from "./handlers/create.js";
import { handleGet } from "./handlers/get.js";
import { handleList } from "./handlers/list.js";
import { handlePrepareExternalGoalMutation } from "./handlers/prepare-external-mutation.js";
import { handleUpdate } from "./handlers/update.js";
import { ensureSessionWorkingSet, type EnsureSessionWorkingSetResult } from "./ensure-session.js";
import { findUniqueCurrentWorkingSetForTarget } from "./find-current-set.js";
import { createHostWorkingSetPolicy, goalWorkingSetsDisabledFailure, goalsEnabled, requiresExplicitGoalTarget } from "./host-working-set-policy.js";
import type { WorkingMemoryHandlerContext } from "./handler-context.js";
import { renderWithProjectionReadiness } from "./projection-readiness.js";
import { renderWorkingContextBundle, type WorkingProjectionBundleRequest } from "./projection-bundle.js";
import type { AgenrWorkParams, PrepareExternalGoalMutationParams } from "./mutations.js";
import type { WorkingContextProjection } from "./projection.js";
import type { WorkingMemoryRepository } from "./repository.js";
import type { WorkingMemoryFailure, WorkingMemoryResult } from "./results.js";
import type { WorkingScope } from "./scope.js";
import { cloneForkableSnapshotFields } from "./session-fork-snapshot.js";
import type { WorkingSnapshot } from "./snapshot.js";
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

export type { EnsureSessionWorkingSetResult } from "./ensure-session.js";

export type { WorkingProjectionBundleRequest } from "./projection-bundle.js";

/** Dependencies used by the working-memory service. */
export interface WorkingMemoryServiceDeps {
  /** Repository that persists schema v11 working sets and events. */
  repository?: WorkingMemoryRepository;
  /** Timestamp provider, mainly for deterministic tests. */
  now?: () => Date;
  /** Adapter or runtime source label stored on new rows. */
  sourceLabel?: string;
  /** Whether goal working sets and goal-targeted mutations are enabled. */
  goalWorkingSetsEnabled?: boolean;
  /** Optional callback for non-absence fork-read failures. */
  onForkSnapshotReadIssue?: (failure: WorkingMemoryFailure) => void;
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
   * Ensures the session working set exists for the supplied host scope.
   *
   * @param params - Scope and provenance facts for session creation.
   * @returns Existing or newly created session working set.
   */
  ensureSessionWorkingSet(params: Pick<AgenrWorkParams, "scope" | "actor" | "source">): Promise<EnsureSessionWorkingSetResult>;

  /**
   * Reads forkable session snapshot fields without creating or mutating working sets.
   *
   * @param scope - Raw host scope facts.
   * @returns Session snapshot fields safe to seed a new goal, or undefined when no session set exists.
   */
  readSessionSnapshotForFork(scope?: Partial<WorkingScope>): Promise<WorkingSnapshot | undefined>;

  /**
   * Accounts progress before a trusted host mutates goal state externally.
   *
   * @param params - Trusted external mutation preparation request.
   * @returns Preparation result, including any committed accounting events.
   */
  prepareExternalGoalMutation(params: PrepareExternalGoalMutationParams): Promise<WorkingMemoryResult>;

  /**
   * Builds a transient projection containing session and optional goal sections.
   *
   * @param input - Scope and source reference for injection.
   * @returns Combined working-context projection.
   */
  renderProjectionBundle(input: WorkingProjectionBundleRequest): Promise<WorkingContextProjection>;
}

/**
 * Creates the working-memory service.
 *
 * @param featureFlags - Resolved runtime feature flags.
 * @param deps - Optional persistence and runtime dependencies.
 * @returns A feature-gated working-memory service.
 */
export function createWorkingMemoryService(featureFlags: WorkingMemoryFeatureFlags, deps: WorkingMemoryServiceDeps = {}): WorkingMemoryService {
  const featureEnabled = featureFlags.workingMemory;
  const repository = deps.repository;
  const policy = createHostWorkingSetPolicy(deps.goalWorkingSetsEnabled ?? true);
  const now = () => (deps.now ? deps.now().toISOString() : new Date().toISOString());
  const readiness = () => workingMemoryNotReadyFailure({ featureEnabled, repository });
  const handlerContext = (): WorkingMemoryHandlerContext => ({
    repository: repository!,
    timestamp: now(),
    sourceLabel: deps.sourceLabel,
    policy,
  });

  return {
    async run(params) {
      const notReady = readiness();
      if (notReady) {
        return notReady;
      }

      if (!goalsEnabled(policy) && requiresExplicitGoalTarget(params.target)) {
        return goalWorkingSetsDisabledFailure();
      }

      const ctx = handlerContext();
      switch (params.action) {
        case "get":
          return handleGet(params, ctx);
        case "list":
          return handleList(params, ctx);
        case "create":
          return handleCreate(params, ctx);
        case "update":
          return handleUpdate(params, ctx);
        case "close":
          return handleClose(params, ctx);
      }
    },
    async prepareExternalGoalMutation(params) {
      const notReady = readiness();
      if (notReady) {
        return notReady;
      }

      if (!goalsEnabled(policy)) {
        return goalWorkingSetsDisabledFailure();
      }

      return handlePrepareExternalGoalMutation(params, handlerContext());
    },
    async ensureSessionWorkingSet(params) {
      const notReady = readiness();
      if (notReady) {
        return notReady;
      }

      return ensureSessionWorkingSet(
        {
          scope: params.scope,
          actor: params.actor,
          source: params.source,
          sourceLabel: deps.sourceLabel,
          timestamp: now(),
        },
        repository!,
      );
    },
    async readSessionSnapshotForFork(scope) {
      const notReady = readiness();
      if (notReady) {
        return undefined;
      }

      const lookup = await findUniqueCurrentWorkingSetForTarget(scope, repository!, "session");
      if (!lookup.ok) {
        if (lookup.code !== "missing_active_set") {
          deps.onForkSnapshotReadIssue?.(lookup);
        }
        return undefined;
      }

      return cloneForkableSnapshotFields(lookup.workingSet.snapshot);
    },
    async renderProjectionBundle(input) {
      return renderWithProjectionReadiness(featureEnabled, repository, input.sourceRef, (readyRepository) =>
        renderWorkingContextBundle(readyRepository, policy, input),
      );
    },
  };
}

export { WORKING_MEMORY_MISCONFIGURED_MESSAGE };
