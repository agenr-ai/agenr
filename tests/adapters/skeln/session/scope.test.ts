import { describe, expect, it } from "vitest";

import {
  buildSkelnHostContext,
  mergeSkelnHostContext,
  normalizeSkelnScopeField,
  toSkelnSessionScope,
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
      gitRoot: "/tmp/project",
      gitBranch: "feat/skeln",
      project: "agenr",
    });
  });
});

describe("toSkelnSessionScope", () => {
  it("records previous session file facts from session_start", () => {
    const hostContext = buildSkelnHostContext({
      sessionId: "session-2",
      cwd: "/tmp/project",
      gitRoot: "/tmp/project",
    });

    expect(toSkelnSessionScope(hostContext, "session-2", "/tmp/old-session.jsonl")).toEqual({
      sessionId: "session-2",
      sessionKey: "skeln:session:session-2:cwd:/tmp/project",
      cwd: "/tmp/project",
      gitRoot: "/tmp/project",
      previousSessionFile: "/tmp/old-session.jsonl",
    });
  });
});

describe("normalizeSkelnScopeField", () => {
  it("returns undefined for blank values", () => {
    expect(normalizeSkelnScopeField("   ")).toBeUndefined();
    expect(normalizeSkelnScopeField(undefined)).toBeUndefined();
  });
});
