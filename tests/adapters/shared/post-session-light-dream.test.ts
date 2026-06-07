import { describe, expect, it, vi } from "vitest";

const maybeRunLightDreamMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/app/dreaming/background-triggers.js", () => ({
  maybeRunLightDream: maybeRunLightDreamMock,
}));

import { runPostSessionLightDream } from "../../../src/adapters/shared/post-session-light-dream.js";

describe("runPostSessionLightDream", () => {
  it("logs completion with optional session context", async () => {
    const logger = createLogger();
    maybeRunLightDreamMock.mockResolvedValue({
      status: "ran",
      result: { runId: "dream-1" },
      unsynthesizedImportanceSum: 1,
    });

    await runPostSessionLightDream({
      deps: { port: {}, config: null },
      logger,
      scope: "session-end",
      sessionContext: "session=abc",
    });

    expect(logger.info).toHaveBeenCalledWith("[agenr] session-end light dream completed for session=abc run=dream-1");
  });

  it("logs skipped reasons at info for contention and debug otherwise", async () => {
    const logger = createLogger();
    maybeRunLightDreamMock.mockResolvedValueOnce({ status: "skipped", reason: "run_in_progress" });
    maybeRunLightDreamMock.mockResolvedValueOnce({ status: "skipped", reason: "no_evidence" });

    await runPostSessionLightDream({
      deps: { port: {}, config: null },
      logger,
      scope: "skeln shutdown",
    });
    await runPostSessionLightDream({
      deps: { port: {}, config: null },
      logger,
      scope: "skeln shutdown",
    });

    expect(logger.info).toHaveBeenCalledWith("[agenr] skeln shutdown light dream skipped reason=run_in_progress");
    expect(logger.debug).toHaveBeenCalledWith("[agenr] skeln shutdown light dream skipped reason=no_evidence");
  });
});

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
}
