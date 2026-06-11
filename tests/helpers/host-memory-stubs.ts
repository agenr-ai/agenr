import { vi } from "vitest";

import type { SessionMemoryTriggerResult } from "../../src/app/session-memory/results.js";
import type { SessionMemoryRepository } from "../../src/app/session-memory/repository.js";
import type { AgenrHostMemorySurface } from "../../src/app/host-memory/create-host-memory-services.js";

/**
 * Creates a minimal host-memory surface stub for adapter tests.
 */
export function createStubAgenrHostMemorySurface(
  overrides: Partial<AgenrHostMemorySurface> = {},
): Pick<AgenrHostMemorySurface, "workingMemory" | "goalContinuation" | "routeSessionMemoryTrigger"> {
  return {
    workingMemory: {
      run: vi.fn(),
      renderProjectionBundle: vi.fn(),
    } as unknown as AgenrHostMemorySurface["workingMemory"],
    goalContinuation: {
      runCommand: vi.fn(),
    } as unknown as AgenrHostMemorySurface["goalContinuation"],
    routeSessionMemoryTrigger: vi.fn(
      async (): Promise<SessionMemoryTriggerResult> => ({
        accepted: false,
        reason: "feature_disabled",
        message: "session memory disabled in test stub",
      }),
    ),
    ...overrides,
  };
}

/**
 * Creates a full session-memory repository stub with optional overrides.
 */
export function createStubSessionMemoryRepository(overrides: Partial<SessionMemoryRepository> = {}): SessionMemoryRepository {
  return {
    upsertLineageEdge: vi.fn(),
    upsertSessionArtifact: vi.fn(),
    recordTriggerIntake: vi.fn(),
    listSessionArtifacts: vi.fn(async () => []),
    listSessionArtifactsBySourceRef: vi.fn(async () => []),
    getLatestLineageEdgeForChild: vi.fn(async () => null),
    ...overrides,
  };
}
