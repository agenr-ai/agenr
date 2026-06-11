import { describe, expect, it, vi } from "vitest";

import { closeOpenClawSessionWorkingSet, ensureOpenClawSessionWorkingSet } from "../../../../src/adapters/openclaw/session/working-set-lifecycle.js";
import { resolveRuntimeCapabilities } from "../../../../src/app/features/capabilities.js";
import type { AgenrOpenClawServices } from "../../../../src/adapters/openclaw/types.js";

describe("openclaw session working-set lifecycle", () => {
  it("ensures the session working set when working memory is enabled", async () => {
    const ensureSessionWorkingSet = vi.fn(async () => ({ ok: true as const }));
    const services = createLifecycleServices({ workingMemory: true, ensureSessionWorkingSet });

    await ensureOpenClawSessionWorkingSet(Promise.resolve(services), {
      sessionId: "session-1",
      sessionKey: "agent:main:webchat:test",
    });

    expect(ensureSessionWorkingSet).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "runtime",
        source: "lifecycle_hook",
        scope: expect.objectContaining({
          sessionId: "session-1",
          conversationKey: "session-1",
        }),
      }),
    );
  });

  it("skips ensure when working memory is disabled", async () => {
    const ensureSessionWorkingSet = vi.fn(async () => ({ ok: true as const }));
    const services = createLifecycleServices({ workingMemory: false, ensureSessionWorkingSet });

    await ensureOpenClawSessionWorkingSet(Promise.resolve(services), {
      sessionId: "session-1",
      sessionKey: "agent:main:webchat:test",
    });

    expect(ensureSessionWorkingSet).not.toHaveBeenCalled();
  });

  it("closes the session working set at session end", async () => {
    const run = vi.fn(async () => ({ ok: true as const, action: "close" as const }));
    const services = createLifecycleServices({ workingMemory: true, run });

    await closeOpenClawSessionWorkingSet(
      Promise.resolve(services),
      {
        sessionId: "session-1",
        sessionKey: "agent:main:webchat:test",
      },
      { reason: "reset" },
    );

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "close",
        target: "session",
        closeReason: "Session shutdown (reset).",
        createEpisode: false,
        actor: "runtime",
        source: "lifecycle_hook",
      }),
    );
  });

  it("routes lifecycle warnings through the supplied host logger", async () => {
    const ensureSessionWorkingSet = vi.fn(async () => ({
      ok: false as const,
      message: "ensure failed in test",
    }));
    const logger = { warn: vi.fn() };
    const services = createLifecycleServices({ workingMemory: true, ensureSessionWorkingSet });

    await ensureOpenClawSessionWorkingSet(
      Promise.resolve(services),
      {
        sessionId: "session-1",
        sessionKey: "agent:main:webchat:test",
      },
      logger,
    );

    expect(logger.warn).toHaveBeenCalledWith("[agenr] session working-set ensure failed: ensure failed in test");
  });

  it("refuses to ensure when OpenClaw scope falls back to unknown identity", async () => {
    const ensureSessionWorkingSet = vi.fn(async () => ({ ok: true as const }));
    const logger = { warn: vi.fn() };
    const services = createLifecycleServices({ workingMemory: true, ensureSessionWorkingSet });

    await ensureOpenClawSessionWorkingSet(Promise.resolve(services), {}, logger);

    expect(ensureSessionWorkingSet).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '[agenr] OpenClaw session identity is unavailable; refusing to ensure a session working set because the "unknown" fallback could collide across sessions.',
    );
  });

  it("refuses to close when OpenClaw scope falls back to unknown identity", async () => {
    const run = vi.fn(async () => ({ ok: true as const, action: "close" as const }));
    const logger = { warn: vi.fn() };
    const services = createLifecycleServices({ workingMemory: true, run });

    await closeOpenClawSessionWorkingSet(Promise.resolve(services), {}, { reason: "reset" }, logger);

    expect(run).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '[agenr] OpenClaw session identity is unavailable; refusing to close a session working set because the "unknown" fallback could collide across sessions.',
    );
  });

  it("ignores missing_active_set close failures", async () => {
    const run = vi.fn(async () => ({
      ok: false as const,
      code: "missing_active_set" as const,
      message: "No active session working set.",
    }));
    const services = createLifecycleServices({ workingMemory: true, run });

    await expect(
      closeOpenClawSessionWorkingSet(
        Promise.resolve(services),
        {
          sessionId: "session-1",
          sessionKey: "agent:main:webchat:test",
        },
        { reason: "reset" },
      ),
    ).resolves.toBeUndefined();
  });
});

function createLifecycleServices(options: {
  workingMemory: boolean;
  ensureSessionWorkingSet?: ReturnType<typeof vi.fn>;
  run?: ReturnType<typeof vi.fn>;
}): AgenrOpenClawServices {
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
      workingMemoryRepository: options.workingMemory ? ({} as AgenrOpenClawServices["workingMemoryRepository"]) : undefined,
    }),
  } as unknown as AgenrOpenClawServices;
}
