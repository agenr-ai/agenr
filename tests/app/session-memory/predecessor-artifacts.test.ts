import { describe, expect, it, vi } from "vitest";

import { resolvePredecessorSessionArtifacts, SESSION_START_ARTIFACT_KINDS, type SessionMemoryRepository } from "../../../src/app/session-memory/index.js";
import type { SessionArtifact, SessionLineageEdge } from "../../../src/app/session-memory/types.js";

describe("resolvePredecessorSessionArtifacts", () => {
  it("loads predecessor session artifacts for session-start recall seeding", async () => {
    const repository = createRepository({
      lineageEdge: {
        id: "edge-1",
        childSessionKey: "child-session",
        parentSessionKey: "parent-session",
        reason: "resume",
        observedAt: "2026-05-30T00:00:00.000Z",
      },
      artifacts: [
        {
          id: "compact-1",
          kind: "compaction_checkpoint",
          sessionKey: "parent-session",
          source: "openclaw",
          sourceId: "compact-1",
          contentHash: "hash-1",
          summary: "Previous work focused on adapter boundaries.",
          createdAt: "2026-05-30T00:00:00.000Z",
        },
        {
          id: "episode-1",
          kind: "session_episode",
          sessionKey: "parent-session",
          source: "openclaw",
          sourceId: "episode-1",
          contentHash: "hash-2",
          summary: "Session episode summary.",
          createdAt: "2026-05-30T00:00:01.000Z",
        },
      ],
    });

    await expect(resolvePredecessorSessionArtifacts({ sessionKey: "child-session" }, repository)).resolves.toMatchObject({
      lineageEdge: {
        parentSessionKey: "parent-session",
      },
      artifacts: [{ id: "compact-1" }, { id: "episode-1" }],
    });
    expect(repository.listSessionArtifacts).toHaveBeenCalledWith({
      sessionKey: "parent-session",
      kinds: [...SESSION_START_ARTIFACT_KINDS],
      limit: 10,
    });
  });

  it("resolves predecessor artifacts from parent source refs when no parent session key exists", async () => {
    const repository = createRepository({
      lineageEdge: {
        id: "edge-1",
        childSessionKey: "child-session",
        parentSourceRef: "compaction:/tmp/previous-session.jsonl",
        reason: "resume",
        observedAt: "2026-05-30T00:00:00.000Z",
      },
      artifacts: [
        {
          id: "compact-1",
          kind: "compaction_checkpoint",
          sessionKey: "openclaw:parent",
          source: "openclaw",
          sourceId: "compact-1",
          sourceRef: "compaction:/tmp/previous-session.jsonl",
          contentHash: "hash-1",
          summary: "Compaction checkpoint for the previous session.",
          createdAt: "2026-05-30T00:00:00.000Z",
        },
      ],
    });

    await expect(resolvePredecessorSessionArtifacts({ sessionKey: "child-session" }, repository)).resolves.toMatchObject({
      artifacts: [{ id: "compact-1" }],
    });
    expect(repository.listSessionArtifactsBySourceRef).toHaveBeenCalledWith({
      sourceRef: "compaction:/tmp/previous-session.jsonl",
      kinds: [...SESSION_START_ARTIFACT_KINDS],
      limit: 10,
    });
    expect(repository.listSessionArtifacts).not.toHaveBeenCalled();
  });
});

function createRepository(input: { lineageEdge?: SessionLineageEdge; artifacts?: SessionArtifact[] } = {}): SessionMemoryRepository {
  const artifacts = input.artifacts ?? [];

  return {
    upsertLineageEdge: vi.fn(),
    upsertSessionArtifact: vi.fn(),
    recordTriggerIntake: vi.fn(),
    listSessionArtifacts: vi.fn(async () => artifacts),
    listSessionArtifactsBySourceRef: vi.fn(async () => artifacts),
    getLatestLineageEdgeForChild: vi.fn(async () => input.lineageEdge ?? null),
  };
}
