import { createWorkingContextStubProjection } from "./projection-render.js";
import { createFailure } from "./results.js";
import { WORKING_MEMORY_DISABLED_MESSAGE } from "./ready.js";
import type { AgenrWorkParams, PrepareExternalGoalMutationParams } from "./mutations.js";
import type { WorkingContextProjection } from "./projection.js";
import type { WorkingMemoryResult } from "./results.js";
import type { WorkingMemoryService } from "./service.js";

/**
 * Creates a lightweight working-memory service used when the feature flag is off.
 *
 * Avoids importing handler modules into host runtimes that do not expose
 * `agenr_work` or working-context injection.
 *
 * @returns Working-memory service that always reports `feature_disabled`.
 */
export function createDisabledWorkingMemoryService(): WorkingMemoryService {
  const failure = (): WorkingMemoryResult => createFailure("feature_disabled", WORKING_MEMORY_DISABLED_MESSAGE);

  return {
    async run(_params: AgenrWorkParams): Promise<WorkingMemoryResult> {
      return failure();
    },
    async prepareExternalGoalMutation(_params: PrepareExternalGoalMutationParams): Promise<WorkingMemoryResult> {
      return failure();
    },
    async renderProjection(input: string | { sourceRef: string }): Promise<WorkingContextProjection> {
      const sourceRef = typeof input === "string" ? input : input.sourceRef;
      return createWorkingContextStubProjection({
        reason: "feature_disabled",
        sourceRef,
      });
    },
  };
}
