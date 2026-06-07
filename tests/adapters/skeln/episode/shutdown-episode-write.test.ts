import type { ExtensionContext } from "../../../../src/adapters/skeln/skeln-types.js";
import { describe, expect, it, vi } from "vitest";

import type { AgenrSkelnServices } from "../../../../src/adapters/skeln/runtime.js";
import { scheduleSkelnSessionShutdownEpisodeWrite } from "../../../../src/adapters/skeln/episode/shutdown-episode-write.js";

describe("scheduleSkelnSessionShutdownEpisodeWrite", () => {
  it("snapshots host facts synchronously before registering deferred quit shutdown work", async () => {
    const calls: string[] = [];

    await scheduleSkelnSessionShutdownEpisodeWrite({
      event: {
        reason: "quit",
        deferWork: () => {
          calls.push("defer");
        },
      },
      context: buildContext(calls),
      servicesPromise: buildServicesPromise({ episodesEnabled: false }),
    });

    expect(calls).toEqual(["sessionId", "sessionFile", "defer"]);
  });

  it("does not touch live host context during deferred quit shutdown work", async () => {
    let sessionFileReads = 0;
    const deferred: Promise<unknown>[] = [];

    await scheduleSkelnSessionShutdownEpisodeWrite({
      event: {
        reason: "quit",
        deferWork: (work) => {
          deferred.push(work);
        },
      },
      context: buildContext([], () => {
        sessionFileReads += 1;
        if (sessionFileReads > 1) {
          throw new Error("stale context access");
        }
        return "/tmp/session.jsonl";
      }),
      servicesPromise: buildServicesPromise({ episodesEnabled: false }),
    });

    expect(sessionFileReads).toBe(1);
    await deferred[0];
    expect(sessionFileReads).toBe(1);
  });

  it("returns immediately when quit shutdown work is deferred to the host", async () => {
    let closeFinished = false;
    const close = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      closeFinished = true;
    });
    const deferred: Promise<unknown>[] = [];

    await scheduleSkelnSessionShutdownEpisodeWrite({
      event: {
        reason: "quit",
        deferWork: (work) => {
          deferred.push(work);
        },
      },
      context: buildContext([]),
      servicesPromise: buildServicesPromise({ episodesEnabled: false, close }),
    });

    expect(closeFinished).toBe(false);
    await deferred[0];
    expect(close).toHaveBeenCalledOnce();
    expect(closeFinished).toBe(true);
  });

  it("schedules reload shutdown episode work without closing services", async () => {
    const close = vi.fn(async () => undefined);

    await scheduleSkelnSessionShutdownEpisodeWrite({
      event: { reason: "reload" },
      context: buildContext([]),
      servicesPromise: buildServicesPromise({ episodesEnabled: false, close }),
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("returns quit shutdown work for the lifecycle handler to await when deferWork is absent", async () => {
    const close = vi.fn(async () => undefined);

    await scheduleSkelnSessionShutdownEpisodeWrite({
      event: { reason: "quit" },
      context: buildContext([]),
      servicesPromise: buildServicesPromise({ episodesEnabled: false, close }),
    });

    expect(close).toHaveBeenCalledOnce();
  });

  it("logs deferred quit shutdown episode failures without rejecting host work", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const deferred: Promise<unknown>[] = [];

    await scheduleSkelnSessionShutdownEpisodeWrite({
      event: {
        reason: "quit",
        deferWork: (work) => {
          deferred.push(work);
        },
      },
      context: buildContext([]),
      servicesPromise: Promise.reject(new Error("startup failed")),
      logger,
    });

    await deferred[0];
    expect(logger.warn).toHaveBeenCalledWith("[agenr] skeln shutdown episode failed: startup failed");
  });
});

/** Builds one Skeln extension context stub for shutdown scheduling tests. */
function buildContext(
  calls: string[],
  getSessionFile: () => string = () => {
    calls.push("sessionFile");
    return "/tmp/session.jsonl";
  },
): ExtensionContext {
  return {
    sessionManager: {
      getSessionId: () => {
        calls.push("sessionId");
        return "session-1";
      },
      getSessionFile,
    },
  } as ExtensionContext;
}

/** Builds one resolved services promise for shutdown scheduling tests. */
function buildServicesPromise(options: { episodesEnabled?: boolean; close?: () => Promise<void> }): Promise<AgenrSkelnServices> {
  return Promise.resolve({
    skelnConfig: {
      memoryPolicy: options.episodesEnabled === false ? { episodes: { enabled: false } } : undefined,
    },
    close: options.close ?? (async () => undefined),
  } as AgenrSkelnServices);
}
