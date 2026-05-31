import { createGoalContinuationService, type GoalContinuationHostPort, type GoalContinuationService } from "../goal-continuation/service.js";
import { routeSessionMemoryTrigger } from "../session-memory/trigger-router.js";
import type { SessionMemoryRepository } from "../session-memory/repository.js";
import type { SessionMemoryTriggerResult } from "../session-memory/results.js";
import type { SessionMemoryTriggerEvent } from "../session-memory/types.js";
import { createWorkingMemoryService, type WorkingMemoryService } from "../working-memory/service.js";
import type { WorkingMemoryRepository } from "../working-memory/repository.js";
import type { AgenrFeatureFlags } from "../features/types.js";

/**
 * Host-facing memory surface exposed on plugin runtime services.
 */
export interface AgenrHostMemorySurface {
  /** Feature-gated working-memory service used by host tools and projections. */
  workingMemory: WorkingMemoryService;
  /** Goal-continuation service for host-owned /goal runtime parity. */
  goalContinuation: GoalContinuationService;
  /**
   * Routes session-memory lifecycle triggers through feature gates and persistence.
   *
   * @param event - Host lifecycle event.
   * @returns Accepted intake result when enabled and configured, otherwise a fail-closed rejection.
   */
  routeSessionMemoryTrigger(event: SessionMemoryTriggerEvent): Promise<SessionMemoryTriggerResult>;
}

/** Optional dependencies for host memory services. */
export interface CreateHostMemoryServicesOptions {
  /** Repository used once workingMemory is enabled. */
  workingMemoryRepository?: WorkingMemoryRepository;
  /** Repository used once session-memory feature flags are enabled. */
  sessionMemoryRepository?: SessionMemoryRepository;
  /** Adapter source label stored on new working sets. */
  workingMemorySourceLabel?: string;
  /** Optional host-owned continuation callback. */
  goalContinuationHostPort?: GoalContinuationHostPort;
}

/**
 * Creates working-memory, session-memory, and goal-continuation services for host adapters.
 *
 * @param featureFlags - Fully resolved runtime feature flags.
 * @param options - Optional repositories and source labels.
 * @returns Services wired to resolved feature flags.
 */
export function createHostMemoryServices(featureFlags: AgenrFeatureFlags, options: CreateHostMemoryServicesOptions = {}): AgenrHostMemorySurface {
  const workingMemory = createWorkingMemoryService(featureFlags, {
    repository: options.workingMemoryRepository,
    sourceLabel: options.workingMemorySourceLabel,
  });

  return {
    workingMemory,
    goalContinuation: createGoalContinuationService(featureFlags, options.goalContinuationHostPort),
    routeSessionMemoryTrigger: (event) =>
      routeSessionMemoryTrigger(event, featureFlags, {
        repository: options.sessionMemoryRepository,
        workingMemory,
      }),
  };
}
