import { describe, expect, it } from "vitest";

import { closeWorkingMemoryTestService, createWorkingMemoryTestService } from "./service-test-helpers.js";

const TRUSTED_SCOPE = {
  conversationKey: "usage-session",
  sessionId: "usage-session",
  cwd: "/tmp/project",
};

describe("account_usage control plane", () => {
  it("keeps revision stable across many usage patches while updating budgets and budget_limited status", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const created = await service.run({
        action: "create",
        target: "goal",
        scope: TRUSTED_SCOPE,
        operation: {
          type: "set_objective",
          objective: "Exercise usage accounting.",
        },
        updateReason: "Started goal.",
        source: "goal_command",
        initialBudget: {
          tokenBudget: 1000,
        },
      });
      if (!created.ok || created.action !== "create") {
        throw new Error("Expected create success.");
      }

      let revision = created.workingSet.revision;
      for (let turn = 0; turn < 50; turn += 1) {
        const result = await service.run({
          action: "update",
          workingSetId: created.workingSet.id,
          expectedRevision: revision,
          operation: {
            type: "account_usage",
            usage: {
              tokenDelta: 1,
              recordedAt: `2026-05-30T12:${String(turn).padStart(2, "0")}:00.000Z`,
            },
          },
          updateReason: `Turn ${turn + 1} usage.`,
          source: "lifecycle_hook",
        });
        expect(result).toMatchObject({
          ok: true,
          action: "update",
          workingSet: {
            revision,
            status: "active",
            snapshot: {
              budgets: {
                tokenBudget: 1000,
                tokenUsed: turn + 1,
              },
            },
          },
        });
        if (!result.ok || result.action !== "update") {
          throw new Error("Expected usage patch success.");
        }
        expect(result.event).toBeUndefined();
        revision = result.workingSet.revision;
      }

      expect(revision).toBe(1);

      const limited = await service.run({
        action: "update",
        workingSetId: created.workingSet.id,
        expectedRevision: revision,
        operation: {
          type: "account_usage",
          usage: {
            tokenDelta: 950,
            recordedAt: "2026-05-30T13:00:00.000Z",
          },
        },
        updateReason: "Cross budget limit.",
        source: "lifecycle_hook",
      });
      expect(limited).toMatchObject({
        ok: true,
        action: "update",
        workingSet: {
          revision: 1,
          status: "budget_limited",
        },
      });
      expect(limited.ok && limited.action === "update" ? limited.event : undefined).toBeUndefined();

      const events = await service.run({
        action: "get",
        workingSetId: created.workingSet.id,
        includeEvents: true,
      });
      if (!events.ok || events.action !== "get") {
        throw new Error("Expected get success.");
      }
      expect(events.events).toEqual([expect.objectContaining({ sequence: 1, eventType: "created" })]);
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });

  it("still increments revision for semantic trusted-host and model-visible operations", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const created = await service.run({
        action: "create",
        target: "goal",
        scope: TRUSTED_SCOPE,
        operation: {
          type: "set_objective",
          objective: "Track semantic revisions.",
        },
        updateReason: "Started goal.",
        source: "goal_command",
      });
      if (!created.ok || created.action !== "create") {
        throw new Error("Expected create success.");
      }

      const objective = await service.run({
        action: "update",
        workingSetId: created.workingSet.id,
        expectedRevision: 1,
        operation: {
          type: "set_objective",
          objective: "Revised objective.",
        },
        updateReason: "Updated objective.",
        source: "tool",
        actor: "model",
      });
      expect(objective).toMatchObject({
        ok: true,
        action: "update",
        workingSet: { revision: 2 },
        event: { sequence: 2, eventType: "set_objective" },
      });

      const configured = await service.run({
        action: "update",
        workingSetId: created.workingSet.id,
        operation: {
          type: "configure_budget",
          budget: {
            tokenBudget: 50,
            tokenUsed: 0,
          },
        },
        updateReason: "Configured budgets.",
        source: "goal_command",
      });
      expect(configured).toMatchObject({
        ok: true,
        action: "update",
        workingSet: { revision: 3 },
        event: { sequence: 3, eventType: "configure_budget" },
      });

      const continuation = await service.run({
        action: "update",
        workingSetId: created.workingSet.id,
        operation: {
          type: "set_continuation_policy",
          policy: "on_idle",
        },
        updateReason: "Enabled idle continuation.",
        source: "goal_command",
      });
      expect(continuation).toMatchObject({
        ok: true,
        action: "update",
        workingSet: { revision: 4 },
        event: { sequence: 4, eventType: "set_continuation_policy" },
      });
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });

  it("keeps revision aligned with event sequence across mixed usage and semantic writes", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const created = await service.run({
        action: "create",
        target: "goal",
        scope: TRUSTED_SCOPE,
        operation: {
          type: "set_objective",
          objective: "Mixed write sequence.",
        },
        updateReason: "Started goal.",
        source: "goal_command",
        initialBudget: {
          tokenBudget: 100,
        },
      });
      if (!created.ok || created.action !== "create") {
        throw new Error("Expected create success.");
      }

      let revision = created.workingSet.revision;
      expect(revision).toBe(1);

      for (let turn = 0; turn < 10; turn += 1) {
        const usage = await service.run({
          action: "update",
          workingSetId: created.workingSet.id,
          expectedRevision: revision,
          operation: {
            type: "account_usage",
            usage: { tokenDelta: 1 },
          },
          updateReason: `Turn ${turn + 1} usage.`,
          source: "lifecycle_hook",
        });
        if (!usage.ok || usage.action !== "update") {
          throw new Error("Expected usage patch success.");
        }
        expect(usage.workingSet.revision).toBe(1);
        expect(usage.event).toBeUndefined();
        revision = usage.workingSet.revision;
      }

      const objective = await service.run({
        action: "update",
        workingSetId: created.workingSet.id,
        expectedRevision: revision,
        operation: {
          type: "set_objective",
          objective: "Semantic bump after usage.",
        },
        updateReason: "Updated objective.",
        source: "tool",
        actor: "model",
      });
      if (!objective.ok || objective.action !== "update") {
        throw new Error("Expected semantic update success.");
      }
      expect(objective).toMatchObject({
        workingSet: { revision: 2 },
        event: { sequence: 2, eventType: "set_objective" },
      });
      revision = objective.workingSet.revision;

      for (let turn = 0; turn < 5; turn += 1) {
        const usage = await service.run({
          action: "update",
          workingSetId: created.workingSet.id,
          expectedRevision: revision,
          operation: {
            type: "account_usage",
            usage: { tokenDelta: 1 },
          },
          updateReason: `Post-semantic turn ${turn + 1} usage.`,
          source: "lifecycle_hook",
        });
        if (!usage.ok || usage.action !== "update") {
          throw new Error("Expected usage patch success.");
        }
        expect(usage.workingSet.revision).toBe(2);
        revision = usage.workingSet.revision;
      }

      const configured = await service.run({
        action: "update",
        workingSetId: created.workingSet.id,
        expectedRevision: revision,
        operation: {
          type: "configure_budget",
          budget: {
            tokenBudget: 100,
            tokenUsed: 15,
          },
        },
        updateReason: "Configured budgets.",
        source: "goal_command",
      });
      if (!configured.ok || configured.action !== "update") {
        throw new Error("Expected configure_budget success.");
      }
      expect(configured).toMatchObject({
        workingSet: { revision: 3 },
        event: { sequence: 3, eventType: "configure_budget" },
      });

      const loaded = await service.run({
        action: "get",
        workingSetId: created.workingSet.id,
        includeEvents: true,
      });
      if (!loaded.ok || loaded.action !== "get") {
        throw new Error("Expected get success.");
      }

      expect(loaded.workingSet.revision).toBe(3);
      expect(loaded.events).toEqual([
        expect.objectContaining({ sequence: 1, eventType: "created" }),
        expect.objectContaining({ sequence: 2, eventType: "set_objective" }),
        expect.objectContaining({ sequence: 3, eventType: "configure_budget" }),
      ]);
      expect(loaded.events?.every((event) => event.sequence <= loaded.workingSet.revision)).toBe(true);
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });

  it("returns revision_conflict for stale usage patches and semantic updates", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const created = await service.run({
        action: "create",
        target: "goal",
        scope: TRUSTED_SCOPE,
        operation: {
          type: "set_objective",
          objective: "Guard usage patches.",
        },
        updateReason: "Started goal.",
        source: "goal_command",
      });
      if (!created.ok || created.action !== "create") {
        throw new Error("Expected create success.");
      }

      const semantic = await service.run({
        action: "update",
        workingSetId: created.workingSet.id,
        expectedRevision: 1,
        operation: {
          type: "merge_checkpoint",
          checkpoint: {
            summary: "Semantic bump.",
            recordedAt: "2026-05-30T12:00:00.000Z",
          },
        },
        updateReason: "Recorded checkpoint.",
        source: "lifecycle_hook",
      });
      if (!semantic.ok || semantic.action !== "update") {
        throw new Error("Expected semantic update success.");
      }

      await expect(
        service.run({
          action: "update",
          workingSetId: created.workingSet.id,
          expectedRevision: 1,
          operation: {
            type: "account_usage",
            usage: { tokenDelta: 1 },
          },
          updateReason: "Stale usage patch.",
          source: "lifecycle_hook",
        }),
      ).resolves.toMatchObject({
        ok: false,
        code: "revision_conflict",
        details: { actualRevision: 2 },
      });

      await expect(
        service.run({
          action: "update",
          workingSetId: created.workingSet.id,
          expectedRevision: 1,
          operation: {
            type: "set_objective",
            objective: "Stale semantic update.",
          },
          updateReason: "Stale semantic update.",
          source: "tool",
          actor: "model",
        }),
      ).resolves.toMatchObject({
        ok: false,
        code: "revision_conflict",
      });
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });

  it("threads prepare_external_goal_mutation usage then checkpoint on one revision", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const created = await service.run({
        action: "create",
        target: "goal",
        scope: TRUSTED_SCOPE,
        operation: {
          type: "set_objective",
          objective: "Prepare before external mutation.",
        },
        updateReason: "Started goal.",
        source: "goal_command",
        initialBudget: {
          tokenBudget: 10,
        },
      });
      if (!created.ok || created.action !== "create") {
        throw new Error("Expected create success.");
      }

      const prepared = await service.prepareExternalGoalMutation({
        mutationKind: "pause",
        scope: TRUSTED_SCOPE,
        usage: {
          tokenDelta: 10,
          recordedAt: "2026-05-30T12:10:00.000Z",
        },
        checkpoint: {
          summary: "Checkpoint after usage.",
          recordedAt: "2026-05-30T12:10:00.000Z",
        },
        source: "goal_command",
      });

      expect(prepared).toMatchObject({
        ok: true,
        action: "prepare_external_goal_mutation",
        prepared: true,
        workingSet: {
          revision: 2,
          status: "budget_limited",
          snapshot: {
            checkpoint: {
              summary: "Checkpoint after usage.",
            },
            budgets: {
              tokenBudget: 10,
              tokenUsed: 10,
              limitReason: "token",
            },
          },
        },
        events: [{ eventType: "merge_checkpoint", sequence: 2 }],
      });
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });
});
