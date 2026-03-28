import { describe, expect, it } from "vitest";

import { createSessionStartTracker } from "../../../src/adapters/openclaw/session/state.js";

describe("createSessionStartTracker", () => {
  it("returns first-start and active-session facts for session ids and keys", () => {
    const tracker = createSessionStartTracker();

    expect(tracker.consume("session-1", "agent:main:webchat:first")).toEqual({
      isFirst: true,
      activeCount: 1,
    });
    expect(tracker.consume("session-1", "agent:main:webchat:first")).toEqual({
      isFirst: false,
      activeCount: 1,
    });
    expect(tracker.consume(undefined, "agent:main:webchat:second")).toEqual({
      isFirst: true,
      activeCount: 2,
    });
    expect(tracker.consume(undefined, "agent:main:webchat:second")).toEqual({
      isFirst: false,
      activeCount: 2,
    });
  });

  it("remembers reset files and session_start predecessor ids", () => {
    const tracker = createSessionStartTracker();

    tracker.rememberReset("agent:main:webchat:first", {
      sessionId: "old-session",
      sessionFile: "/tmp/old-session.jsonl",
      recordedAt: "2026-03-28T12:00:00.000Z",
    });
    tracker.rememberSessionStart("new-session", "agent:main:webchat:first", "old-session");

    expect(tracker.getLatestReset("agent:main:webchat:first")).toEqual({
      sessionId: "old-session",
      sessionFile: "/tmp/old-session.jsonl",
      recordedAt: "2026-03-28T12:00:00.000Z",
    });
    expect(tracker.getResumedFrom("new-session")).toBe("old-session");
  });
});
