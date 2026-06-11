import { describe, expect, it } from "vitest";

import { createWorkingMemoryRepository } from "../../../src/adapters/db/working-memory-repository.js";
import type { SqlDatabase } from "../../../src/adapters/db/client.js";
import { createWorkingMemoryService } from "../../../src/app/working-memory/service.js";
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
        event: {
          sequence: 2,
          eventType: "account_usage",
          payload: {
            statusTransition: {
              from: "active",
              to: "budget_limited",
            },
          },
        },
      });

      const events = await service.run({
        action: "get",
        workingSetId: created.workingSet.id,
        includeEvents: true,
      });
      if (!events.ok || events.action !== "get") {
        throw new Error("Expected get success.");
      }
      expect(events.events).toEqual([
        expect.objectContaining({ sequence: 1, eventType: "created" }),
        expect.objectContaining({
          sequence: 2,
          eventType: "account_usage",
          payload: expect.objectContaining({
            updateReason: "Cross budget limit.",
            statusTransition: {
              from: "active",
              to: "budget_limited",
            },
          }),
        }),
      ]);
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });

  it("configure_budget recovers a budget-limited set when raised limits no longer bind", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const created = await service.run({
        action: "create",
        target: "goal",
        scope: TRUSTED_SCOPE,
        operation: {
          type: "set_objective",
          objective: "Recover from a budget limit.",
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

      const limited = await service.run({
        action: "update",
        workingSetId: created.workingSet.id,
        expectedRevision: created.workingSet.revision,
        operation: {
          type: "account_usage",
          usage: {
            tokenDelta: 10,
            recordedAt: "2026-05-30T12:00:00.000Z",
          },
        },
        updateReason: "Reached the token budget.",
        source: "lifecycle_hook",
      });
      expect(limited).toMatchObject({
        ok: true,
        action: "update",
        workingSet: {
          revision: 1,
          status: "budget_limited",
          snapshot: {
            budgets: {
              tokenBudget: 10,
              tokenUsed: 10,
              limitReason: "token",
              limitedAt: "2026-05-30T12:00:00.000Z",
            },
          },
        },
        event: { sequence: 2, eventType: "account_usage" },
      });

      const recovered = await service.run({
        action: "update",
        workingSetId: created.workingSet.id,
        expectedRevision: 1,
        operation: {
          type: "configure_budget",
          budget: {
            tokenBudget: 20,
          },
        },
        updateReason: "Raised the token budget.",
        source: "goal_command",
      });
      expect(recovered).toMatchObject({
        ok: true,
        action: "update",
        workingSet: {
          revision: 2,
          status: "active",
          snapshot: {
            budgets: {
              tokenBudget: 20,
              tokenUsed: 10,
            },
          },
        },
        event: { sequence: 3, eventType: "configure_budget" },
      });
      if (!recovered.ok || recovered.action !== "update") {
        throw new Error("Expected configure_budget recovery success.");
      }
      expect(recovered.workingSet.snapshot.budgets).not.toHaveProperty("limitReason");
      expect(recovered.workingSet.snapshot.budgets).not.toHaveProperty("limitedAt");
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

  it("keeps revision stable across mixed usage while event sequence remains append-only", async () => {
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
      expect(loaded.events?.every((event, index) => event.sequence === index + 1)).toBe(true);
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
        events: [
          { eventType: "account_usage", sequence: 2 },
          { eventType: "merge_checkpoint", sequence: 3 },
        ],
      });
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });

  it("rolls back prepare_external_goal_mutation usage when the checkpoint write fails", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const created = await service.run({
        action: "create",
        target: "goal",
        scope: TRUSTED_SCOPE,
        operation: {
          type: "set_objective",
          objective: "Prepare atomically before external mutation.",
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

      const failingRepository = createWorkingMemoryRepository(createCheckpointFailureDatabase(database));
      const failingService = createWorkingMemoryService(
        { workingMemory: true },
        {
          repository: failingRepository,
          sourceLabel: "test",
          now: () => new Date("2026-05-30T12:00:00.000Z"),
        },
      );

      await expect(
        failingService.prepareExternalGoalMutation({
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
        }),
      ).rejects.toThrow("Simulated checkpoint event insert failure.");

      const loaded = await service.run({
        action: "get",
        workingSetId: created.workingSet.id,
        includeEvents: true,
      });
      if (!loaded.ok || loaded.action !== "get") {
        throw new Error("Expected get success.");
      }

      expect(loaded.workingSet).toMatchObject({
        revision: 1,
        status: "active",
        snapshot: {
          budgets: {
            tokenBudget: 10,
          },
        },
      });
      expect(loaded.workingSet.snapshot.budgets?.tokenUsed).toBeUndefined();
      expect(loaded.workingSet.snapshot.budgets?.limitReason).toBeUndefined();
      expect(loaded.workingSet.snapshot.checkpoint).toBeUndefined();
      expect(loaded.events).toMatchObject([{ eventType: "created", sequence: 1 }]);
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });

  it("refuses to prepare goal mutations against a session-scoped working set id", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const created = await service.run({
        action: "create",
        target: "session",
        scope: TRUSTED_SCOPE,
        operation: {
          type: "set_objective",
          objective: "Session working set, not a goal.",
        },
        updateReason: "Started session set.",
        source: "lifecycle_hook",
      });
      if (!created.ok || created.action !== "create") {
        throw new Error("Expected create success.");
      }

      const prepared = await service.prepareExternalGoalMutation({
        mutationKind: "set",
        workingSetId: created.workingSet.id,
        scope: TRUSTED_SCOPE,
        checkpoint: {
          summary: "Stale host cache pointed at the session set.",
          recordedAt: "2026-05-30T12:10:00.000Z",
        },
        source: "goal_command",
      });

      expect(prepared).toMatchObject({
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

function createCheckpointFailureDatabase(database: SqlDatabase): SqlDatabase {
  const failingDatabase = Object.create(database) as SqlDatabase;
  failingDatabase.withTransaction = async (fn) =>
    database.withTransaction(async (transaction) => fn(createCheckpointFailureTransaction(transaction as SqlDatabase)));
  return failingDatabase;
}

function createCheckpointFailureTransaction(transaction: SqlDatabase): SqlDatabase {
  const failingTransaction = Object.create(transaction) as SqlDatabase;
  const execute: SqlDatabase["execute"] = (async (...executeArgs: Parameters<SqlDatabase["execute"]>) => {
    const [statementOrSql, args] = executeArgs;
    const statementArgs = typeof statementOrSql === "string" ? args : statementOrSql.args;
    if (Array.isArray(statementArgs) && statementArgs[3] === "merge_checkpoint") {
      throw new Error("Simulated checkpoint event insert failure.");
    }

    return transaction.execute(...executeArgs);
  }) as SqlDatabase["execute"];
  failingTransaction.execute = execute;
  return failingTransaction;
}
