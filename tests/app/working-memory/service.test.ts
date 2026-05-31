import { describe, expect, it } from "vitest";

import { closeWorkingMemoryTestService, createWorkingMemoryTestService } from "./service-test-helpers.js";

describe("createWorkingMemoryService", () => {
  it("creates, updates, renders, and closes a scoped working set", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const created = await service.run({
        action: "create",
        scope: {
          conversationKey: "session-1",
          sessionId: "session-1",
          cwd: "/tmp/project",
        },
        operation: {
          type: "set_objective",
          objective: "Implement Phase 1 working memory.",
          title: "Working memory Phase 1",
        },
        updateReason: "User set a goal.",
        actor: "user",
        source: "goal_command",
      });

      expect(created).toMatchObject({
        ok: true,
        action: "create",
        workingSet: {
          revision: 1,
          status: "active",
          snapshot: {
            objective: "Implement Phase 1 working memory.",
            continuation: { policy: "manual" },
          },
        },
      });
      if (!created.ok || created.action !== "create") {
        throw new Error("Expected create success.");
      }

      const stale = await service.run({
        action: "update",
        workingSetId: created.workingSet.id,
        expectedRevision: 0,
        operation: {
          type: "add_file_note",
          file: {
            path: "src/app/working-memory/service.ts",
            note: "Service applies typed operations.",
          },
        },
        updateReason: "Observed implementation file.",
      });
      expect(stale).toMatchObject({
        ok: false,
        code: "revision_conflict",
        details: {
          actualRevision: 1,
          workingSetId: created.workingSet.id,
        },
      });

      const updated = await service.run({
        action: "update",
        workingSetId: created.workingSet.id,
        expectedRevision: 1,
        operation: {
          type: "add_file_note",
          file: {
            path: "src/app/working-memory/service.ts",
            note: "Service applies typed operations.",
          },
        },
        updateReason: "Observed implementation file.",
        actor: "model",
        source: "tool",
      });
      expect(updated).toMatchObject({
        ok: true,
        action: "update",
        workingSet: {
          revision: 2,
          snapshot: {
            files: [
              {
                path: "src/app/working-memory/service.ts",
                note: "Service applies typed operations.",
              },
            ],
          },
        },
        event: {
          sequence: 2,
          eventType: "add_file_note",
        },
      });

      const updateWithoutRevisionForTool = await service.run({
        action: "update",
        source: "tool",
        scope: {
          conversationKey: "session-1",
          sessionId: "session-1",
          cwd: "/tmp/project",
        },
        operation: {
          type: "add_file_note",
          file: {
            path: "src/app/working-memory/handlers/update.ts",
            note: "Model updates must include expectedRevision.",
          },
        },
        updateReason: "Attempted model update without explicit revision.",
      });
      expect(updateWithoutRevisionForTool).toMatchObject({
        ok: false,
        code: "invalid_request",
        message: "expectedRevision must be a non-negative integer.",
      });

      const updateWithoutRevisionForGoalCommand = await service.run({
        action: "update",
        source: "goal_command",
        scope: {
          conversationKey: "session-1",
          sessionId: "session-1",
          cwd: "/tmp/project",
        },
        operation: {
          type: "add_file_note",
          file: {
            path: "src/app/working-memory/handlers/update.ts",
            note: "Scope-selected update without explicit revision.",
          },
        },
        updateReason: "Recorded progress without explicit revision.",
      });
      expect(updateWithoutRevisionForGoalCommand).toMatchObject({
        ok: true,
        action: "update",
        workingSet: {
          revision: 3,
        },
        event: {
          sequence: 3,
          eventType: "add_file_note",
        },
      });

      const duplicateCreate = await service.run({
        action: "create",
        scope: {
          conversationKey: "session-1",
          sessionId: "session-1",
          cwd: "/tmp/project",
        },
        operation: {
          type: "set_objective",
          objective: "Replace active goal.",
        },
        updateReason: "Attempted duplicate create.",
      });
      expect(duplicateCreate).toMatchObject({
        ok: false,
        code: "active_set_exists",
        details: {
          workingSetId: created.workingSet.id,
          scopeKey: expect.any(String),
        },
      });

      const projection = await service.renderProjection({
        sourceRef: "test:before-turn",
        scope: {
          conversationKey: "session-1",
          sessionId: "session-1",
          cwd: "/tmp/project",
        },
      });
      expect(projection).toMatchObject({
        renderMode: "full",
        revision: 3,
        sourceRef: "test:before-turn",
      });
      expect(projection.content).toContain("<agenr_work_context>");
      expect(projection.content).toContain("This is transient working memory");
      expect(projection.content).toContain("src/app/working-memory/service.ts");
      expect(projection.content).toContain("src/app/working-memory/handlers/update.ts");

      const withDecision = await service.run({
        action: "update",
        workingSetId: created.workingSet.id,
        expectedRevision: 3,
        operation: {
          type: "record_decision",
          decision: {
            decision: "Keep create and update as separate actions.",
            rationale: "Explicit contracts are easier to maintain.",
          },
        },
        updateReason: "Recorded implementation decision.",
      });
      if (!withDecision.ok || withDecision.action !== "update") {
        throw new Error("Expected decision update success.");
      }

      const projectionWithDecision = await service.renderProjection({
        sourceRef: "test:decision",
        scope: {
          conversationKey: "session-1",
          sessionId: "session-1",
          cwd: "/tmp/project",
        },
      });
      expect(projectionWithDecision.content).toContain("Decisions:");
      expect(projectionWithDecision.content).toContain("Keep create and update as separate actions.");

      const closed = await service.run({
        action: "close",
        workingSetId: created.workingSet.id,
        expectedRevision: 4,
        closeReason: "Task complete.",
        createEpisode: true,
        actor: "user",
        source: "goal_command",
      });
      expect(closed).toMatchObject({
        ok: true,
        action: "close",
        workingSet: {
          revision: 5,
          status: "closed",
          closeReason: "Task complete.",
          snapshot: {
            checkpoint: {
              summary: "Task complete.",
            },
          },
        },
        event: {
          sequence: 5,
          eventType: "closed",
        },
        candidates: [
          {
            kind: "episodic",
            promotionStatus: "pending",
            provenance: {
              evidenceEventSequences: [1, 2, 3, 4],
            },
          },
        ],
      });

      const recreated = await service.run({
        action: "create",
        scope: {
          conversationKey: "session-2",
          sessionId: "session-2",
          cwd: "/tmp/other",
        },
        operation: {
          type: "set_objective",
          objective: "Second task.",
        },
        updateReason: "Started another task.",
      });
      if (!recreated.ok || recreated.action !== "create") {
        throw new Error("Expected recreate success.");
      }

      const abandoned = await service.run({
        action: "close",
        workingSetId: recreated.workingSet.id,
        expectedRevision: recreated.workingSet.revision,
        closeReason: "No longer pursuing this path.",
        closeMode: "abandon",
        actor: "user",
        source: "goal_command",
      });
      expect(abandoned).toMatchObject({
        ok: true,
        action: "close",
        workingSet: {
          status: "abandoned",
        },
        event: {
          eventType: "abandoned",
        },
      });

      const afterCloseProjection = await service.renderProjection({
        sourceRef: "test:after-close",
        scope: {
          conversationKey: "session-1",
          sessionId: "session-1",
          cwd: "/tmp/project",
        },
      });
      expect(afterCloseProjection).toMatchObject({
        renderMode: "stub",
        content: expect.stringContaining("Reason: missing_active_set"),
      });
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });

  it("increments revision for checkpoints and treats complete as scope-occupying until clear", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const created = await service.run({
        action: "create",
        scope: {
          conversationKey: "session-checkpoint",
          sessionId: "session-checkpoint",
          cwd: "/tmp/project",
        },
        operation: {
          type: "set_objective",
          objective: "Prove checkpoints move the revision.",
        },
        updateReason: "User set a goal.",
      });
      if (!created.ok || created.action !== "create") {
        throw new Error("Expected create success.");
      }

      const checkpointed = await service.run({
        action: "update",
        workingSetId: created.workingSet.id,
        expectedRevision: created.workingSet.revision,
        operation: {
          type: "merge_checkpoint",
          checkpoint: {
            summary: "Implemented the checkpoint contract.",
            recordedAt: "2026-05-30T12:00:00.000Z",
            nextActions: ["Run focused tests"],
          },
        },
        updateReason: "Recorded material checkpoint.",
      });
      expect(checkpointed).toMatchObject({
        ok: true,
        action: "update",
        workingSet: {
          revision: 2,
          snapshot: {
            checkpoint: {
              summary: "Implemented the checkpoint contract.",
            },
            nextActions: [{ text: "Run focused tests", status: "pending" }],
          },
        },
        event: {
          sequence: 2,
          eventType: "merge_checkpoint",
        },
      });

      const completed = await service.run({
        action: "update",
        workingSetId: created.workingSet.id,
        expectedRevision: 2,
        operation: {
          type: "set_status",
          status: "complete",
        },
        updateReason: "Goal completed.",
      });
      expect(completed).toMatchObject({
        ok: true,
        action: "update",
        workingSet: {
          revision: 3,
          status: "complete",
        },
      });

      await expect(
        service.run({
          action: "update",
          workingSetId: created.workingSet.id,
          expectedRevision: 3,
          operation: {
            type: "add_file_note",
            file: {
              path: "src/app/working-memory/service.ts",
            },
          },
          updateReason: "Attempted post-completion mutation.",
        }),
      ).resolves.toMatchObject({
        ok: false,
        code: "terminal_status",
      });

      await expect(
        service.run({
          action: "create",
          scope: {
            conversationKey: "session-checkpoint",
            sessionId: "session-checkpoint",
            cwd: "/tmp/project",
          },
          operation: {
            type: "set_objective",
            objective: "Conflicting goal.",
          },
          updateReason: "Attempted duplicate create.",
        }),
      ).resolves.toMatchObject({
        ok: false,
        code: "active_set_exists",
      });

      await expect(
        service.run({
          action: "get",
          scope: {
            conversationKey: "session-checkpoint",
            sessionId: "session-checkpoint",
            cwd: "/tmp/project",
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
        action: "get",
        workingSet: {
          id: created.workingSet.id,
          status: "complete",
          revision: 3,
        },
      });

      await expect(
        service.run({
          action: "close",
          scope: {
            conversationKey: "session-checkpoint",
            sessionId: "session-checkpoint",
            cwd: "/tmp/project",
          },
          closeReason: "User cleared completed goal without explicit revision.",
          actor: "user",
          source: "goal_command",
        }),
      ).resolves.toMatchObject({
        ok: true,
        action: "close",
        workingSet: {
          id: created.workingSet.id,
          revision: 4,
          status: "closed",
          closeReason: "User cleared completed goal without explicit revision.",
        },
      });
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });

  it("stores phase 5 continuation, budget, and external mutation prep state", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const scope = {
        conversationKey: "session-phase-5",
        sessionId: "session-phase-5",
        cwd: "/tmp/project",
      };
      const created = await service.run({
        action: "create",
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
        throw new Error("Expected phase 5 create success.");
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
        events: [{ eventType: "merge_checkpoint", sequence: 3 }],
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
