import { describe, expect, it } from "vitest";

import { createDisabledWorkingMemoryService } from "../../../src/app/working-memory/disabled-service.js";
import { createWorkingMemoryService, type WorkingMemoryService } from "../../../src/app/working-memory/service.js";

describe("createDisabledWorkingMemoryService", () => {
  it("matches the real service's feature-disabled run result", async () => {
    const { disabledService, realDisabledService } = createDisabledServices();

    await expect(disabledService.run({ action: "get" })).resolves.toEqual(await realDisabledService.run({ action: "get" }));
  });

  it("matches the real service's feature-disabled external mutation preparation result", async () => {
    const { disabledService, realDisabledService } = createDisabledServices();
    const params = {
      mutationKind: "clear",
      source: "goal_command",
    } as const;

    await expect(disabledService.prepareExternalGoalMutation(params)).resolves.toEqual(await realDisabledService.prepareExternalGoalMutation(params));
  });

  it("matches the real service's feature-disabled ensure-session result", async () => {
    const { disabledService, realDisabledService } = createDisabledServices();
    const params = {
      scope: {
        sessionId: "session-1",
      },
      actor: "runtime",
      source: "lifecycle_hook",
    } as const;

    await expect(disabledService.ensureSessionWorkingSet(params)).resolves.toEqual(await realDisabledService.ensureSessionWorkingSet(params));
  });

  it("matches the real service's feature-disabled fork snapshot result", async () => {
    const { disabledService, realDisabledService } = createDisabledServices();
    const scope = {
      sessionId: "session-1",
    };

    await expect(disabledService.readSessionSnapshotForFork(scope)).resolves.toEqual(await realDisabledService.readSessionSnapshotForFork(scope));
  });

  it("matches the real service's feature-disabled projection stub", async () => {
    const { disabledService, realDisabledService } = createDisabledServices();
    const input = {
      sourceRef: "test:disabled-projection",
    };

    await expect(disabledService.renderProjectionBundle(input)).resolves.toEqual(await realDisabledService.renderProjectionBundle(input));
  });
});

function createDisabledServices(): { disabledService: WorkingMemoryService; realDisabledService: WorkingMemoryService } {
  return {
    disabledService: createDisabledWorkingMemoryService(),
    realDisabledService: createWorkingMemoryService({ workingMemory: false }),
  };
}
