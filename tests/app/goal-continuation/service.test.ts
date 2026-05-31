import { describe, expect, it } from "vitest";

import { createGoalContinuationService } from "../../../src/app/goal-continuation/service.js";

describe("createGoalContinuationService", () => {
  it("fails closed when the goalContinuation flag is disabled", async () => {
    const service = createGoalContinuationService({ goalContinuation: false });

    await expect(service.runCommand({ command: "/goal resume" })).resolves.toEqual({
      ok: false,
      code: "feature_disabled",
      message: "Goal continuation is disabled by the goalContinuation feature flag.",
    });
  });

  it("fails through the host callback boundary when enabled without a registered host", async () => {
    const service = createGoalContinuationService({ goalContinuation: true });

    await expect(service.runCommand({ command: "/goal resume" })).resolves.toEqual({
      ok: false,
      code: "host_callback_missing",
      message: "Goal continuation is host-owned; no host callback was registered for this Agenr runtime.",
    });
  });

  it("delegates to the host callback when continuation is enabled", async () => {
    const service = createGoalContinuationService(
      { goalContinuation: true },
      {
        runCommand: async (params) => ({
          ok: true,
          message: `host handled ${params.command}`,
        }),
      },
    );

    await expect(service.runCommand({ command: "/goal resume" })).resolves.toEqual({
      ok: true,
      message: "host handled /goal resume",
    });
  });
});
