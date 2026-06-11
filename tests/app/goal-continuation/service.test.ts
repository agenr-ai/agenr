import { describe, expect, it, vi } from "vitest";

import { createGoalContinuationService, type GoalContinuationCommand, type GoalContinuationHostResult } from "../../../src/app/goal-continuation/service.js";
import type { WorkingSetRecord } from "../../../src/app/working-memory/records.js";

const NOW = new Date("2026-06-11T12:00:00.000Z");

const SCHEDULE_COMMAND: GoalContinuationCommand = {
  kind: "schedule_continuation",
  workingSetId: "ws-goal-1",
  scope: { taskId: "task-1" },
  reason: "policy_on_idle",
};

/** Builds one eligible goal working-set record with optional overrides. */
function buildGoalWorkingSet(overrides: Partial<WorkingSetRecord> = {}): WorkingSetRecord {
  return {
    id: "ws-goal-1",
    scopeKey: "task:task-1",
    scopeKind: "task",
    status: "active",
    snapshot: {
      objective: "Ship the continuation loop",
      continuation: { policy: "on_idle" },
    },
    revision: 3,
    createdAt: "2026-06-11T10:00:00.000Z",
    updatedAt: "2026-06-11T11:00:00.000Z",
    lastActiveAt: "2026-06-11T11:00:00.000Z",
    ...overrides,
  };
}

/** Creates a service with an eligible goal set and a recording host port. */
function createScheduleHarness(workingSet: WorkingSetRecord | null, hostResult: GoalContinuationHostResult = { ok: true, scheduled: true }) {
  const runCommand = vi.fn(async (): Promise<GoalContinuationHostResult> => hostResult);
  const service = createGoalContinuationService(
    { goalContinuation: true },
    {
      hostPort: { runCommand },
      readWorkingSet: async () => workingSet,
      now: () => NOW,
    },
  );
  return { service, runCommand };
}

describe("createGoalContinuationService", () => {
  it("fails closed when the goalContinuation flag is disabled", async () => {
    const service = createGoalContinuationService({ goalContinuation: false });

    await expect(service.runCommand(SCHEDULE_COMMAND)).resolves.toEqual({
      ok: false,
      code: "feature_disabled",
      message: "Goal continuation is disabled by the goalContinuation feature flag.",
    });
  });

  it("fails through the host callback boundary when enabled without a registered host", async () => {
    const service = createGoalContinuationService({ goalContinuation: true });

    await expect(service.runCommand(SCHEDULE_COMMAND)).resolves.toEqual({
      ok: false,
      code: "host_callback_missing",
      message: "Goal continuation is host-owned; no host callback was registered for this Agenr runtime.",
    });
  });

  it("delegates eligible schedule commands to the host port", async () => {
    const { service, runCommand } = createScheduleHarness(buildGoalWorkingSet());

    await expect(service.runCommand(SCHEDULE_COMMAND)).resolves.toEqual({ ok: true, scheduled: true });
    expect(runCommand).toHaveBeenCalledWith(SCHEDULE_COMMAND);
  });

  it("delegates cancel commands without eligibility checks", async () => {
    const readWorkingSet = vi.fn(async () => null);
    const runCommand = vi.fn(async (): Promise<GoalContinuationHostResult> => ({ ok: true }));
    const service = createGoalContinuationService({ goalContinuation: true }, { hostPort: { runCommand }, readWorkingSet });

    const command: GoalContinuationCommand = { kind: "cancel_continuation", workingSetId: "ws-goal-1", reason: "goal_closed" };
    await expect(service.runCommand(command)).resolves.toEqual({ ok: true });
    expect(readWorkingSet).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledWith(command);
  });

  it("delegates query commands without eligibility checks", async () => {
    const runCommand = vi.fn(async (): Promise<GoalContinuationHostResult> => ({ ok: true, scheduled: false }));
    const service = createGoalContinuationService({ goalContinuation: true }, { hostPort: { runCommand } });

    const command: GoalContinuationCommand = { kind: "query_continuation", workingSetId: "ws-goal-1" };
    await expect(service.runCommand(command)).resolves.toEqual({ ok: true, scheduled: false });
    expect(runCommand).toHaveBeenCalledWith(command);
  });

  it("returns host_unavailable when the host port throws", async () => {
    const service = createGoalContinuationService(
      { goalContinuation: true },
      {
        hostPort: {
          runCommand: async () => {
            throw new Error("scheduler offline");
          },
        },
        readWorkingSet: async () => buildGoalWorkingSet(),
        now: () => NOW,
      },
    );

    await expect(service.runCommand(SCHEDULE_COMMAND)).resolves.toEqual({
      ok: false,
      code: "host_unavailable",
      message: "Goal-continuation host callback threw: scheduler offline",
    });
  });

  describe("schedule eligibility", () => {
    it("rejects scheduling when no working-set reader is wired", async () => {
      const runCommand = vi.fn(async (): Promise<GoalContinuationHostResult> => ({ ok: true }));
      const service = createGoalContinuationService({ goalContinuation: true }, { hostPort: { runCommand } });

      const result = await service.runCommand(SCHEDULE_COMMAND);
      expect(result).toMatchObject({ ok: false, code: "not_eligible" });
      expect(runCommand).not.toHaveBeenCalled();
    });

    it("rejects scheduling when the working set does not exist", async () => {
      const { service, runCommand } = createScheduleHarness(null);

      await expect(service.runCommand(SCHEDULE_COMMAND)).resolves.toEqual({
        ok: false,
        code: "not_eligible",
        message: "Goal continuation cannot be scheduled for working set ws-goal-1: the working set does not exist.",
      });
      expect(runCommand).not.toHaveBeenCalled();
    });

    it("rejects scheduling for session-scoped working sets", async () => {
      const { service, runCommand } = createScheduleHarness(buildGoalWorkingSet({ scopeKind: "session", scopeKey: "session:abc" }));

      const result = await service.runCommand(SCHEDULE_COMMAND);
      expect(result).toMatchObject({ ok: false, code: "not_eligible" });
      expect(runCommand).not.toHaveBeenCalled();
    });

    it("rejects scheduling when the goal is not active", async () => {
      const { service, runCommand } = createScheduleHarness(buildGoalWorkingSet({ status: "paused" }));

      await expect(service.runCommand(SCHEDULE_COMMAND)).resolves.toEqual({
        ok: false,
        code: "not_eligible",
        message: "Goal continuation cannot be scheduled for working set ws-goal-1: the goal status is paused, not active.",
      });
      expect(runCommand).not.toHaveBeenCalled();
    });

    it("rejects scheduling when the continuation policy is not on_idle", async () => {
      const manualPolicy = createScheduleHarness(buildGoalWorkingSet({ snapshot: { continuation: { policy: "manual" } } }));
      const unsetPolicy = createScheduleHarness(buildGoalWorkingSet({ snapshot: {} }));

      await expect(manualPolicy.service.runCommand(SCHEDULE_COMMAND)).resolves.toMatchObject({ ok: false, code: "not_eligible" });
      await expect(unsetPolicy.service.runCommand(SCHEDULE_COMMAND)).resolves.toMatchObject({ ok: false, code: "not_eligible" });
      expect(manualPolicy.runCommand).not.toHaveBeenCalled();
      expect(unsetPolicy.runCommand).not.toHaveBeenCalled();
    });

    it("rejects scheduling when a budget dimension is exhausted", async () => {
      const { service, runCommand } = createScheduleHarness(
        buildGoalWorkingSet({
          snapshot: {
            continuation: { policy: "on_idle" },
            budgets: { tokenBudget: 1000, tokenUsed: 1000, limitReason: "token" },
          },
        }),
      );

      await expect(service.runCommand(SCHEDULE_COMMAND)).resolves.toEqual({
        ok: false,
        code: "not_eligible",
        message: "Goal continuation cannot be scheduled for working set ws-goal-1: the token budget is exhausted.",
      });
      expect(runCommand).not.toHaveBeenCalled();
    });

    it("rejects scheduling before resumeAfter has elapsed", async () => {
      const { service, runCommand } = createScheduleHarness(
        buildGoalWorkingSet({ snapshot: { continuation: { policy: "on_idle", resumeAfter: "2026-06-11T13:00:00.000Z" } } }),
      );

      const result = await service.runCommand(SCHEDULE_COMMAND);
      expect(result).toMatchObject({ ok: false, code: "not_eligible" });
      expect(runCommand).not.toHaveBeenCalled();
    });

    it("rejects scheduling once staleAfter has passed", async () => {
      const { service, runCommand } = createScheduleHarness(
        buildGoalWorkingSet({ snapshot: { continuation: { policy: "on_idle", staleAfter: "2026-06-11T11:30:00.000Z" } } }),
      );

      const result = await service.runCommand(SCHEDULE_COMMAND);
      expect(result).toMatchObject({ ok: false, code: "not_eligible" });
      expect(runCommand).not.toHaveBeenCalled();
    });

    it("schedules when resumeAfter has elapsed and staleAfter has not passed", async () => {
      const { service, runCommand } = createScheduleHarness(
        buildGoalWorkingSet({
          snapshot: {
            continuation: {
              policy: "on_idle",
              resumeAfter: "2026-06-11T11:00:00.000Z",
              staleAfter: "2026-06-11T13:00:00.000Z",
            },
          },
        }),
      );

      await expect(service.runCommand(SCHEDULE_COMMAND)).resolves.toEqual({ ok: true, scheduled: true });
      expect(runCommand).toHaveBeenCalledWith(SCHEDULE_COMMAND);
    });
  });
});
