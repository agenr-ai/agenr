import { describe, expect, it, vi } from "vitest";

const concurrencyMocks = vi.hoisted(() => ({
  withEpisodeWriteGuard: vi.fn(async (_params: unknown, work: () => Promise<void>) => work()),
}));

const lightDreamMocks = vi.hoisted(() => ({
  buildLightDreamTriggerDeps: vi.fn(() => ({ port: {}, config: null })),
  runPostSessionLightDream: vi.fn(async () => undefined),
}));

vi.mock("../../../src/app/dreaming/concurrency.js", () => concurrencyMocks);
vi.mock("../../../src/adapters/shared/light-dream-trigger-deps.js", () => ({
  buildLightDreamTriggerDeps: lightDreamMocks.buildLightDreamTriggerDeps,
}));
vi.mock("../../../src/adapters/shared/post-session-light-dream.js", () => ({
  runPostSessionLightDream: lightDreamMocks.runPostSessionLightDream,
}));

import { runGuardedPostSessionEpisodeCapture } from "../../../src/adapters/shared/guarded-post-session-episode-capture.js";

describe("runGuardedPostSessionEpisodeCapture", () => {
  it("runs the episode write under guard before post-session light dream", async () => {
    const order: string[] = [];
    const writeEpisode = vi.fn(async () => {
      order.push("write");
    });
    concurrencyMocks.withEpisodeWriteGuard.mockImplementation(async (_params: unknown, work: () => Promise<void>) => {
      order.push("guard");
      await work();
    });
    lightDreamMocks.runPostSessionLightDream.mockImplementation(async () => {
      order.push("dream");
    });

    await runGuardedPostSessionEpisodeCapture({
      services: {
        dreaming: {},
        config: { dbPath: "/tmp/knowledge.db" },
        agenrConfig: null,
        embedding: {},
      },
      writeEpisode,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
      scope: "session-end",
      sessionContext: "session=abc",
    });

    expect(order).toEqual(["guard", "write", "dream"]);
    expect(lightDreamMocks.buildLightDreamTriggerDeps).toHaveBeenCalledTimes(1);
    expect(lightDreamMocks.runPostSessionLightDream).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "session-end",
        sessionContext: "session=abc",
      }),
    );
  });
});
