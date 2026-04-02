import { describe, expect, it, vi } from "vitest";

import { handleAgenrAfterToolCall } from "../../../src/adapters/openclaw/hooks/after-tool-call.js";
import { createMidSessionTracker } from "../../../src/adapters/openclaw/session/state.js";

describe("handleAgenrAfterToolCall", () => {
  it("tracks successful stores and explicit store maintenance fields", () => {
    const tracker = createMidSessionTracker();
    const logger = createLogger();

    tracker.recordTurn("session-1", "agent:main:webchat:first");
    tracker.recordTurn("session-1", "agent:main:webchat:first");
    tracker.recordTurn("session-1", "agent:main:webchat:first");

    handleAgenrAfterToolCall(
      {
        toolName: "agenr_store",
        params: {
          subject: "workflow rule",
          claimKey: "repo/workflow_rule",
        },
        result: {
          status: "stored",
        },
      },
      {
        sessionId: "session-1",
        sessionKey: "agent:main:webchat:first",
      },
      {
        logger,
        midSessionTracker: tracker,
      },
    );

    expect(tracker.peek("session-1", "agent:main:webchat:first")).toMatchObject({
      turnCount: 3,
      lastSuccessfulStoreTurn: 3,
      lastMemoryActionTurn: 3,
      lastExplicitMemoryActionTurn: 3,
      entriesStored: 1,
      storedSubjects: ["workflow rule"],
    });
  });

  it("resets only the generic memory cooldown for skipped stores", () => {
    const tracker = createMidSessionTracker();
    const logger = createLogger();

    tracker.recordTurn("session-2", "agent:main:webchat:skip");
    tracker.recordTurn("session-2", "agent:main:webchat:skip");

    handleAgenrAfterToolCall(
      {
        toolName: "agenr_store",
        params: {
          subject: "duplicate preference",
        },
        result: {
          status: "skipped",
        },
      },
      {
        sessionId: "session-2",
        sessionKey: "agent:main:webchat:skip",
      },
      {
        logger,
        midSessionTracker: tracker,
      },
    );

    expect(tracker.peek("session-2", "agent:main:webchat:skip")).toMatchObject({
      turnCount: 2,
      lastSuccessfulStoreTurn: 0,
      lastMemoryActionTurn: 2,
      lastExplicitMemoryActionTurn: 0,
      entriesStored: 0,
      storedSubjects: [],
    });
  });

  it("records failed explicit stores as explicit maintenance only", () => {
    const tracker = createMidSessionTracker();
    const logger = createLogger();

    tracker.recordTurn("session-3", "agent:main:webchat:failed");
    tracker.recordTurn("session-3", "agent:main:webchat:failed");

    handleAgenrAfterToolCall(
      {
        toolName: "agenr_store",
        params: {
          subject: "superseded fact",
          supersedes: "entry-1",
        },
        result: {
          status: "failed",
        },
        error: "validation failed",
      },
      {
        sessionId: "session-3",
        sessionKey: "agent:main:webchat:failed",
      },
      {
        logger,
        midSessionTracker: tracker,
      },
    );

    expect(tracker.peek("session-3", "agent:main:webchat:failed")).toMatchObject({
      turnCount: 2,
      lastSuccessfulStoreTurn: 0,
      lastMemoryActionTurn: 0,
      lastExplicitMemoryActionTurn: 2,
      entriesStored: 0,
    });
  });

  it("treats update and retire as explicit memory maintenance even on failed results", () => {
    const tracker = createMidSessionTracker();
    const logger = createLogger();

    tracker.recordTurn("session-4", "agent:main:webchat:update");
    tracker.recordTurn("session-4", "agent:main:webchat:update");
    tracker.recordTurn("session-4", "agent:main:webchat:update");

    handleAgenrAfterToolCall(
      {
        toolName: "agenr_update",
        params: {
          id: "entry-2",
        },
        result: {
          status: "failed",
        },
        error: "target missing",
      },
      {
        sessionId: "session-4",
        sessionKey: "agent:main:webchat:update",
      },
      {
        logger,
        midSessionTracker: tracker,
      },
    );

    expect(tracker.peek("session-4", "agent:main:webchat:update")).toMatchObject({
      turnCount: 3,
      lastMemoryActionTurn: 3,
      lastExplicitMemoryActionTurn: 3,
    });
  });
});

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}
