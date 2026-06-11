import { describe, expect, it, vi } from "vitest";

import { attachWorkingCheckpointRefresh } from "../../../src/app/working-memory/lifecycle-checkpoint.js";
import type { SessionMemoryTriggerAcceptedResult } from "../../../src/app/session-memory/results.js";
import type { WorkingMemoryService } from "../../../src/app/working-memory/service.js";

describe("attachWorkingCheckpointRefresh compaction", () => {
  it("skips enrichment when compaction checkpoint summary is empty", async () => {
    const result: SessionMemoryTriggerAcceptedResult = {
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

    await expect(
      attachWorkingCheckpointRefresh(
        {
          type: "session_compact",
          sessionKey: "session-1",
          artifact: {
            kind: "compaction_checkpoint",
            source: "skeln",
            sourceId: "compact-1",
            summary: "   ",
          },
          observedAt: "2026-05-30T00:00:00.000Z",
        },
        result,
        createWorkingMemory(),
      ),
    ).resolves.toEqual(result);
  });

  it("skips refresh when workingScope is absent", async () => {
    const workingMemory = createWorkingMemory({
      run: vi.fn(),
    });
    const result = compactionAcceptedResult();

    await expect(
      attachWorkingCheckpointRefresh(
        {
          type: "session_compact",
          sessionKey: "session-1",
          artifact: {
            kind: "compaction_checkpoint",
            source: "skeln",
            sourceId: "compact-1",
            summary: "Compaction summary.",
          },
          observedAt: "2026-05-30T00:00:00.000Z",
        },
        result,
        workingMemory,
      ),
    ).resolves.toMatchObject({
      workingCheckpointRefresh: {
        ok: false,
        reason: "missing_scope",
      },
    });

    expect(workingMemory.run).not.toHaveBeenCalled();
  });

  it("returns working_memory_unavailable when the working service rejects the update", async () => {
    const workingMemory = createWorkingMemory({
      run: vi.fn().mockResolvedValue({
        ok: false,
        code: "misconfigured",
        message: "Working memory is enabled, but no working-memory repository was wired into the runtime.",
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
        reason: "working_memory_unavailable",
        code: "misconfigured",
        message: "Working memory is enabled, but no working-memory repository was wired into the runtime.",
      },
    });
  });

  it("skips compaction refresh when working memory is disabled", async () => {
    const workingMemory = createWorkingMemory({
      run: vi.fn().mockResolvedValue({
        ok: false,
        code: "feature_disabled",
        message: "Working memory is disabled by the workingMemory feature flag.",
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
        reason: "not_applicable",
        message: "Working memory is disabled; compaction checkpoint refresh was skipped.",
      },
    });
  });
});

describe("attachWorkingCheckpointRefresh", () => {
  it("skips enrichment for non-compaction accepted intake", async () => {
    const result: SessionMemoryTriggerAcceptedResult = {
      accepted: true,
      action: "lineage_recorded",
      message: "accepted",
    };

    await expect(
      attachWorkingCheckpointRefresh(
        {
          type: "session_start",
          sessionKey: "session-1",
          observedAt: "2026-05-30T00:00:00.000Z",
        },
        result,
        createWorkingMemory(),
      ),
    ).resolves.toEqual(result);
  });

  it("skips enrichment when compaction intake did not persist a checkpoint artifact", async () => {
    const result: SessionMemoryTriggerAcceptedResult = {
      accepted: true,
      action: "no_lineage",
      message: "accepted",
    };

    await expect(
      attachWorkingCheckpointRefresh(
        {
          type: "session_compact",
          sessionKey: "session-1",
          observedAt: "2026-05-30T00:00:00.000Z",
        },
        result,
        createWorkingMemory(),
      ),
    ).resolves.toEqual(result);
  });

  it("reports skipped refresh when no working-memory service is wired", async () => {
    const result = compactionAcceptedResult();

    await expect(
      attachWorkingCheckpointRefresh(
        {
          type: "session_compact",
          sessionKey: "session-1",
          artifact: {
            kind: "compaction_checkpoint",
            source: "skeln",
            sourceId: "compact-1",
            summary: "Compaction summary.",
          },
          observedAt: "2026-05-30T00:00:00.000Z",
        },
        result,
      ),
    ).resolves.toEqual({
      ...result,
      workingCheckpointRefresh: {
        ok: false,
        reason: "not_applicable",
        message: "Compaction checkpoint refresh requires a working-memory service, but none was wired into the runtime.",
      },
    });
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
