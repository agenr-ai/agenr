import { describe, expect, it } from "vitest";

import { createWorkingMemoryService } from "../../../src/app/working-memory/service.js";
import { closeWorkingMemoryTestService, createWorkingMemoryTestService } from "./service-test-helpers.js";

describe("createWorkingMemoryService session layer", () => {
  it("keeps session working memory independent from goal working memory", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const scope = {
        conversationKey: "session-independent",
        sessionId: "session-independent",
        cwd: "/tmp/project",
      };

      const ensured = await service.ensureSessionWorkingSet({
        scope,
        actor: "runtime",
        source: "lifecycle_hook",
      });
      expect(ensured).toMatchObject({
        ok: true,
        workingSet: {
          scopeKind: "session",
          scopeKey: "session:session-independent:cwd:/tmp/project",
          revision: 1,
          status: "active",
          snapshot: {},
        },
      });
      if (!ensured.ok) {
        throw new Error("Expected session ensure success.");
      }
      expect(ensured.created).toBe(true);

      const sessionScratchpad = await service.run({
        action: "update",
        target: "session",
        scope,
        expectedRevision: ensured.workingSet.revision,
        operation: {
          type: "set_scratchpad",
          scratchpad: "Ordinary session note that is not a goal.",
        },
        updateReason: "Recorded session scratchpad.",
        actor: "model",
        source: "tool",
      });
      expect(sessionScratchpad).toMatchObject({
        ok: true,
        action: "update",
        workingSet: {
          scopeKind: "session",
          revision: 2,
          snapshot: {
            scratchpad: "Ordinary session note that is not a goal.",
          },
        },
      });
      if (!sessionScratchpad.ok || sessionScratchpad.action !== "update") {
        throw new Error("Expected session scratchpad update success.");
      }

      const goal = await service.run({
        action: "create",
        target: "goal",
        scope,
        operation: {
          type: "set_objective",
          objective: "Ship the explicit goal.",
        },
        initialSnapshot: sessionScratchpad.workingSet.snapshot,
        updateReason: "User created a goal from the session.",
        actor: "user",
        source: "goal_command",
      });
      expect(goal).toMatchObject({
        ok: true,
        action: "create",
        workingSet: {
          scopeKind: "conversation",
          scopeKey: "conversation:session-independent",
          revision: 1,
          snapshot: {
            objective: "Ship the explicit goal.",
            scratchpad: "Ordinary session note that is not a goal.",
          },
        },
      });
      if (!goal.ok || goal.action !== "create") {
        throw new Error("Expected goal create success.");
      }

      await expect(service.run({ action: "get", scope })).resolves.toMatchObject({
        ok: true,
        action: "get",
        workingSet: {
          id: goal.workingSet.id,
        },
      });

      await expect(service.run({ action: "get", target: "session", scope })).resolves.toMatchObject({
        ok: true,
        action: "get",
        workingSet: {
          id: sessionScratchpad.workingSet.id,
          snapshot: {
            scratchpad: "Ordinary session note that is not a goal.",
          },
        },
      });

      const autoUpdate = await service.run({
        action: "update",
        scope,
        expectedRevision: goal.workingSet.revision,
        operation: {
          type: "set_scratchpad",
          scratchpad: "Auto target updated the goal.",
        },
        updateReason: "Proved auto target prefers the goal layer.",
        actor: "model",
        source: "tool",
      });
      expect(autoUpdate).toMatchObject({
        ok: true,
        action: "update",
        workingSet: {
          id: goal.workingSet.id,
          scopeKind: "conversation",
          snapshot: {
            scratchpad: "Auto target updated the goal.",
          },
        },
      });
      await expect(service.run({ action: "get", target: "session", scope })).resolves.toMatchObject({
        ok: true,
        action: "get",
        workingSet: {
          id: sessionScratchpad.workingSet.id,
          snapshot: {
            scratchpad: "Ordinary session note that is not a goal.",
          },
        },
      });

      const idOverride = await service.run({
        action: "update",
        target: "goal",
        workingSetId: sessionScratchpad.workingSet.id,
        expectedRevision: sessionScratchpad.workingSet.revision,
        operation: {
          type: "set_scratchpad",
          scratchpad: "Updated by explicit workingSetId.",
        },
        updateReason: "Proved workingSetId wins over target.",
        actor: "model",
        source: "tool",
      });
      expect(idOverride).toMatchObject({
        ok: true,
        action: "update",
        workingSet: {
          id: sessionScratchpad.workingSet.id,
          revision: 3,
          snapshot: {
            scratchpad: "Updated by explicit workingSetId.",
          },
        },
      });
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });

  it("reads session snapshots for goal fork without creating session sets", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const scope = {
        conversationKey: "session-fork",
        sessionId: "session-fork",
        cwd: "/tmp/project",
      };

      await expect(service.readSessionSnapshotForFork(scope)).resolves.toBeUndefined();

      const ensured = await service.ensureSessionWorkingSet({
        scope,
        actor: "runtime",
        source: "lifecycle_hook",
      });
      if (!ensured.ok) {
        throw new Error("Expected session ensure success.");
      }
      expect(ensured.created).toBe(true);

      await service.run({
        action: "update",
        target: "session",
        scope,
        expectedRevision: ensured.workingSet.revision,
        operation: {
          type: "set_scratchpad",
          scratchpad: "Fork me.",
        },
        updateReason: "Recorded session scratchpad.",
        actor: "model",
        source: "tool",
      });

      await expect(service.readSessionSnapshotForFork(scope)).resolves.toEqual({
        scratchpad: "Fork me.",
      });
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });

  it("reports non-absence fork-read failures through the optional callback", async () => {
    const issues: string[] = [];
    const { database, dbPath, repository } = await createWorkingMemoryTestService();

    try {
      const service = createWorkingMemoryService(
        { workingMemory: true },
        {
          repository,
          onForkSnapshotReadIssue: (failure) => {
            issues.push(failure.code);
          },
        },
      );

      await expect(service.readSessionSnapshotForFork({ sessionId: "missing-session" })).resolves.toBeUndefined();
      expect(issues).toEqual([]);

      await expect(service.readSessionSnapshotForFork({})).resolves.toBeUndefined();
      expect(issues).toEqual(["missing_scope"]);
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });
});
