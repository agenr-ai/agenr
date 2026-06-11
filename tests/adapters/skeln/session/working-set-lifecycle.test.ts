import { describe, expect, it, vi } from "vitest";

import { closeSkelnSessionWorkingSet, ensureSkelnSessionWorkingSet } from "../../../../src/adapters/skeln/session/working-set-lifecycle.js";
import type { AgenrSkelnServices } from "../../../../src/adapters/skeln/runtime.js";
import type { AgenrSkelnSessionScope } from "../../../../src/adapters/skeln/types.js";
import { resolveRuntimeCapabilities } from "../../../../src/app/features/capabilities.js";

describe("skeln session working-set lifecycle", () => {
  it("routes ensure failures through the injected logger", async () => {
    const logger = { warn: vi.fn() };
    const services = createLifecycleServices({
      workingMemory: true,
      ensureSessionWorkingSet: vi.fn(async () => ({
        ok: false as const,
        code: "ambiguous_scope" as const,
        message: "Multiple current session working sets matched.",
      })),
    });

    await ensureSkelnSessionWorkingSet(Promise.resolve(services), createScope(), logger);

    expect(logger.warn).toHaveBeenCalledWith("[agenr] session working-set ensure failed: Multiple current session working sets matched.");
  });

  it("routes close failures through the injected logger", async () => {
    const logger = { warn: vi.fn() };
    const services = createLifecycleServices({
      workingMemory: true,
      run: vi.fn(async () => ({
        ok: false as const,
        code: "ambiguous_scope" as const,
        message: "Multiple current session working sets matched.",
      })),
    });

    await closeSkelnSessionWorkingSet(Promise.resolve(services), createScope(), { reason: "quit" }, logger);

    expect(logger.warn).toHaveBeenCalledWith("[agenr] session working-set close failed: Multiple current session working sets matched.");
  });
});

function createScope(): AgenrSkelnSessionScope {
  return {
    sessionId: "session-1",
    sessionKey: "skeln:session:session-1:cwd:/tmp/project",
    cwd: "/tmp/project",
    conversationKey: "session-1",
  };
}

function createLifecycleServices(options: {
  workingMemory: boolean;
  ensureSessionWorkingSet?: ReturnType<typeof vi.fn>;
  run?: ReturnType<typeof vi.fn>;
}): AgenrSkelnServices {
  const featureFlags = {
    workingMemory: options.workingMemory,
    sessionTreeLineage: false,
    sessionTreeCompaction: false,
    goalContinuation: false,
  };

  return {
    workingMemory: {
      ensureSessionWorkingSet: options.ensureSessionWorkingSet ?? vi.fn(),
      run: options.run ?? vi.fn(),
    },
    capabilities: resolveRuntimeCapabilities(featureFlags, {
      workingMemoryRepository: options.workingMemory ? ({} as AgenrSkelnServices["workingMemoryRepository"]) : undefined,
    }),
  } as unknown as AgenrSkelnServices;
}
