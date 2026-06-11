import { describe, expect, it } from "vitest";

import { createWorkingMemoryService } from "../../../src/app/working-memory/service.js";

describe("createWorkingMemoryService readiness", () => {
  it("fails closed when the workingMemory flag is disabled", async () => {
    const service = createWorkingMemoryService({ workingMemory: false });

    await expect(service.run({ action: "get" })).resolves.toEqual({
      ok: false,
      code: "feature_disabled",
      message: "Working memory is disabled by the workingMemory feature flag.",
    });

    await expect(service.renderProjectionBundle({ sourceRef: "readiness:feature-disabled" })).resolves.toMatchObject({
      kind: "working_set",
      renderMode: "stub",
      sourceRef: "readiness:feature-disabled",
      content: expect.stringContaining("Reason: feature_disabled"),
    });
  });

  it("returns misconfigured when the flag is enabled without a repository", async () => {
    const service = createWorkingMemoryService({ workingMemory: true });

    await expect(service.run({ action: "update" })).resolves.toEqual({
      ok: false,
      code: "misconfigured",
      message: "Working memory is enabled, but no working-memory repository was wired into the runtime.",
    });

    await expect(service.renderProjectionBundle({ sourceRef: "readiness:misconfigured" })).resolves.toMatchObject({
      kind: "working_set",
      renderMode: "stub",
      sourceRef: "readiness:misconfigured",
      content: expect.stringContaining("Reason: misconfigured"),
    });
  });
});
