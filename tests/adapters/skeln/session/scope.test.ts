import { describe, expect, it } from "vitest";

import { resolveGoalWorkingScope } from "../../../../src/app/working-memory/scope.js";
import {
  buildSkelnHostContext,
  mergeSkelnHostContext,
  normalizeSkelnScopeField,
  toSkelnSessionScope,
  toWorkingScopeFromSkelnSession,
} from "../../../../src/adapters/skeln/session/scope.js";

describe("buildSkelnHostContext", () => {
  it("builds host context with derived session key and optional git scope", () => {
    expect(
      buildSkelnHostContext({
        sessionId: "session-1",
        cwd: "/tmp/project",
        gitRoot: "/tmp/project",
        gitBranch: "main",
        project: "agenr",
      }),
    ).toEqual({
      cwd: "/tmp/project",
      sessionKey: "skeln:session:session-1:cwd:/tmp/project",
      conversationKey: "session-1",
      gitRoot: "/tmp/project",
      gitBranch: "main",
      project: "agenr",
    });
  });

  it("rejects blank cwd values", () => {
    expect(() =>
      buildSkelnHostContext({
        sessionId: "session-1",
        cwd: "   ",
      }),
    ).toThrow("Skeln cwd is required");
  });
});

describe("mergeSkelnHostContext", () => {
  it("merges host callback fields over adapter defaults", () => {
    const defaults = buildSkelnHostContext({
      sessionId: "session-1",
      cwd: "/tmp/project",
    });

    expect(
      mergeSkelnHostContext(defaults, {
        gitRoot: "/tmp/project",
        gitBranch: "feat/skeln",
        project: "agenr",
      }),
    ).toEqual({
      cwd: "/tmp/project",
      sessionKey: "skeln:session:session-1:cwd:/tmp/project",
      conversationKey: "session-1",
      gitRoot: "/tmp/project",
      gitBranch: "feat/skeln",
      project: "agenr",
    });
  });
});

describe("toSkelnSessionScope", () => {
  it("maps host context fields into session scope", () => {
    const hostContext = buildSkelnHostContext({
      sessionId: "session-2",
      cwd: "/tmp/project",
      gitRoot: "/tmp/project",
    });

    expect(toSkelnSessionScope(hostContext, "session-2")).toEqual({
      sessionId: "session-2",
      sessionKey: "skeln:session:session-2:cwd:/tmp/project",
      cwd: "/tmp/project",
      gitRoot: "/tmp/project",
      conversationKey: "session-2",
    });
  });
});

describe("normalizeSkelnScopeField", () => {
  it("returns undefined for blank values", () => {
    expect(normalizeSkelnScopeField("   ")).toBeUndefined();
    expect(normalizeSkelnScopeField(undefined)).toBeUndefined();
  });
});

describe("toWorkingScopeFromSkelnSession", () => {
  it("maps session identity to conversation-scoped working-memory facts", () => {
    expect(
      toWorkingScopeFromSkelnSession({
        sessionId: "session-1",
        sessionKey: "skeln:session:session-1:cwd:/tmp/project",
        cwd: "/tmp/project",
        gitRoot: "/tmp/project",
        gitBranch: "main",
        project: "agenr",
        conversationKey: "session-1",
      }),
    ).toEqual({
      sessionId: "session-1",
      conversationKey: "session-1",
      cwd: "/tmp/project",
      gitRoot: "/tmp/project",
      gitBranch: "main",
      project: "agenr",
    });
  });

  it("does not emit scopeKey or sessionKey working-memory facts", () => {
    const facts = toWorkingScopeFromSkelnSession({
      sessionId: "session-1",
      sessionKey: "skeln:session:session-1:cwd:/tmp/project",
      cwd: "/tmp/project",
      conversationKey: "session-1",
    });

    expect(facts).not.toHaveProperty("scopeKey");
    expect(facts).not.toHaveProperty("sessionKey");
  });
});

describe("Skeln goal scope stability", () => {
  it("resolves the same conversation scope when cwd changes within one session", () => {
    const sessionId = "session-cwd-change";
    const firstCwd = "/tmp/project";
    const secondCwd = "/tmp/project/packages/core";

    const firstScope = toSkelnSessionScope(
      buildSkelnHostContext({
        sessionId,
        cwd: firstCwd,
        gitRoot: "/tmp/project",
        gitBranch: "main",
        project: "agenr",
      }),
      sessionId,
    );
    const secondScope = toSkelnSessionScope(
      buildSkelnHostContext({
        sessionId,
        cwd: secondCwd,
        gitRoot: "/tmp/project",
        gitBranch: "main",
        project: "agenr",
      }),
      sessionId,
    );

    expect(firstScope.sessionKey).not.toEqual(secondScope.sessionKey);

    const firstResolved = resolveGoalWorkingScope(toWorkingScopeFromSkelnSession(firstScope));
    const secondResolved = resolveGoalWorkingScope(toWorkingScopeFromSkelnSession(secondScope));

    expect(firstResolved.ok).toBe(true);
    expect(secondResolved.ok).toBe(true);
    if (!firstResolved.ok || !secondResolved.ok) {
      return;
    }

    expect(firstResolved.scope.scopeKey).toBe(`conversation:${sessionId}`);
    expect(secondResolved.scope.scopeKey).toBe(`conversation:${sessionId}`);
    expect(firstResolved.scope.scopeKind).toBe("conversation");
    expect(secondResolved.scope.scopeKind).toBe("conversation");
    expect(firstResolved.scope.cwd).toBe(firstCwd);
    expect(secondResolved.scope.cwd).toBe(secondCwd);
  });
});
