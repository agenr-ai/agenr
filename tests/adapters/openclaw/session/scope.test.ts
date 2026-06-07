import { describe, expect, it } from "vitest";

import {
  resolveOpenClawSessionScope,
  toOpenClawSessionScopeContext,
  toWorkingScopeFromOpenClawSession,
} from "../../../../src/adapters/openclaw/session/scope.js";

describe("resolveOpenClawSessionScope", () => {
  it("prefers sessionKey for persistence and sessionId for conversationKey", () => {
    expect(
      resolveOpenClawSessionScope({
        sessionId: "session-1",
        sessionKey: "agent:main:webchat:test",
        workspaceDir: "/tmp/project",
        agentId: "main",
      }),
    ).toEqual({
      sessionId: "session-1",
      sessionKey: "agent:main:webchat:test",
      conversationKey: "session-1",
      workspaceDir: "/tmp/project",
      agentId: "main",
      project: "main",
    });
  });

  it("falls back to sessionKey when sessionId is absent", () => {
    expect(
      resolveOpenClawSessionScope({
        sessionKey: "agent:main:webchat:test",
      }),
    ).toEqual({
      sessionId: "agent:main:webchat:test",
      sessionKey: "agent:main:webchat:test",
      conversationKey: "agent:main:webchat:test",
    });
  });
});

describe("toOpenClawSessionScopeContext", () => {
  it("maps hook context fields without empty strings", () => {
    expect(
      toOpenClawSessionScopeContext({
        sessionId: "session-1",
        sessionKey: "agent:main:webchat:test",
        workspaceDir: "/tmp/project",
        agentId: "main",
      }),
    ).toEqual({
      sessionId: "session-1",
      sessionKey: "agent:main:webchat:test",
      workspaceDir: "/tmp/project",
      agentId: "main",
    });
  });
});

describe("toWorkingScopeFromOpenClawSession", () => {
  it("maps workspaceDir to cwd for working-memory checkpoints", () => {
    expect(
      toWorkingScopeFromOpenClawSession({
        sessionId: "session-1",
        sessionKey: "agent:main:webchat:test",
        workspaceDir: "/tmp/project",
        conversationKey: "session-1",
        project: "main",
      }),
    ).toEqual({
      sessionId: "session-1",
      conversationKey: "session-1",
      cwd: "/tmp/project",
      project: "main",
    });
  });
});
