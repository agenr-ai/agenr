import { beforeEach, describe, expect, it, vi } from "vitest";

const captureMocks = vi.hoisted(() => ({
  runOpenClawSessionEndEpisodeCapture: vi.fn(async () => undefined),
}));

const routingMocks = vi.hoisted(() => ({
  routeOpenClawSessionMemoryTrigger: vi.fn(async () => undefined),
}));

vi.mock("../../../../src/adapters/openclaw/episode/session-end-episode-write.js", () => captureMocks);
vi.mock("../../../../src/adapters/openclaw/hooks/session-memory-routing.js", () => routingMocks);

import { handleAgenrSessionEnd } from "../../../../src/adapters/openclaw/hooks/session-end.js";
import { createMidSessionTracker } from "../../../../src/adapters/openclaw/session/state.js";
import type { AgenrOpenClawServices } from "../../../../src/adapters/openclaw/types.js";

describe("handleAgenrSessionEnd", () => {
  beforeEach(() => {
    captureMocks.runOpenClawSessionEndEpisodeCapture.mockClear();
    routingMocks.routeOpenClawSessionMemoryTrigger.mockClear();
  });

  it("skips memory intake and episode capture when reason is compaction", async () => {
    const midSessionTracker = createMidSessionTracker();
    midSessionTracker.getOrCreate("session-1", "agent:main:tui");

    await handleAgenrSessionEnd(
      {
        sessionId: "session-1",
        sessionKey: "agent:main:tui",
        messageCount: 8,
        reason: "compaction",
        sessionFile: "/tmp/session-1.jsonl",
      },
      {
        logger: createLogger(),
        servicesPromise: buildServicesPromise(),
        midSessionTracker,
      },
    );

    expect(midSessionTracker.activeCount()).toBe(0);
    expect(routingMocks.routeOpenClawSessionMemoryTrigger).not.toHaveBeenCalled();
    expect(captureMocks.runOpenClawSessionEndEpisodeCapture).not.toHaveBeenCalled();
  });

  it("routes shutdown memory intake and episode capture for idle session ends", async () => {
    await handleAgenrSessionEnd(
      {
        sessionId: "session-1",
        sessionKey: "agent:main:tui",
        messageCount: 8,
        reason: "idle",
        sessionFile: "/tmp/session-1.jsonl",
      },
      {
        logger: createLogger(),
        servicesPromise: buildServicesPromise(),
        midSessionTracker: createMidSessionTracker(),
      },
    );

    expect(routingMocks.routeOpenClawSessionMemoryTrigger).toHaveBeenCalledTimes(1);
    expect(captureMocks.runOpenClawSessionEndEpisodeCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          sessionId: "session-1",
          reason: "idle",
        }),
        ctx: {
          sessionId: "session-1",
          sessionKey: "agent:main:tui",
        },
      }),
    );
  });

  it("routes session_tree memory intake for reset session ends", async () => {
    await handleAgenrSessionEnd(
      {
        sessionId: "session-1",
        sessionKey: "agent:main:tui",
        messageCount: 3,
        reason: "reset",
        sessionFile: "/tmp/session-1.jsonl",
      },
      {
        logger: createLogger(),
        servicesPromise: buildServicesPromise(),
        midSessionTracker: createMidSessionTracker(),
      },
    );

    expect(routingMocks.routeOpenClawSessionMemoryTrigger).toHaveBeenCalledTimes(1);
    const buildTrigger = routingMocks.routeOpenClawSessionMemoryTrigger.mock.calls[0]?.[2] as
      | ((scope: { sessionId: string; sessionKey?: string }) => { type: string })
      | undefined;
    expect(buildTrigger?.({ sessionId: "session-1", sessionKey: "agent:main:tui" })).toMatchObject({
      type: "session_tree",
    });
    expect(captureMocks.runOpenClawSessionEndEpisodeCapture).toHaveBeenCalledTimes(1);
  });
});

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function buildServicesPromise(): Promise<AgenrOpenClawServices> {
  return Promise.resolve({
    pluginConfig: {
      memoryPolicy: { episodes: { enabled: true } },
    },
    dreaming: {},
    agenrConfig: null,
    config: { dbPath: "/tmp/knowledge.db" },
    close: vi.fn(async () => undefined),
  } as unknown as AgenrOpenClawServices);
}
