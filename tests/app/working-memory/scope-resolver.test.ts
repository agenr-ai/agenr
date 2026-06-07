import { describe, expect, it } from "vitest";

import { resolveGoalWorkingScope } from "../../../src/app/working-memory/scope-resolver.js";

describe("resolveGoalWorkingScope", () => {
  it("prefers task scope when taskId is present", () => {
    expect(resolveGoalWorkingScope({ taskId: "TASK-1", conversationKey: "thread-1" })).toEqual({
      ok: true,
      scope: expect.objectContaining({
        scopeKind: "task",
        scopeKey: "task:TASK-1",
        taskId: "TASK-1",
      }),
    });
  });

  it("resolves conversation scope from conversationKey", () => {
    expect(resolveGoalWorkingScope({ conversationKey: "thread-1" })).toEqual({
      ok: true,
      scope: expect.objectContaining({
        scopeKind: "conversation",
        scopeKey: "conversation:thread-1",
      }),
    });
  });

  it("resolves git branch scope when gitRoot and gitBranch are present", () => {
    expect(
      resolveGoalWorkingScope({
        project: "agenr",
        gitRoot: "/repo",
        gitBranch: "main",
      }),
    ).toEqual({
      ok: true,
      scope: expect.objectContaining({
        scopeKind: "git_branch",
        scopeKey: "git_branch:agenr:/repo:main",
      }),
    });
  });

  it("resolves git cwd scope when gitRoot and cwd are present without higher-priority facts", () => {
    expect(
      resolveGoalWorkingScope({
        project: "agenr",
        gitRoot: "/repo",
        cwd: "/repo/src",
      }),
    ).toEqual({
      ok: true,
      scope: expect.objectContaining({
        scopeKind: "git_cwd",
        scopeKey: "git_cwd:agenr:/repo:/repo/src",
      }),
    });
  });

  it("fails when no resolvable scope facts are present", () => {
    expect(resolveGoalWorkingScope({ cwd: "/tmp/project" })).toEqual({
      ok: false,
      code: "missing_scope",
      message: "Working memory needs a task, conversation, or git scope.",
    });
  });
});
