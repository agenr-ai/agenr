import { describe, expect, it, vi } from "vitest";

const episodeWriterMocks = vi.hoisted(() => ({
  writeOpenClawSessionEndEpisode: vi.fn(async () => undefined),
}));

const concurrencyMocks = vi.hoisted(() => ({
  withEpisodeWriteGuard: vi.fn(async (_params: unknown, work: () => Promise<void>) => work()),
}));

const lightDreamMocks = vi.hoisted(() => ({
  runPostSessionLightDream: vi.fn(async () => undefined),
}));

vi.mock("../../../../src/adapters/openclaw/episode/episode-writer.js", () => episodeWriterMocks);
vi.mock("../../../../src/app/dreaming/concurrency.js", () => concurrencyMocks);
vi.mock("../../../../src/adapters/shared/post-session-light-dream.js", () => lightDreamMocks);

import {
  buildOpenClawSessionEndEpisodeWork,
  resolveOpenClawSessionEndEpisodeTarget,
  scheduleOpenClawSessionEndEpisodeWrite,
} from "../../../../src/adapters/openclaw/episode/session-end-episode-write.js";
import type { AgenrOpenClawServices } from "../../../../src/adapters/openclaw/types.js";

describe("scheduleOpenClawSessionEndEpisodeWrite", () => {
  it("resolves synchronous session-end targets from host facts", () => {
    expect(
      resolveOpenClawSessionEndEpisodeTarget({
        sessionId: "session-1",
        messageCount: 8,
        sessionFile: "/tmp/session-1.jsonl",
      }),
    ).toEqual({
      sessionId: "session-1",
      sessionFile: "/tmp/session-1.jsonl",
    });
  });

  it("returns undefined when synchronous session-end facts are incomplete", () => {
    expect(
      resolveOpenClawSessionEndEpisodeTarget({
        sessionId: "session-1",
        messageCount: 8,
      }),
    ).toBeUndefined();
  });

  it("skips session-end episode capture when reason is compaction", async () => {
    const logger = createLogger();

    await scheduleOpenClawSessionEndEpisodeWrite({
      event: {
        sessionId: "session-1",
        messageCount: 8,
        reason: "compaction",
        sessionFile: "/tmp/session-1.jsonl",
      },
      ctx: { sessionId: "session-1" },
      servicesPromise: buildServicesPromise(),
      logger,
    });

    expect(episodeWriterMocks.writeOpenClawSessionEndEpisode).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("skips episode capture when memory policy disables episodes", async () => {
    const logger = createLogger();

    await scheduleOpenClawSessionEndEpisodeWrite({
      event: {
        sessionId: "session-1",
        messageCount: 8,
        sessionFile: "/tmp/session-1.jsonl",
      },
      ctx: { sessionId: "session-1" },
      servicesPromise: buildServicesPromise(),
      logger,
    });

    expect(logger.debug).toHaveBeenCalledWith("[agenr] session-end episode write skipped for session=session-1 reason=memory_policy_disabled");
    expect(episodeWriterMocks.writeOpenClawSessionEndEpisode).not.toHaveBeenCalled();
  });

  it("writes through the sync session-end target when episodes are enabled", async () => {
    const logger = createLogger();

    await buildOpenClawSessionEndEpisodeWork({
      event: {
        sessionId: "session-1",
        messageCount: 8,
        sessionFile: "/tmp/session-1.jsonl",
      },
      ctx: { sessionId: "session-1", sessionKey: "agent:main:tui" },
      servicesPromise: buildServicesPromise({ episodesEnabled: true }),
      logger,
    });

    expect(concurrencyMocks.withEpisodeWriteGuard).toHaveBeenCalledTimes(1);
    expect(episodeWriterMocks.writeOpenClawSessionEndEpisode).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          sessionId: "session-1",
          sessionFile: "/tmp/session-1.jsonl",
        },
      }),
    );
    expect(lightDreamMocks.runPostSessionLightDream).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "session-end",
        sessionContext: "session=session-1",
      }),
    );
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

function buildServicesPromise(options: { episodesEnabled?: boolean } = {}): Promise<AgenrOpenClawServices> {
  return Promise.resolve({
    pluginConfig: {
      memoryPolicy: options.episodesEnabled ? { episodes: { enabled: true } } : { episodes: { enabled: false } },
    },
    openClaw: {
      runtime: {
        state: {
          resolveStateDir: () => "/tmp/openclaw",
        },
      },
    },
    dreaming: {},
    agenrConfig: null,
    config: { dbPath: "/tmp/knowledge.db" },
    close: vi.fn(async () => undefined),
  } as unknown as AgenrOpenClawServices);
}
