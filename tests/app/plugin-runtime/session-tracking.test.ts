import { describe, expect, it } from "vitest";

import { createSessionStartTracker, resolveSessionIdentityKey } from "../../../src/app/plugin-runtime/session-tracking.js";

describe("resolveSessionIdentityKey", () => {
  it("prefers session ids over session keys", () => {
    expect(resolveSessionIdentityKey("session-1", "skeln:session:session-1:cwd:/tmp/project")).toBe("session:session-1");
  });

  it("falls back to session keys when session ids are absent", () => {
    expect(resolveSessionIdentityKey(undefined, "skeln:session:session-1:cwd:/tmp/project")).toBe("key:skeln:session:session-1:cwd:/tmp/project");
  });

  it("returns undefined when no identity is available", () => {
    expect(resolveSessionIdentityKey(undefined, undefined)).toBeUndefined();
  });
});

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

  it("remembers session_start predecessor ids", () => {
    const tracker = createSessionStartTracker();

    tracker.rememberSessionStart("new-session", "agent:main:webchat:first", "old-session");

    expect(tracker.getResumedFrom("new-session")).toBe("old-session");
  });
});
