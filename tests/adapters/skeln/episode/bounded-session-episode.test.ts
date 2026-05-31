import type { ExtensionContext } from "skeln";
import { describe, expect, it, vi } from "vitest";

import { resolveSessionFile, writeSkelnBoundedSessionEpisode } from "../../../../src/adapters/skeln/episode/bounded-session-episode.js";
import type { AgenrSkelnServices } from "../../../../src/adapters/skeln/runtime.js";

describe("resolveSessionFile", () => {
  it("returns undefined when the host context cannot expose a session file", () => {
    expect(
      resolveSessionFile({
        sessionManager: {
          getSessionFile: () => {
            throw new Error("missing session file");
          },
        },
      } as ExtensionContext),
    ).toBeUndefined();
  });

  it("returns undefined for blank session file paths", () => {
    expect(
      resolveSessionFile({
        sessionManager: {
          getSessionFile: () => "   ",
        },
      } as ExtensionContext),
    ).toBeUndefined();
  });
});

describe("writeSkelnBoundedSessionEpisode", () => {
  it("skips the write when no session file is available", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    await writeSkelnBoundedSessionEpisode({
      context: {
        sessionManager: {
          getSessionId: () => "session-1",
          getSessionFile: () => {
            throw new Error("missing session file");
          },
        },
      } as ExtensionContext,
      services: {} as AgenrSkelnServices,
      actionLabel: "skeln goal close episode promotion",
      genVersion: "test-gen",
      activityThreshold: { minMaterialTurns: 2, minDurationMs: 0 },
      buildSourceRef: (sessionFile) => sessionFile,
      logContext: "session=session-1",
      skipDetails: "session=session-1 workingSet=ws-1",
      logger,
    });

    expect(logger.info).toHaveBeenCalledWith("[agenr] skeln goal close episode promotion skipped for session=session-1 workingSet=ws-1 reason=no_session_file");
  });
});
