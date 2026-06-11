import { describe, expect, it } from "vitest";

import { WORKING_CONTEXT_PROJECTION_MAX_BYTES, WORKING_SNAPSHOT_ARRAY_LIMITS } from "../../../src/app/working-memory/limits.js";
import { closeWorkingMemoryTestService, createWorkingMemoryTestService } from "./service-test-helpers.js";

describe("createWorkingMemoryService", () => {
  it("creates, updates, renders, and closes a scoped working set", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const created = await service.run({
        action: "create",
        target: "goal",
        scope: {
          conversationKey: "session-1",
          sessionId: "session-1",
          cwd: "/tmp/project",
        },
        operation: {
          type: "set_objective",
          objective: "Implement working memory.",
          title: "Working memory implementation",
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
            objective: "Implement working memory.",
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
        target: "goal",
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

      const projection = updateWithoutRevisionForGoalCommand.projection;
      expect(projection).toMatchObject({
        renderMode: "full",
        revision: 3,
        sourceRef: expect.stringContaining("agenr_work:update:"),
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

      const projectionWithDecision = withDecision.projection;
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
        target: "goal",
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
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });

  it("keeps a long-running session projection under the byte cap with a visible truncation marker", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const scope = {
        conversationKey: "projection-budget",
        sessionId: "projection-budget",
        cwd: "/tmp/project",
      };
      const ensured = await service.ensureSessionWorkingSet({
        scope: {
          ...scope,
        },
        actor: "runtime",
        source: "lifecycle_hook",
      });
      if (!ensured.ok) {
        throw new Error("Expected session ensure success.");
      }

      let revision = ensured.workingSet.revision;
      let lastFiles = ensured.workingSet.snapshot.files;
      for (let index = 0; index < WORKING_SNAPSHOT_ARRAY_LIMITS.files + 10; index += 1) {
        const updated = await service.run({
          action: "update",
          workingSetId: ensured.workingSet.id,
          expectedRevision: revision,
          operation: {
            type: "add_file_note",
            file: {
              path: `src/generated/long-running-${index}.ts`,
              note: "x".repeat(2000),
            },
          },
          updateReason: `Recorded generated note ${index}.`,
          actor: "model",
          source: "tool",
        });
        if (!updated.ok || updated.action !== "update") {
          throw new Error("Expected update success.");
        }

        revision = updated.workingSet.revision;
        lastFiles = updated.workingSet.snapshot.files;
      }

      expect(lastFiles).toHaveLength(WORKING_SNAPSHOT_ARRAY_LIMITS.files);
      expect(lastFiles?.[0]?.path).toBe("src/generated/long-running-10.ts");

      const projection = await service.renderProjectionBundle({
        sourceRef: "test:projection-budget",
        scope,
      });

      expect(projection.renderMode).toBe("full");
      expect(projection.byteLength).toBeLessThanOrEqual(WORKING_CONTEXT_PROJECTION_MAX_BYTES);
      expect(projection.content).toContain("agenr_work_context truncated");
      expect(projection.content.endsWith("</agenr_work_context>")).toBe(true);
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });

  it("increments revision for checkpoints and treats complete as scope-occupying until clear", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const created = await service.run({
        action: "create",
        target: "goal",
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
        source: "goal_command",
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
          target: "goal",
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

  it("gates set_status to trusted host sources at the app layer", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const created = await service.run({
        action: "create",
        target: "goal",
        scope: {
          conversationKey: "session-status-gate",
          sessionId: "session-status-gate",
          cwd: "/tmp/project",
        },
        operation: {
          type: "set_objective",
          objective: "Prove status updates are host-only.",
        },
        updateReason: "User set a goal.",
        source: "goal_command",
      });
      if (!created.ok || created.action !== "create") {
        throw new Error("Expected create success.");
      }

      await expect(
        service.run({
          action: "update",
          workingSetId: created.workingSet.id,
          expectedRevision: created.workingSet.revision,
          operation: {
            type: "set_status",
            status: "paused",
          },
          updateReason: "Attempted model status update.",
          actor: "model",
          source: "tool",
        }),
      ).resolves.toMatchObject({
        ok: false,
        code: "invalid_request",
        message: "set_status is reserved for trusted host runtime paths.",
      });

      const trustedUpdates = [
        { source: "goal_command", status: "paused" },
        { source: "lifecycle_hook", status: "active" },
        { source: "consolidation_job", status: "needs_review" },
      ] as const;

      let revision = created.workingSet.revision;
      for (const update of trustedUpdates) {
        const result = await service.run({
          action: "update",
          workingSetId: created.workingSet.id,
          operation: {
            type: "set_status",
            status: update.status,
          },
          updateReason: `Trusted ${update.source} status update.`,
          source: update.source,
        });

        expect(result).toMatchObject({
          ok: true,
          action: "update",
          workingSet: {
            revision: revision + 1,
            status: update.status,
          },
          event: {
            eventType: "set_status",
          },
        });
        if (!result.ok || result.action !== "update") {
          throw new Error("Expected trusted status update success.");
        }
        revision = result.workingSet.revision;
      }
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });
});
