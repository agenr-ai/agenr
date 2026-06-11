import { describe, expect, it, vi } from "vitest";

import type { SessionMemoryTriggerAcceptedResult } from "../../../src/app/session-memory/results.js";
import { attachWorkingCheckpointRefresh } from "../../../src/app/working-memory/lifecycle-checkpoint.js";
import type { WorkingMemoryService } from "../../../src/app/working-memory/service.js";

describe("attachWorkingCheckpointRefresh lifecycle mapping", () => {
  it("maps missing active working sets to no_active_working_set diagnostics", async () => {
    const workingMemory = createWorkingMemory({
      run: vi.fn().mockResolvedValue({
        ok: false,
        code: "missing_active_set",
        message: "No current working set matched the resolved scope.",
      }),
    });

    await expect(
      attachWorkingCheckpointRefresh(
        {
          type: "session_compact",
          sessionKey: "session-1",
          workingScope: {
            conversationKey: "session-1",
          },
          artifact: {
            kind: "compaction_checkpoint",
            source: "skeln",
            sourceId: "compact-1",
            summary: "Compaction summary.",
          },
          observedAt: "2026-05-30T00:00:00.000Z",
        },
        compactionAcceptedResult(),
        workingMemory,
      ),
    ).resolves.toMatchObject({
      workingCheckpointRefresh: {
        ok: false,
        reason: "no_active_working_set",
        code: "missing_active_set",
        message: "No current working set matched the resolved scope.",
      },
    });
  });

  it("normalizes blank shutdown reasons to unknown before merging a checkpoint", async () => {
    const run = vi.fn().mockResolvedValue({
      ok: true,
      action: "update",
      workingSet: {
        id: "work-1",
        revision: 3,
      },
    });
    const workingMemory = createWorkingMemory({ run });

    await expect(
      attachWorkingCheckpointRefresh(
        {
          type: "session_shutdown",
          sessionKey: "session-1",
          workingScope: {
            sessionId: "session-1",
            conversationKey: "session-1",
          },
          shutdownReason: "   ",
          observedAt: "2026-05-30T00:00:00.000Z",
        },
        shutdownAcceptedResult(),
        workingMemory,
      ),
    ).resolves.toMatchObject({
      workingCheckpointRefresh: {
        ok: true,
        action: "working_checkpoint_refreshed",
        workingSetId: "work-1",
        revision: 3,
      },
    });

    expect(run).toHaveBeenCalledWith({
      action: "update",
      target: "session",
      scope: {
        sessionId: "session-1",
        conversationKey: "session-1",
      },
      operation: {
        type: "merge_checkpoint",
        checkpoint: {
          summary: "Session shutdown (unknown) recorded. Resume from the latest working-set snapshot; no implicit close was performed.",
          recordedAt: "2026-05-30T00:00:00.000Z",
        },
      },
      updateReason: "Recorded working checkpoint from session shutdown (unknown).",
      actor: "runtime",
      source: "lifecycle_hook",
    });
  });

  it("trims shutdown reasons before building checkpoint text", async () => {
    const run = vi.fn().mockResolvedValue({
      ok: true,
      action: "update",
      workingSet: {
        id: "work-1",
        revision: 3,
      },
    });
    const workingMemory = createWorkingMemory({ run });

    await attachWorkingCheckpointRefresh(
      {
        type: "session_shutdown",
        sessionKey: "session-1",
        workingScope: {
          sessionId: "session-1",
        },
        shutdownReason: "  quit  ",
        observedAt: "2026-05-30T00:00:00.000Z",
      },
      shutdownAcceptedResult(),
      workingMemory,
    );

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: {
          type: "merge_checkpoint",
          checkpoint: {
            summary: "Session shutdown (quit) recorded. Resume from the latest working-set snapshot; no implicit close was performed.",
            recordedAt: "2026-05-30T00:00:00.000Z",
          },
        },
        updateReason: "Recorded working checkpoint from session shutdown (quit).",
      }),
    );
  });
});

function compactionAcceptedResult(): SessionMemoryTriggerAcceptedResult {
  return {
    accepted: true,
    action: "artifact_recorded",
    message: "accepted",
    artifact: {
      id: "artifact-1",
      kind: "compaction_checkpoint",
      sessionKey: "session-1",
      source: "skeln",
      sourceId: "compact-1",
      contentHash: "hash-1",
      summary: "Compaction summary.",
      createdAt: "2026-05-30T00:00:00.000Z",
    },
  };
}

function shutdownAcceptedResult(): SessionMemoryTriggerAcceptedResult {
  return {
    accepted: true,
    action: "checkpoint_relevant",
    message: "accepted",
  };
}

function createWorkingMemory(overrides: Partial<WorkingMemoryService> = {}): WorkingMemoryService {
  return {
    run: vi.fn(),
    ensureSessionWorkingSet: vi.fn(),
    readSessionSnapshotForFork: vi.fn(),
    prepareExternalGoalMutation: vi.fn(),
    renderProjectionBundle: vi.fn(),
    ...overrides,
  };
}
