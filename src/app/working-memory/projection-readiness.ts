import { createWorkingContextStubProjection, type WorkingContextStubReason } from "./projection-render.js";
import type { WorkingProjectionBundleResult } from "./projection-bundle.js";
import type { WorkingContextProjection } from "./projection.js";
import type { WorkingMemoryRepository } from "./repository.js";
import type { WorkingMemoryFailure } from "./results.js";

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
export function resolveProjectionReadiness(
  featureEnabled: boolean,
  repository: WorkingMemoryRepository | undefined,
  sourceRef: string,
): ProjectionReadinessResult {
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
    return createStubProjectionFromSelectionFailure(sourceRef, rendered.code);
  }

  return rendered.projection;
}

/**
 * Builds a conservative stub projection from a failed working-set selection.
 *
 * @param sourceRef - Stable source reference for the render decision.
 * @param code - Failure code from working-set selection.
 * @returns Stub projection for injection or audit surfaces.
 */
export function createStubProjectionFromSelectionFailure(sourceRef: string, code: WorkingMemoryFailure["code"]): WorkingContextProjection {
  return createWorkingContextStubProjection({
    reason: selectionFailureToStubReason(code),
    sourceRef,
  });
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
