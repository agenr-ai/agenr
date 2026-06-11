import type { ExtensionContext } from "../../../src/adapters/skeln/skeln-types.js";
import { describe, expect, it, vi } from "vitest";

import { executeAgenrSkelnGoalContinuationCommand } from "../../../src/adapters/skeln/goal-continuation-command.js";
import type { createAgenrSkelnServices } from "../../../src/adapters/skeln/runtime.js";
import type { AgenrSkelnSessionScope } from "../../../src/adapters/skeln/types.js";
import type { GoalContinuationCommand, GoalContinuationResult } from "../../../src/app/goal-continuation/service.js";

const SCOPE: AgenrSkelnSessionScope = {
  sessionId: "session-1",
  sessionKey: "skeln:session:1",
  cwd: "/tmp/project",
  gitRoot: "/tmp/project",
  gitBranch: "main",
};

/** Builds a services stub whose goal-continuation boundary records commands. */
function createHarness(result: GoalContinuationResult = { ok: true, scheduled: true }) {
  const runCommand = vi.fn(async (_command: GoalContinuationCommand): Promise<GoalContinuationResult> => result);
  const servicesPromise = Promise.resolve({
    goalContinuation: { runCommand },
  }) as ReturnType<typeof createAgenrSkelnServices>;
  return { servicesPromise, runCommand };
}

describe("executeAgenrSkelnGoalContinuationCommand", () => {
  it("merges the resolved session scope under explicit overrides for schedule commands", async () => {
    const { servicesPromise, runCommand } = createHarness();

    const result = await executeAgenrSkelnGoalContinuationCommand(servicesPromise, async () => SCOPE, {} as ExtensionContext, {
      kind: "schedule_continuation",
      workingSetId: "ws-goal-1",
      reason: "policy_on_idle",
      scope: { taskId: "task-override" },
    });

    expect(result).toEqual({ ok: true, scheduled: true });
    expect(runCommand).toHaveBeenCalledWith({
      kind: "schedule_continuation",
      workingSetId: "ws-goal-1",
      reason: "policy_on_idle",
      scope: {
        sessionId: "session-1",
        conversationKey: "session-1",
        cwd: "/tmp/project",
        gitRoot: "/tmp/project",
        gitBranch: "main",
        taskId: "task-override",
      },
    });
  });

  it("passes cancel commands through without resolving session scope", async () => {
    const { servicesPromise, runCommand } = createHarness({ ok: true });
    const resolveScope = vi.fn(async () => SCOPE);

    const result = await executeAgenrSkelnGoalContinuationCommand(servicesPromise, resolveScope, {} as ExtensionContext, {
      kind: "cancel_continuation",
      workingSetId: "ws-goal-1",
      reason: "goal_closed",
    });

    expect(result).toEqual({ ok: true });
    expect(resolveScope).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledWith({
      kind: "cancel_continuation",
      workingSetId: "ws-goal-1",
      reason: "goal_closed",
    });
  });
});
