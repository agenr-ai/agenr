import { describe, expect, it } from "vitest";

import { buildSkelnHostContext, toSkelnSessionScope } from "../../../../src/adapters/skeln/session/scope.js";
import { createSessionStartTracker, createSkelnSessionScopeTracker } from "../../../../src/adapters/skeln/session/state.js";

describe("createSessionStartTracker", () => {
  it("returns first-start and active-session facts for session ids and keys", () => {
    const tracker = createSessionStartTracker();

    expect(tracker.consume("session-1", "skeln:session:session-1:cwd:/tmp/project")).toEqual({
      isFirst: true,
      activeCount: 1,
    });
    expect(tracker.consume("session-1", "skeln:session:session-1:cwd:/tmp/project")).toEqual({
      isFirst: false,
      activeCount: 1,
    });
    expect(tracker.consume(undefined, "skeln:session:session-2:cwd:/tmp/other")).toEqual({
      isFirst: true,
      activeCount: 2,
    });
    expect(tracker.consume(undefined, "skeln:session:session-2:cwd:/tmp/other")).toEqual({
      isFirst: false,
      activeCount: 2,
    });
  });
});

describe("createSkelnSessionScopeTracker", () => {
  it("records and clears session_start scope facts", () => {
    const tracker = createSkelnSessionScopeTracker();
    const hostContext = buildSkelnHostContext({
      sessionId: "session-1",
      cwd: "/tmp/project",
      gitBranch: "main",
    });
    const scope = toSkelnSessionScope(hostContext, "session-1", "/tmp/previous.jsonl");

    tracker.rememberSessionStart(scope);

    expect(tracker.getSessionScope("session-1")).toEqual(scope);
    expect(tracker.clear("session-1", scope.sessionKey)).toBe(true);
    expect(tracker.getSessionScope("session-1")).toBeUndefined();
  });
});
