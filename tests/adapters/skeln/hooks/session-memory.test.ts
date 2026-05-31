import { describe, expect, it, vi } from "vitest";

import {
  buildSkelnSessionBeforeCompactTriggerEvent,
  buildSkelnSessionBeforeForkTriggerEvent,
  buildSkelnSessionCompactTriggerEvent,
  buildSkelnSessionShutdownTriggerEvent,
  buildSkelnSessionStartTriggerEvent,
  buildSkelnSessionTreeTriggerEvent,
  logSessionMemoryTriggerResult,
} from "../../../../src/adapters/skeln/hooks/session-memory.js";
import type { AgenrSkelnSessionScope } from "../../../../src/adapters/skeln/types.js";

const scope: AgenrSkelnSessionScope = {
  sessionId: "session-1",
  sessionKey: "skeln:session:session-1:cwd:/tmp/project",
  cwd: "/tmp/project",
};

describe("buildSkelnSessionStartTriggerEvent", () => {
  it("maps session scope to a session_start trigger", () => {
    expect(buildSkelnSessionStartTriggerEvent(scope)).toEqual({
      type: "session_start",
      sessionKey: scope.sessionKey,
      childSessionKey: scope.sessionKey,
      transitionReason: "new",
      observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it("maps previous session files to resume predecessor refs", () => {
    expect(buildSkelnSessionStartTriggerEvent(scope, { previousSessionFile: " previous-session.jsonl " })).toEqual({
      type: "session_start",
      sessionKey: scope.sessionKey,
      childSessionKey: scope.sessionKey,
      transitionReason: "resume",
      predecessor: {
        sourceRef: "previous-session.jsonl",
      },
      observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it("maps explicit fork and clone reasons from Skeln session_start payloads", () => {
    expect(buildSkelnSessionStartTriggerEvent(scope, { reason: "fork", previousSessionFile: "parent.jsonl" })).toEqual({
      type: "session_start",
      sessionKey: scope.sessionKey,
      childSessionKey: scope.sessionKey,
      transitionReason: "fork",
      predecessor: {
        sourceRef: "parent.jsonl",
      },
      observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });
});

describe("buildSkelnSessionCompactTriggerEvent", () => {
  it("maps compaction payloads to checkpoint artifacts with fromExtension metadata", () => {
    expect(
      buildSkelnSessionCompactTriggerEvent(scope, {
        compactionEntry: {
          id: "compact-1",
          summary: "The checkpoint summary.",
          firstKeptEntryId: "entry-1",
        },
        fromExtension: true,
      }),
    ).toMatchObject({
      type: "session_compact",
      sessionKey: scope.sessionKey,
      artifact: {
        kind: "compaction_checkpoint",
        source: "skeln",
        sourceId: "compact-1",
        summary: "The checkpoint summary.",
        metadata: {
          firstKeptEntryId: "entry-1",
          fromExtension: true,
        },
      },
      workingScope: {
        sessionId: scope.sessionId,
        sessionKey: scope.sessionKey,
        scopeKey: `session:${scope.sessionKey}`,
        cwd: scope.cwd,
      },
    });
  });
});

describe("buildSkelnSessionTreeTriggerEvent", () => {
  it("maps branch summaries to branch_abandonment artifacts", () => {
    expect(
      buildSkelnSessionTreeTriggerEvent(scope, {
        oldLeafId: "leaf-a",
        newLeafId: "leaf-b",
        summaryEntry: {
          id: "summary-1",
          summary: "Abandoned branch summary.",
          fromId: "leaf-a",
        },
        fromExtension: false,
      }),
    ).toMatchObject({
      type: "session_tree",
      artifact: {
        kind: "branch_abandonment",
        sourceId: "summary-1",
        summary: "Abandoned branch summary.",
      },
    });
  });
});

describe("checkpoint-relevant lifecycle triggers", () => {
  it("builds session_before_fork triggers with fork position metadata", () => {
    expect(buildSkelnSessionBeforeForkTriggerEvent(scope, { entryId: "entry-1", position: "before" })).toMatchObject({
      type: "session_before_fork",
      predecessor: {
        forkEntryId: "entry-1",
        forkPosition: "before",
      },
    });
  });

  it("builds session_before_compact and session_shutdown triggers", () => {
    expect(buildSkelnSessionBeforeCompactTriggerEvent(scope)).toMatchObject({
      type: "session_before_compact",
      sessionKey: scope.sessionKey,
    });
    expect(buildSkelnSessionShutdownTriggerEvent(scope, { reason: "reload" })).toMatchObject({
      type: "session_shutdown",
      sessionKey: scope.sessionKey,
      shutdownReason: "reload",
      workingScope: {
        sessionId: scope.sessionId,
        sessionKey: scope.sessionKey,
        scopeKey: `session:${scope.sessionKey}`,
        cwd: scope.cwd,
      },
    });
  });
});

describe("logSessionMemoryTriggerResult", () => {
  it("warns when session-memory intake rejects a trigger", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logSessionMemoryTriggerResult({
      accepted: false,
      reason: "feature_disabled",
      message: "Session-memory trigger session_start is disabled by feature flags.",
    });

    expect(warn).toHaveBeenCalledWith(
      "[agenr] session-memory trigger rejected: feature_disabled (Session-memory trigger session_start is disabled by feature flags.)",
    );
    warn.mockRestore();
  });
});
