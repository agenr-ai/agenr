import { describe, expect, it } from "vitest";

import { WORKING_CONTEXT_GOAL_SECTION_LABEL, WORKING_CONTEXT_SESSION_SECTION_LABEL } from "../../../src/app/working-memory/projection-section-labels.js";
import { toWorkingContextAuditPointer } from "../../../src/app/working-memory/projection.js";
import { createWorkingMemoryService } from "../../../src/app/working-memory/service.js";
import { createProjectionRepository, createTestWorkingSet, createWorkingMemoryTestService, closeWorkingMemoryTestService } from "./service-test-helpers.js";

describe("createWorkingMemoryService projection bundles", () => {
  it("renders session and goal sections with session audit provenance", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const scope = {
        conversationKey: "bundle-audit",
        sessionId: "bundle-audit",
        cwd: "/tmp/project",
      };

      const ensured = await service.ensureSessionWorkingSet({
        scope,
        actor: "runtime",
        source: "lifecycle_hook",
      });
      if (!ensured.ok) {
        throw new Error("Expected session ensure success.");
      }

      await service.run({
        action: "update",
        target: "session",
        scope,
        expectedRevision: ensured.workingSet.revision,
        operation: {
          type: "set_scratchpad",
          scratchpad: "Session scratchpad.",
        },
        updateReason: "Recorded session scratchpad.",
        actor: "model",
        source: "tool",
      });

      const goal = await service.run({
        action: "create",
        target: "goal",
        scope,
        operation: {
          type: "set_objective",
          objective: "Bundle goal.",
        },
        updateReason: "Created goal for bundle audit test.",
        actor: "user",
        source: "goal_command",
      });
      if (!goal.ok || goal.action !== "create") {
        throw new Error("Expected goal create success.");
      }

      const bundled = await service.renderProjectionBundle({
        sourceRef: "test:bundle-audit",
        scope,
      });
      expect(bundled).toMatchObject({
        renderMode: "full",
        sourceRef: "test:bundle-audit",
        workingSetId: ensured.workingSet.id,
        revision: 2,
      });
      expect(bundled.content).toContain(`## ${WORKING_CONTEXT_SESSION_SECTION_LABEL}`);
      expect(bundled.content).toContain(`## ${WORKING_CONTEXT_GOAL_SECTION_LABEL}`);
      expect(toWorkingContextAuditPointer(bundled)).toMatchObject({
        source: "agenr_work",
        workingSetId: ensured.workingSet.id,
        revision: 2,
        sourceRef: "test:bundle-audit",
      });
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });

  it("selects an existing session working set during bundle render", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const scope = {
        conversationKey: "bundle-select-session",
        sessionId: "bundle-select-session",
        cwd: "/tmp/project",
      };

      const ensured = await service.ensureSessionWorkingSet({
        scope,
        actor: "runtime",
        source: "lifecycle_hook",
      });
      if (!ensured.ok) {
        throw new Error("Expected session ensure success.");
      }

      const bundled = await service.renderProjectionBundle({
        sourceRef: "test:bundle-select-session",
        scope,
      });

      expect(bundled.renderMode).toBe("full");
      expect(bundled.content).toContain(`## ${WORKING_CONTEXT_SESSION_SECTION_LABEL}`);
      expect(bundled.workingSetId).toBe(ensured.workingSet.id);
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });

  it("reuses a pre-resolved session working set when rendering bundles", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const scope = {
        conversationKey: "bundle-preset-session",
        sessionId: "bundle-preset-session",
        cwd: "/tmp/project",
      };

      const ensured = await service.ensureSessionWorkingSet({
        scope,
        actor: "runtime",
        source: "lifecycle_hook",
      });
      if (!ensured.ok) {
        throw new Error("Expected session ensure success.");
      }

      const bundled = await service.renderProjectionBundle({
        sourceRef: "test:preset-session",
        scope,
        sessionWorkingSet: ensured.workingSet,
      });

      expect(bundled.renderMode).toBe("full");
      expect(bundled.content).toContain(`## ${WORKING_CONTEXT_SESSION_SECTION_LABEL}`);
      expect(bundled.workingSetId).toBe(ensured.workingSet.id);
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });

  it("renders abnormal goal selection failures inside projection bundles", async () => {
    const session = createTestWorkingSet({
      id: "session-set",
      scopeKind: "session",
      scopeKey: "session:projection-failure",
      snapshot: {
        scratchpad: "Session state remains useful.",
      },
    });
    const firstGoal = createTestWorkingSet({
      id: "goal-1",
      scopeKind: "conversation",
      scopeKey: "conversation:projection-failure",
      snapshot: {
        objective: "First goal.",
      },
    });
    const secondGoal = createTestWorkingSet({
      id: "goal-2",
      scopeKind: "conversation",
      scopeKey: "conversation:projection-failure",
      snapshot: {
        objective: "Second goal.",
      },
    });
    const repository = createProjectionRepository(session, [firstGoal, secondGoal]);
    const service = createWorkingMemoryService(
      { workingMemory: true },
      {
        repository,
      },
    );

    const projection = await service.renderProjectionBundle({
      sourceRef: "test:projection-failure",
      scope: {
        conversationKey: "projection-failure",
        sessionId: "projection-failure",
      },
      sessionWorkingSet: session,
    });

    expect(projection.renderMode).toBe("full");
    expect(projection.content).toContain(`## ${WORKING_CONTEXT_SESSION_SECTION_LABEL}`);
    expect(projection.content).toContain("Session state remains useful.");
    expect(projection.content).toContain(`## ${WORKING_CONTEXT_GOAL_SECTION_LABEL}`);
    expect(projection.content).toContain("Warning: Goal working set could not be selected: Multiple current working sets matched the resolved scope.");
    expect(projection.workingSetId).toBe(session.id);
  });
});
