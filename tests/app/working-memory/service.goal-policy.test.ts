import { describe, expect, it } from "vitest";

import { WORKING_CONTEXT_GOAL_SECTION_LABEL, WORKING_CONTEXT_SESSION_SECTION_LABEL } from "../../../src/app/working-memory/projection.js";
import { createWorkingMemoryService } from "../../../src/app/working-memory/service.js";
import { closeWorkingMemoryTestService, createWorkingMemoryTestService } from "./service-test-helpers.js";

describe("createWorkingMemoryService goal policy", () => {
  it("rejects goal working sets when goal surfaces are disabled for the host", async () => {
    const { database, dbPath, repository, service } = await createWorkingMemoryTestService();

    const scope = {
      conversationKey: "session-no-goals",
      sessionId: "session-no-goals",
      cwd: "/tmp/project",
    };

    try {
      const goal = await service.run({
        action: "create",
        target: "goal",
        scope,
        operation: {
          type: "set_objective",
          objective: "Existing goal.",
        },
        updateReason: "Created goal before host disabled goal surfaces.",
      });
      if (!goal.ok || goal.action !== "create") {
        throw new Error("Expected goal create success.");
      }

      const disabledService = createWorkingMemoryService(
        { workingMemory: true },
        {
          repository,
          goalWorkingSetsEnabled: false,
          now: () => new Date("2026-05-30T12:00:00.000Z"),
        },
      );

      await expect(
        disabledService.run({
          action: "create",
          scope,
          operation: {
            type: "set_objective",
            objective: "Should not create.",
          },
          updateReason: "Attempted goal create while disabled.",
        }),
      ).resolves.toMatchObject({
        ok: false,
        code: "invalid_request",
        message: "agenr_work create requires an explicit session or goal target.",
      });

      await expect(
        disabledService.run({
          action: "create",
          target: "goal",
          scope,
          operation: {
            type: "set_objective",
            objective: "Should not create.",
          },
          updateReason: "Attempted goal create while disabled.",
        }),
      ).resolves.toMatchObject({
        ok: false,
        code: "invalid_request",
        message: "Goal working sets are disabled for this host.",
      });

      await expect(disabledService.run({ action: "get", workingSetId: goal.workingSet.id })).resolves.toMatchObject({
        ok: false,
        code: "invalid_request",
        message: "Goal working sets are disabled for this host.",
      });

      await expect(
        disabledService.run({
          action: "update",
          workingSetId: goal.workingSet.id,
          expectedRevision: goal.workingSet.revision,
          operation: {
            type: "set_scratchpad",
            scratchpad: "Should not update.",
          },
          updateReason: "Attempted explicit-id goal update.",
        }),
      ).resolves.toMatchObject({
        ok: false,
        code: "invalid_request",
        message: "Goal working sets are disabled for this host.",
      });

      const session = await disabledService.ensureSessionWorkingSet({
        scope,
        actor: "runtime",
        source: "lifecycle_hook",
      });
      expect(session).toMatchObject({
        ok: true,
        workingSet: {
          scopeKind: "session",
        },
      });

      await expect(disabledService.run({ action: "list" })).resolves.toMatchObject({
        ok: true,
        action: "list",
        workingSets: [
          {
            scopeKind: "session",
          },
        ],
      });

      const bundled = await disabledService.renderProjectionBundle({
        sourceRef: "test:no-goals",
        scope,
      });
      expect(bundled.content).toContain(`## ${WORKING_CONTEXT_SESSION_SECTION_LABEL}`);
      expect(bundled.content).not.toContain(`## ${WORKING_CONTEXT_GOAL_SECTION_LABEL}`);
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });
});
