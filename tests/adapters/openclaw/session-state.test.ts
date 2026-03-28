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
});
