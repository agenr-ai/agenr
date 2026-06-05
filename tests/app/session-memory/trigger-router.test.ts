import { describe, expect, it, vi } from "vitest";

import { routeSessionMemoryTrigger, SESSION_MEMORY_TRIGGER_FLAGS, type SessionMemoryRepository } from "../../../src/app/session-memory/index.js";
import { SESSION_MEMORY_TRIGGER_TYPES, type SessionLineageEdge } from "../../../src/app/session-memory/types.js";
import type { WorkingMemoryService } from "../../../src/app/working-memory/service.js";

describe("routeSessionMemoryTrigger", () => {
  it("maps every lifecycle trigger to a session-memory feature flag", () => {
    expect(Object.keys(SESSION_MEMORY_TRIGGER_FLAGS).sort()).toEqual([...SESSION_MEMORY_TRIGGER_TYPES].sort());
  });

  it("gates lineage triggers behind sessionTreeLineage", async () => {
    await expect(
      routeSessionMemoryTrigger(
        {
          type: "session_start",
          sessionKey: "session-1",
          transitionReason: "resume",
          observedAt: "2026-05-30T00:00:00.000Z",
        },
        {
          sessionTreeLineage: false,
          sessionTreeCompaction: true,
        },
      ),
    ).resolves.toEqual({
      accepted: false,
      reason: "feature_disabled",
      message: "Session-memory trigger session_start is disabled by feature flags.",
    });
  });

  it("gates compaction triggers behind sessionTreeCompaction", async () => {
    await expect(
      routeSessionMemoryTrigger(
        {
          type: "session_compact",
          sessionKey: "session-1",
          observedAt: "2026-05-30T00:00:00.000Z",
        },
        {
          sessionTreeLineage: true,
          sessionTreeCompaction: false,
        },
      ),
    ).resolves.toEqual({
      accepted: false,
      reason: "feature_disabled",
      message: "Session-memory trigger session_compact is disabled by feature flags.",
    });
  });

  it("gates branch-abandonment capture behind sessionTreeLineage", async () => {
    await expect(
      routeSessionMemoryTrigger(
        {
          type: "session_tree",
          sessionKey: "session-1",
          artifact: {
            kind: "branch_abandonment",
            source: "skeln",
            sourceId: "summary-1",
            summary: "Abandoned branch summary.",
          },
          observedAt: "2026-05-30T00:00:00.000Z",
        },
        {
          sessionTreeLineage: false,
          sessionTreeCompaction: true,
        },
      ),
    ).resolves.toEqual({
      accepted: false,
      reason: "feature_disabled",
      message: "Session-memory trigger session_tree is disabled by feature flags.",
    });
  });

  it("returns misconfigured when the relevant flag is enabled without a repository", async () => {
    await expect(
      routeSessionMemoryTrigger(
        {
          type: "session_start",
          sessionKey: "session-1",
          observedAt: "2026-05-30T00:00:00.000Z",
        },
        {
          sessionTreeLineage: true,
          sessionTreeCompaction: false,
        },
      ),
    ).resolves.toEqual({
      accepted: false,
      reason: "misconfigured",
      message: "Session-memory trigger session_start is enabled, but no session-memory repository was wired into the runtime.",
    });
  });

  it("accepts a new session_start trigger as a valid no-op", async () => {
    const repository = createRepository();

    await expect(
      routeSessionMemoryTrigger(
        {
          type: "session_start",
          sessionKey: "session-1",
          transitionReason: "new",
          observedAt: "2026-05-30T00:00:00.000Z",
        },
        {
          sessionTreeLineage: true,
          sessionTreeCompaction: false,
        },
        { repository },
      ),
    ).resolves.toEqual({
      accepted: true,
      action: "no_lineage",
      message: "Session-memory trigger session_start did not include lineage or artifact facts.",
    });
    expect(repository.recordTriggerIntake).not.toHaveBeenCalled();
  });

  it("records resume lineage from a session_start predecessor ref", async () => {
    const repository = createRepository();

    await expect(
      routeSessionMemoryTrigger(
        {
          type: "session_start",
          sessionKey: "child-session",
          transitionReason: "resume",
          predecessor: {
            sessionKey: "parent-session",
          },
          observedAt: "2026-05-30T00:00:00.000Z",
        },
        {
          sessionTreeLineage: true,
          sessionTreeCompaction: false,
        },
        { repository },
      ),
    ).resolves.toMatchObject({
      accepted: true,
      action: "lineage_recorded",
      lineageEdge: {
        childSessionKey: "child-session",
        parentSessionKey: "parent-session",
        reason: "resume",
      },
    });
    expect(repository.recordTriggerIntake).toHaveBeenCalledWith({
      lineage: {
        childSessionKey: "child-session",
        parentSessionKey: "parent-session",
        reason: "resume",
        observedAt: "2026-05-30T00:00:00.000Z",
      },
    });
  });

  it("records compaction artifacts with a generated content hash", async () => {
    const repository = createRepository();

    await expect(
      routeSessionMemoryTrigger(
        {
          type: "session_compact",
          sessionKey: "session-1",
          artifact: {
            kind: "compaction_checkpoint",
            source: "skeln",
            sourceId: "compact-1",
            summary: "The checkpoint summary.",
          },
          observedAt: "2026-05-30T00:00:00.000Z",
        },
        {
          sessionTreeLineage: false,
          sessionTreeCompaction: true,
        },
        { repository },
      ),
    ).resolves.toMatchObject({
      accepted: true,
      action: "artifact_recorded",
      artifact: {
        kind: "compaction_checkpoint",
        sessionKey: "session-1",
        source: "skeln",
        sourceId: "compact-1",
      },
    });
    expect(repository.recordTriggerIntake).toHaveBeenCalledWith({
      artifact: expect.objectContaining({
        kind: "compaction_checkpoint",
        sessionKey: "session-1",
        source: "skeln",
        sourceId: "compact-1",
        summary: "The checkpoint summary.",
        contentHash: expect.any(String),
      }),
    });
  });

  it("records host branch summaries as branch-abandonment artifacts", async () => {
    const repository = createRepository();

    await expect(
      routeSessionMemoryTrigger(
        {
          type: "session_tree",
          sessionKey: "session-1",
          artifact: {
            kind: "branch_abandonment",
            source: "skeln",
            sourceId: "summary-1",
            sourceRef: "branch_summary:summary-1",
            summary: "The abandoned exploration summary.",
            metadata: {
              fromId: "leaf-a",
              oldLeafId: "leaf-a",
              newLeafId: "leaf-b",
            },
          },
          observedAt: "2026-05-30T00:00:00.000Z",
        },
        {
          sessionTreeLineage: true,
          sessionTreeCompaction: false,
        },
        { repository },
      ),
    ).resolves.toMatchObject({
      accepted: true,
      action: "artifact_recorded",
      artifact: {
        kind: "branch_abandonment",
        sessionKey: "session-1",
        sourceId: "summary-1",
        summary: "The abandoned exploration summary.",
      },
    });
    expect(repository.recordTriggerIntake).toHaveBeenCalledWith({
      artifact: expect.objectContaining({
        kind: "branch_abandonment",
        sessionKey: "session-1",
        source: "skeln",
        sourceId: "summary-1",
        sourceRef: "branch_summary:summary-1",
        summary: "The abandoned exploration summary.",
        contentHash: expect.any(String),
      }),
    });
  });

  it("persists lineage and artifacts from the same lifecycle event", async () => {
    const repository = createRepository();

    await expect(
      routeSessionMemoryTrigger(
        {
          type: "session_start",
          sessionKey: "child-session",
          transitionReason: "resume",
          predecessor: {
            sessionKey: "parent-session",
          },
          artifact: {
            kind: "continuity_summary",
            source: "skeln",
            sourceId: "summary-1",
            summary: "The predecessor summary.",
          },
          observedAt: "2026-05-30T00:00:00.000Z",
        },
        {
          sessionTreeLineage: true,
          sessionTreeCompaction: false,
        },
        { repository },
      ),
    ).resolves.toMatchObject({
      accepted: true,
      action: "recorded",
      lineageEdge: {
        parentSessionKey: "parent-session",
      },
      artifact: {
        kind: "continuity_summary",
      },
    });
    expect(repository.recordTriggerIntake).toHaveBeenCalledTimes(1);
    expect(repository.recordTriggerIntake).toHaveBeenCalledWith({
      lineage: {
        childSessionKey: "child-session",
        parentSessionKey: "parent-session",
        reason: "resume",
        observedAt: "2026-05-30T00:00:00.000Z",
      },
      artifact: expect.objectContaining({
        kind: "continuity_summary",
        sessionKey: "child-session",
        source: "skeln",
        sourceId: "summary-1",
        summary: "The predecessor summary.",
      }),
    });
  });

  it("accepts checkpoint-relevant compaction triggers without lineage or artifact facts", async () => {
    await expect(
      routeSessionMemoryTrigger(
        {
          type: "session_before_compact",
          sessionKey: "session-1",
          observedAt: "2026-05-30T00:00:00.000Z",
        },
        {
          sessionTreeLineage: false,
          sessionTreeCompaction: true,
        },
        { repository: createRepository() },
      ),
    ).resolves.toEqual({
      accepted: true,
      action: "checkpoint_relevant",
      message: "Session-memory trigger session_before_compact was accepted for checkpoint-relevant lifecycle handling.",
    });
  });

  it("attaches checkpoint refresh diagnostics after compaction artifact intake", async () => {
    const repository = createRepository();
    const workingMemory: WorkingMemoryService = {
      run: vi.fn().mockResolvedValue({
        ok: false,
        code: "misconfigured",
        message: "Working memory is enabled, but no working-memory repository was wired into the runtime.",
      }),
      prepareExternalGoalMutation: vi.fn(),
      renderProjection: vi.fn(),
    };

    await expect(
      routeSessionMemoryTrigger(
        {
          type: "session_compact",
          sessionKey: "session-1",
          workingScope: {
            sessionId: "session-1",
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
        {
          sessionTreeLineage: false,
          sessionTreeCompaction: true,
        },
        { repository, workingMemory },
      ),
    ).resolves.toMatchObject({
      accepted: true,
      action: "artifact_recorded",
      artifact: {
        kind: "compaction_checkpoint",
      },
      workingCheckpointRefresh: {
        ok: false,
        reason: "working_memory_unavailable",
      },
    });
    expect(repository.recordTriggerIntake).toHaveBeenCalledTimes(1);
  });

  it("reports skipped refresh when working memory service is not wired", async () => {
    const repository = createRepository();

    await expect(
      routeSessionMemoryTrigger(
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
        {
          sessionTreeLineage: false,
          sessionTreeCompaction: true,
        },
        { repository },
      ),
    ).resolves.toMatchObject({
      accepted: true,
      action: "artifact_recorded",
      workingCheckpointRefresh: {
        ok: false,
        reason: "not_applicable",
        message: "Compaction checkpoint refresh requires a working-memory service, but none was wired into the runtime.",
      },
    });
    expect(repository.recordTriggerIntake).toHaveBeenCalledTimes(1);
  });

  it("refreshes the active working checkpoint on session shutdown without closing it", async () => {
    const workingMemory: WorkingMemoryService = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        action: "update",
        workingSet: {
          id: "work-1",
          revision: 4,
        },
      }),
      prepareExternalGoalMutation: vi.fn(),
      renderProjection: vi.fn(),
    };

    await expect(
      routeSessionMemoryTrigger(
        {
          type: "session_shutdown",
          sessionKey: "session-1",
          workingScope: {
            sessionId: "session-1",
            conversationKey: "session-1",
          },
          shutdownReason: "quit",
          observedAt: "2026-05-30T00:00:00.000Z",
        },
        {
          sessionTreeLineage: true,
          sessionTreeCompaction: false,
        },
        { repository: createRepository(), workingMemory },
      ),
    ).resolves.toMatchObject({
      accepted: true,
      action: "checkpoint_relevant",
      workingCheckpointRefresh: {
        ok: true,
        action: "working_checkpoint_refreshed",
        workingSetId: "work-1",
        revision: 4,
      },
    });

    expect(workingMemory.run).toHaveBeenCalledWith({
      action: "update",
      scope: {
        sessionId: "session-1",
        conversationKey: "session-1",
      },
      operation: {
        type: "merge_checkpoint",
        checkpoint: {
          summary: "Session shutdown (quit) recorded. Resume from the latest working-set snapshot; no implicit close was performed.",
          recordedAt: "2026-05-30T00:00:00.000Z",
        },
      },
      updateReason: "Recorded working checkpoint from session shutdown (quit).",
      actor: "runtime",
      source: "lifecycle_hook",
    });
  });
});

function createRepository(input: { lineageEdge?: SessionLineageEdge } = {}): SessionMemoryRepository {
  const lineageEdge =
    input.lineageEdge ??
    ({
      id: "edge-1",
      childSessionKey: "child-session",
      parentSessionKey: "parent-session",
      reason: "resume",
      observedAt: "2026-05-30T00:00:00.000Z",
    } satisfies SessionLineageEdge);

  const upsertLineageEdge: SessionMemoryRepository["upsertLineageEdge"] = async () => lineageEdge;
  const upsertSessionArtifact: SessionMemoryRepository["upsertSessionArtifact"] = async (artifactInput) => ({
    id: "artifact-1",
    kind: artifactInput.kind,
    sessionKey: artifactInput.sessionKey,
    source: artifactInput.source,
    sourceId: artifactInput.sourceId,
    sourceRef: artifactInput.sourceRef,
    contentHash: artifactInput.contentHash,
    summary: artifactInput.summary,
    metadata: artifactInput.metadata,
    createdAt: "2026-05-30T00:00:00.000Z",
    expiresAt: artifactInput.expiresAt,
  });

  return {
    upsertLineageEdge,
    upsertSessionArtifact,
    recordTriggerIntake: vi.fn(async (intake) => ({
      ...(intake.lineage ? { lineageEdge: await upsertLineageEdge(intake.lineage) } : {}),
      ...(intake.artifact ? { artifact: await upsertSessionArtifact(intake.artifact) } : {}),
    })),
    listSessionArtifacts: vi.fn(async () => []),
    listSessionArtifactsBySourceRef: vi.fn(async () => []),
    getLatestLineageEdgeForChild: vi.fn(async () => null),
  };
}
