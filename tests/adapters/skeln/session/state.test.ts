import { describe, expect, it } from "vitest";

import { buildSkelnHostContext, toSkelnSessionScope } from "../../../../src/adapters/skeln/session/scope.js";
import { createSkelnSessionScopeTracker } from "../../../../src/adapters/skeln/session/state.js";

describe("createSkelnSessionScopeTracker", () => {
  it("records and clears session_start scope facts", () => {
    const tracker = createSkelnSessionScopeTracker();
    const hostContext = buildSkelnHostContext({
      sessionId: "session-1",
      cwd: "/tmp/project",
      gitBranch: "main",
    });
    const scope = toSkelnSessionScope(hostContext, "session-1");

    tracker.rememberSessionStart(scope);

    expect(tracker.getSessionScope("session-1")).toEqual(scope);
    expect(tracker.clear("session-1", scope.sessionKey)).toBe(true);
    expect(tracker.getSessionScope("session-1")).toBeUndefined();
  });
});
