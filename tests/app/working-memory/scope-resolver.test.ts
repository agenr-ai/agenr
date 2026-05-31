import { describe, expect, it } from "vitest";

import { resolveWorkingScope } from "../../../src/app/working-memory/scope-resolver.js";

describe("resolveWorkingScope", () => {
  it("prefers task scope when taskId is present", () => {
    expect(resolveWorkingScope({ taskId: "TASK-1", sessionKey: "session:a" })).toEqual({
      ok: true,
      scope: expect.objectContaining({
        scopeKind: "task",
        scopeKey: "task:TASK-1",
        taskId: "TASK-1",
      }),
    });
  });

  it("resolves conversation scope from conversationKey", () => {
    expect(resolveWorkingScope({ conversationKey: "thread-1", sessionKey: "session:a" })).toEqual({
      ok: true,
      scope: expect.objectContaining({
        scopeKind: "conversation",
        scopeKey: "conversation:thread-1",
      }),
    });
  });

  it("resolves git branch scope when gitRoot and gitBranch are present", () => {
    expect(
      resolveWorkingScope({
        project: "agenr",
        gitRoot: "/repo",
        gitBranch: "main",
        sessionKey: "session:a",
      }),
    ).toEqual({
      ok: true,
      scope: expect.objectContaining({
        scopeKind: "git_branch",
        scopeKey: "git_branch:agenr:/repo:main",
      }),
    });
  });

  it("resolves session scope from sessionKey", () => {
    expect(resolveWorkingScope({ sessionKey: "skeln:session:1", cwd: "/tmp/project" })).toEqual({
      ok: true,
      scope: expect.objectContaining({
        scopeKind: "session",
        scopeKey: "session:skeln:session:1",
      }),
    });
  });

  it("prefers explicit scopeKey over git branch scope", () => {
    expect(
      resolveWorkingScope({
        scopeKey: "session:skeln:session:1",
        gitRoot: "/repo",
        gitBranch: "main",
      }),
    ).toEqual({
      ok: true,
      scope: expect.objectContaining({
        scopeKind: "session",
        scopeKey: "session:skeln:session:1",
      }),
    });
  });

  it("fails when no resolvable scope facts are present", () => {
    expect(resolveWorkingScope({ cwd: "/tmp/project" })).toEqual({
      ok: false,
      code: "missing_scope",
      message: "Working memory needs a task, conversation, git, session key, or session id scope.",
    });
  });
});
