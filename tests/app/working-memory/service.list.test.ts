import { describe, expect, it } from "vitest";

import { closeWorkingMemoryTestService, createWorkingMemoryTestService } from "./service-test-helpers.js";

describe("createWorkingMemoryService list", () => {
  it("lists working sets across auto-resolved scopes and applies the global limit", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const scope = {
        conversationKey: "list-auto",
        sessionId: "list-auto",
        cwd: "/tmp/project",
      };

      const session = await service.ensureSessionWorkingSet({
        scope,
        actor: "runtime",
        source: "lifecycle_hook",
      });
      if (!session.ok) {
        throw new Error("Expected session ensure success.");
      }

      const goal = await service.run({
        action: "create",
        target: "goal",
        scope,
        operation: {
          type: "set_objective",
          objective: "Ship list coverage.",
        },
        updateReason: "Created goal for list test.",
      });
      if (!goal.ok || goal.action !== "create") {
        throw new Error("Expected goal create success.");
      }

      const listed = await service.run({
        action: "list",
        scope,
      });
      expect(listed).toMatchObject({
        ok: true,
        action: "list",
      });
      if (!listed.ok || listed.action !== "list") {
        throw new Error("Expected list success.");
      }

      expect(listed.workingSets.map((set) => set.id).sort()).toEqual([goal.workingSet.id, session.workingSet.id].sort());
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });

  it("filters list output by explicit statuses", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const scope = {
        conversationKey: "list-status",
        sessionId: "list-status",
        cwd: "/tmp/project",
      };

      const created = await service.run({
        action: "create",
        target: "goal",
        scope,
        operation: {
          type: "set_objective",
          objective: "Pause and resume list filtering.",
        },
        updateReason: "Created goal for status filter test.",
      });
      if (!created.ok || created.action !== "create") {
        throw new Error("Expected goal create success.");
      }

      const paused = await service.run({
        action: "update",
        workingSetId: created.workingSet.id,
        expectedRevision: created.workingSet.revision,
        operation: {
          type: "set_status",
          status: "paused",
        },
        updateReason: "Paused goal for list filter test.",
        source: "goal_command",
      });
      if (!paused.ok || paused.action !== "update") {
        throw new Error("Expected pause update success.");
      }

      const activeOnly = await service.run({
        action: "list",
        scope,
        statuses: ["active"],
      });
      expect(activeOnly).toMatchObject({
        ok: true,
        action: "list",
        workingSets: [],
      });

      const pausedOnly = await service.run({
        action: "list",
        scope,
        statuses: ["paused"],
      });
      expect(pausedOnly).toMatchObject({
        ok: true,
        action: "list",
        workingSets: [
          {
            id: created.workingSet.id,
            status: "paused",
          },
        ],
      });
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });

  it("lists all working sets when no scope is supplied", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const first = await service.run({
        action: "create",
        target: "session",
        scope: {
          conversationKey: "list-global-1",
          sessionId: "list-global-1",
          cwd: "/tmp/one",
        },
        operation: {
          type: "set_objective",
          objective: "First global list set.",
        },
        updateReason: "Created first list fixture.",
      });
      const second = await service.run({
        action: "create",
        target: "session",
        scope: {
          conversationKey: "list-global-2",
          sessionId: "list-global-2",
          cwd: "/tmp/two",
        },
        operation: {
          type: "set_objective",
          objective: "Second global list set.",
        },
        updateReason: "Created second list fixture.",
      });
      if (!first.ok || first.action !== "create" || !second.ok || second.action !== "create") {
        throw new Error("Expected both create fixtures to succeed.");
      }

      const listed = await service.run({ action: "list", listLimit: 10 });
      if (!listed.ok || listed.action !== "list") {
        throw new Error("Expected global list success.");
      }

      expect(listed.workingSets.map((set) => set.id)).toEqual(expect.arrayContaining([first.workingSet.id, second.workingSet.id]));
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });

  it("excludes closed working sets by default and includes them when explicitly requested", async () => {
    const { database, dbPath, service } = await createWorkingMemoryTestService();

    try {
      const scope = {
        conversationKey: "list-default-status",
        sessionId: "list-default-status",
        cwd: "/tmp/project",
      };

      const created = await service.run({
        action: "create",
        target: "goal",
        scope,
        operation: {
          type: "set_objective",
          objective: "Close and list again.",
        },
        updateReason: "Created goal for default status filter test.",
      });
      if (!created.ok || created.action !== "create") {
        throw new Error("Expected goal create success.");
      }

      const closed = await service.run({
        action: "close",
        workingSetId: created.workingSet.id,
        expectedRevision: created.workingSet.revision,
        closeReason: "Closed for default list filter test.",
        actor: "user",
        source: "goal_command",
      });
      if (!closed.ok || closed.action !== "close") {
        throw new Error("Expected close success.");
      }

      const defaultList = await service.run({ action: "list", scope });
      if (!defaultList.ok || defaultList.action !== "list") {
        throw new Error("Expected default list success.");
      }
      expect(defaultList.workingSets.map((set) => set.id)).not.toContain(created.workingSet.id);

      const closedList = await service.run({
        action: "list",
        scope,
        statuses: ["closed"],
      });
      if (!closedList.ok || closedList.action !== "list") {
        throw new Error("Expected closed list success.");
      }
      expect(closedList.workingSets).toMatchObject([
        {
          id: created.workingSet.id,
          status: "closed",
        },
      ]);
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });
});
