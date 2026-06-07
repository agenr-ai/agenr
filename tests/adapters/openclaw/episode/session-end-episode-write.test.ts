import { describe, expect, it, vi } from "vitest";

import {
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
    config: { dbPath: "/tmp/knowledge.db" },
    close: vi.fn(async () => undefined),
  } as unknown as AgenrOpenClawServices);
}
