import { describe, expect, it } from "vitest";

import { createMidSessionTracker, pushMidSessionStoredSubject } from "../../../src/adapters/openclaw/session/state.js";

describe("createMidSessionTracker", () => {
  it("tracks non-first turns per session identity and clears ended sessions", () => {
    const tracker = createMidSessionTracker();

    expect(tracker.recordTurn("session-1", "agent:main:webchat:first")).toMatchObject({
      turnCount: 1,
      nudgeCount: 0,
      entriesStored: 0,
    });
    expect(tracker.recordTurn("session-1", "agent:main:webchat:first")).toMatchObject({
      turnCount: 2,
    });
    expect(tracker.peek("session-1", "agent:main:webchat:first")).toMatchObject({
      turnCount: 2,
    });
    expect(tracker.activeCount()).toBe(1);
    expect(tracker.clear("session-1", "agent:main:webchat:first")).toBe(true);
    expect(tracker.peek("session-1", "agent:main:webchat:first")).toBeUndefined();
    expect(tracker.activeCount()).toBe(0);
  });
});

describe("pushMidSessionStoredSubject", () => {
  it("deduplicates subjects and keeps only the most recent five", () => {
    const tracker = createMidSessionTracker();
    const state = tracker.getOrCreate("session-1", "agent:main:webchat:first");

    expect(state).toBeDefined();
    if (!state) {
      return;
    }

    pushMidSessionStoredSubject(state, "one");
    pushMidSessionStoredSubject(state, "two");
    pushMidSessionStoredSubject(state, "three");
    pushMidSessionStoredSubject(state, "four");
    pushMidSessionStoredSubject(state, "five");
    pushMidSessionStoredSubject(state, "three");
    pushMidSessionStoredSubject(state, "six");

    expect(state.storedSubjects).toEqual(["two", "four", "five", "three", "six"]);
  });
});
