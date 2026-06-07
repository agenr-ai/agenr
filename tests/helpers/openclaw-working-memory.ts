import { vi } from "vitest";

import type { AgenrOpenClawServices } from "../../src/adapters/openclaw/types.js";
import { createStubAgenrHostMemorySurface } from "./host-memory-stubs.js";

/** Options for OpenClaw working-memory test doubles. */
export interface OpenClawWorkingMemoryTestOptions {
  workingProjection?: string;
  workingStubProjection?: string;
  workingMemoryEnabled?: boolean;
}

/** Returns whether working-memory test doubles should be active. */
export function isOpenClawWorkingMemoryEnabled(options: OpenClawWorkingMemoryTestOptions): boolean {
  if (options.workingMemoryEnabled !== undefined) {
    return options.workingMemoryEnabled;
  }

  return options.workingProjection !== undefined || options.workingStubProjection !== undefined;
}

/** Builds feature flags for OpenClaw service test doubles. */
export function createOpenClawTestFeatureFlags(options: OpenClawWorkingMemoryTestOptions): AgenrOpenClawServices["runtimePolicy"]["featureFlags"] {
  return {
    workingMemory: isOpenClawWorkingMemoryEnabled(options),
    sessionTreeLineage: false,
    sessionTreeCompaction: false,
    goalContinuation: false,
  };
}

/**
 * Builds a host-memory surface stub with optional working-memory projection doubles.
 *
 * @param options - Working-memory projection options for tests.
 * @returns Partial OpenClaw services surface for working memory.
 */
export function createOpenClawWorkingMemoryHostSurface(
  options: OpenClawWorkingMemoryTestOptions,
): Pick<AgenrOpenClawServices, "workingMemory" | "goalContinuation" | "routeSessionMemoryTrigger"> {
  if (!isOpenClawWorkingMemoryEnabled(options)) {
    return createStubAgenrHostMemorySurface();
  }

  return {
    ...createStubAgenrHostMemorySurface(),
    workingMemory: {
      run: vi.fn(),
      readSessionSnapshotForFork: vi.fn(async () => undefined),
      prepareExternalGoalMutation: vi.fn(),
      ensureSessionWorkingSet: vi.fn(),
      renderProjection: vi.fn(async (request: string | { sourceRef: string }) => renderOpenClawTestWorkingProjection(request, options)),
      renderProjectionBundle: vi.fn(async (request: { sourceRef: string }) => renderOpenClawTestWorkingProjection(request, options)),
    } as unknown as AgenrOpenClawServices["workingMemory"],
  };
}

/** Renders one deterministic working-context projection for OpenClaw adapter tests. */
export function renderOpenClawTestWorkingProjection(request: string | { sourceRef: string }, options: OpenClawWorkingMemoryTestOptions) {
  const sourceRef = typeof request === "string" ? request : request.sourceRef;
  if (options.workingStubProjection) {
    return {
      kind: "working_set" as const,
      renderMode: "stub" as const,
      content: options.workingStubProjection,
      sourceRef,
      byteLength: options.workingStubProjection.length,
    };
  }

  const content = options.workingProjection ?? "<agenr_work_context></agenr_work_context>";
  return {
    kind: "working_set" as const,
    renderMode: "full" as const,
    content,
    workingSetId: "ws-test",
    revision: 1,
    sourceRef,
    byteLength: content.length,
  };
}
