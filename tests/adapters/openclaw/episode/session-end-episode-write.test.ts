import { describe, expect, it, vi } from "vitest";

const episodeWriterMocks = vi.hoisted(() => ({
  writeOpenClawSessionEndEpisode: vi.fn(async () => undefined),
}));

const guardedCaptureMocks = vi.hoisted(() => ({
  runGuardedPostSessionEpisodeCapture: vi.fn(async (params: { writeEpisode: () => Promise<void> }) => params.writeEpisode()),
}));

vi.mock("../../../../src/adapters/openclaw/episode/episode-writer.js", () => episodeWriterMocks);
vi.mock("../../../../src/adapters/shared/guarded-post-session-episode-capture.js", () => guardedCaptureMocks);

import {
  resolveOpenClawSessionEndEpisodeTarget,
  runOpenClawSessionEndEpisodeCapture,
} from "../../../../src/adapters/openclaw/episode/session-end-episode-write.js";
import { isOpenClawSessionEndCompaction } from "../../../../src/adapters/openclaw/session-end-policy.js";
import type { AgenrOpenClawServices } from "../../../../src/adapters/openclaw/types.js";

describe("runOpenClawSessionEndEpisodeCapture", () => {
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

  it("treats compaction session-end reasons as already captured", () => {
    expect(isOpenClawSessionEndCompaction("compaction")).toBe(true);
    expect(isOpenClawSessionEndCompaction("idle")).toBe(false);
    expect(isOpenClawSessionEndCompaction("reset")).toBe(false);
    expect(isOpenClawSessionEndCompaction(undefined)).toBe(false);
  });

  it("skips session-end episode capture when reason is compaction", async () => {
    const logger = createLogger();

    await runOpenClawSessionEndEpisodeCapture({
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
    expect(guardedCaptureMocks.runGuardedPostSessionEpisodeCapture).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("skips episode capture when memory policy disables episodes", async () => {
    const logger = createLogger();

    await runOpenClawSessionEndEpisodeCapture({
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
    expect(guardedCaptureMocks.runGuardedPostSessionEpisodeCapture).not.toHaveBeenCalled();
  });

  it("writes through the sync session-end target when episodes are enabled", async () => {
    const logger = createLogger();

    await runOpenClawSessionEndEpisodeCapture({
      event: {
        sessionId: "session-1",
        messageCount: 8,
        sessionFile: "/tmp/session-1.jsonl",
      },
      ctx: { sessionId: "session-1", sessionKey: "agent:main:tui" },
      servicesPromise: buildServicesPromise({ episodesEnabled: true }),
      logger,
    });

    expect(guardedCaptureMocks.runGuardedPostSessionEpisodeCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "session-end",
        sessionContext: "session=session-1",
      }),
    );
    expect(episodeWriterMocks.writeOpenClawSessionEndEpisode).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          sessionId: "session-1",
          sessionFile: "/tmp/session-1.jsonl",
        },
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
