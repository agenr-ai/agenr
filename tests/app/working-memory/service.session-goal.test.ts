import { describe, expect, it } from "vitest";

import { closeWorkingMemoryTestService, createWorkingMemoryTestService } from "./service-test-helpers.js";

describe("createWorkingMemoryService session and goal layers", () => {
  it("stores continuation, budget, and external mutation prep state", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const scope = {
        conversationKey: "session-continuation",
        sessionId: "session-continuation",
        cwd: "/tmp/project",
      };
      const created = await service.run({
        action: "create",
        target: "goal",
        scope,
        operation: {
          type: "set_objective",
          objective: "Run a long-horizon goal.",
        },
        updateReason: "User set an on-idle goal.",
        source: "goal_command",
        continuationPolicy: "on_idle",
        initialBudget: {
          tokenBudget: 100,
          wallClockBudgetSeconds: 600,
          turnBudget: 2,
        },
      });
      expect(created).toMatchObject({
        ok: true,
        action: "create",
        workingSet: {
          status: "active",
          snapshot: {
            continuation: { policy: "on_idle" },
            budgets: {
              tokenBudget: 100,
              wallClockBudgetSeconds: 600,
              turnBudget: 2,
            },
          },
        },
      });
      if (!created.ok || created.action !== "create") {
        throw new Error("Expected continuation create success.");
      }

      const configuredBudget = await service.run({
        action: "update",
        workingSetId: created.workingSet.id,
        operation: {
          type: "configure_budget",
          budget: {
            tokenBudget: 100,
            tokenUsed: 0,
            wallClockBudgetSeconds: 600,
            wallClockUsedSeconds: 0,
            turnBudget: 2,
            turnsUsed: 0,
          },
        },
        updateReason: "Runtime configured goal budgets.",
        actor: "runtime",
        source: "goal_command",
      });
      expect(configuredBudget).toMatchObject({
        ok: true,
        action: "update",
        workingSet: {
          revision: 2,
          snapshot: {
            budgets: {
              tokenBudget: 100,
              tokenUsed: 0,
              turnBudget: 2,
              turnsUsed: 0,
            },
          },
        },
      });

      const prepared = await service.prepareExternalGoalMutation({
        mutationKind: "clear",
        scope,
        requireCheckpoint: true,
        checkpoint: {
          summary: "Progress accounted before clear.",
          recordedAt: "2026-05-30T12:10:00.000Z",
          nextActions: ["Clear the goal"],
        },
        usage: {
          tokenDelta: 125,
          wallClockSecondsDelta: 60,
          turnDelta: 1,
          recordedAt: "2026-05-30T12:10:00.000Z",
        },
        actor: "runtime",
        source: "goal_command",
      });
      expect(prepared).toMatchObject({
        ok: true,
        action: "prepare_external_goal_mutation",
        prepared: true,
        workingSet: {
          status: "budget_limited",
          revision: 3,
          snapshot: {
            checkpoint: {
              summary: "Progress accounted before clear.",
            },
            budgets: {
              tokenBudget: 100,
              tokenUsed: 125,
              limitReason: "token",
              limitedAt: "2026-05-30T12:10:00.000Z",
            },
          },
        },
        events: [
          { eventType: "account_usage", sequence: 3 },
          { eventType: "merge_checkpoint", sequence: 4 },
        ],
      });

      await expect(
        service.run({
          action: "update",
          scope,
          operation: {
            type: "account_usage",
            usage: {
              tokenDelta: 1,
            },
          },
          updateReason: "Model attempted trusted accounting.",
          actor: "model",
          source: "tool",
        }),
      ).resolves.toMatchObject({
        ok: false,
        code: "invalid_request",
        message: "account_usage is reserved for trusted host runtime paths.",
      });

      await expect(
        service.prepareExternalGoalMutation({
          mutationKind: "fork",
          scope: {
            conversationKey: "session-missing",
          },
          requireCheckpoint: true,
          actor: "runtime",
          source: "lifecycle_hook",
        }),
      ).resolves.toMatchObject({
        ok: true,
        action: "prepare_external_goal_mutation",
        prepared: false,
        events: [],
      });
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });
});
