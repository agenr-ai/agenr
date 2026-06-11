import { describe, expect, it } from "vitest";

import {
  formatUnknownOpenClawSessionScopeMessage,
  isUnknownOpenClawSessionScope,
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

  it("marks the unknown fallback when no session identity is available", () => {
    const scope = resolveOpenClawSessionScope({});

    expect(scope).toEqual({
      sessionId: "unknown",
      sessionKey: "unknown",
      conversationKey: "unknown",
    });
    expect(isUnknownOpenClawSessionScope(scope)).toBe(true);
    expect(formatUnknownOpenClawSessionScopeMessage("ensure a session working set")).toBe(
      'OpenClaw session identity is unavailable; refusing to ensure a session working set because the "unknown" fallback could collide across sessions.',
    );
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
