import { describe, expect, it, vi } from "vitest";

import { logSessionMemoryTriggerResult } from "../../../../src/adapters/shared/session-memory-routing.js";
import {
  buildOpenClawSessionBeforeCompactTriggerEvent,
  buildOpenClawSessionBeforeTreeTriggerEvent,
  buildOpenClawSessionCompactTriggerEvent,
  buildOpenClawSessionShutdownTriggerEvent,
  buildOpenClawSessionStartTriggerEvent,
  buildOpenClawSessionTreeTriggerEvent,
  shouldRouteOpenClawSessionTreeTrigger,
} from "../../../../src/adapters/openclaw/hooks/session-memory.js";
import type { AgenrOpenClawSessionScope } from "../../../../src/adapters/openclaw/session/scope.js";

const scope: AgenrOpenClawSessionScope = {
  sessionId: "session-1",
  sessionKey: "agent:main:webchat:test",
  workspaceDir: "/tmp/project",
  conversationKey: "session-1",
  agentId: "main",
  project: "main",
};

describe("buildOpenClawSessionStartTriggerEvent", () => {
  it("maps session scope to a session_start trigger", () => {
    expect(buildOpenClawSessionStartTriggerEvent(scope)).toEqual({
      type: "session_start",
      sessionKey: scope.sessionKey,
      childSessionKey: scope.sessionKey,
      transitionReason: "new",
      payload: { sessionId: scope.sessionId },
      observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it("maps resumedFrom to resume predecessor refs", () => {
    expect(
      buildOpenClawSessionStartTriggerEvent(scope, {
        sessionId: scope.sessionId,
        resumedFrom: " previous-session.jsonl ",
      }),
    ).toEqual({
      type: "session_start",
      sessionKey: scope.sessionKey,
      childSessionKey: scope.sessionKey,
      transitionReason: "resume",
      predecessor: {
        sourceRef: "session_file:previous-session.jsonl",
      },
      payload: {
        sessionId: scope.sessionId,
        resumedFrom: " previous-session.jsonl ",
      },
      observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });
});

describe("buildOpenClawSessionCompactTriggerEvent", () => {
  it("maps compaction payloads to checkpoint artifacts", () => {
    expect(
      buildOpenClawSessionCompactTriggerEvent(
        scope,
        {
          messageCount: 12,
          compactedCount: 40,
          sessionFile: "/tmp/session.jsonl",
        },
        {
          id: "compact-1",
          summary: "We decided to ship the OpenClaw compaction intake path.",
          tokensBefore: 120000,
          firstKeptEntryId: "entry-9",
        },
      ),
    ).toMatchObject({
      type: "session_compact",
      sessionKey: scope.sessionKey,
      artifact: {
        kind: "compaction_checkpoint",
        source: "openclaw",
        sourceId: "compact-1",
        summary: "We decided to ship the OpenClaw compaction intake path.",
        metadata: {
          compactedCount: 40,
          messageCount: 12,
          sessionFile: "/tmp/session.jsonl",
          tokensBefore: 120000,
          firstKeptEntryId: "entry-9",
        },
      },
      workingScope: {
        sessionId: scope.sessionId,
        conversationKey: scope.sessionId,
        cwd: scope.workspaceDir,
        project: scope.project,
      },
    });
  });
});

describe("checkpoint-relevant lifecycle triggers", () => {
  it("builds session_before_compact, session_before_tree, and session_shutdown triggers", () => {
    expect(buildOpenClawSessionBeforeCompactTriggerEvent(scope, { messageCount: 20 })).toMatchObject({
      type: "session_before_compact",
      sessionKey: scope.sessionKey,
    });
    expect(buildOpenClawSessionBeforeTreeTriggerEvent(scope, { reason: "reset" })).toMatchObject({
      type: "session_before_tree",
      sessionKey: scope.sessionKey,
    });
    expect(
      buildOpenClawSessionShutdownTriggerEvent(scope, {
        messageCount: 8,
        reason: "idle",
      }),
    ).toMatchObject({
      type: "session_shutdown",
      shutdownReason: "idle",
      workingScope: {
        sessionId: scope.sessionId,
        conversationKey: scope.sessionId,
        cwd: scope.workspaceDir,
      },
    });
  });

  it("routes reset session_end reasons through session_tree", () => {
    expect(shouldRouteOpenClawSessionTreeTrigger("reset")).toBe(true);
    expect(shouldRouteOpenClawSessionTreeTrigger("compaction")).toBe(false);
    expect(
      buildOpenClawSessionTreeTriggerEvent(scope, {
        reason: "reset",
        messageCount: 3,
        sessionFile: "/tmp/session.jsonl",
      }),
    ).toMatchObject({
      type: "session_tree",
      artifact: {
        kind: "branch_abandonment",
        source: "openclaw",
        sourceRef: "session_end:/tmp/session.jsonl",
      },
    });
  });
});

describe("logSessionMemoryTriggerResult", () => {
  it("stays silent when session-memory intake is disabled by feature flags", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logSessionMemoryTriggerResult({
      accepted: false,
      reason: "feature_disabled",
      message: "Session-memory trigger session_start is disabled by feature flags.",
    });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns when session-memory intake rejects a trigger for actionable reasons", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logSessionMemoryTriggerResult({
      accepted: false,
      reason: "misconfigured",
      message: "Session-memory trigger session_start is enabled, but no session-memory repository was wired into the runtime.",
    });

    expect(warn).toHaveBeenCalledWith(
      "[agenr] session-memory trigger rejected: misconfigured (Session-memory trigger session_start is enabled, but no session-memory repository was wired into the runtime.)",
    );
    warn.mockRestore();
  });
});
