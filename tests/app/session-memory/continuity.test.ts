import { describe, expect, it, vi } from "vitest";

import { resolvePredecessorContinuityContext, type SessionMemoryRepository } from "../../../src/app/session-memory/index.js";
import type { SessionArtifact, SessionLineageEdge } from "../../../src/app/session-memory/types.js";

describe("resolvePredecessorContinuityContext", () => {
  it("builds host-neutral continuity text from predecessor session artifacts", async () => {
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
          id: "summary-1",
          kind: "continuity_summary",
          sessionKey: "parent-session",
          source: "skeln",
          sourceId: "summary-1",
          contentHash: "hash-1",
          summary: "The previous session summary.",
          createdAt: "2026-05-30T00:00:00.000Z",
        },
        {
          id: "tail-1",
          kind: "recent_session",
          sessionKey: "parent-session",
          source: "skeln",
          sourceId: "tail-1",
          contentHash: "hash-2",
          summary: "U: last user turn\nA: last assistant turn",
          createdAt: "2026-05-30T00:00:01.000Z",
        },
      ],
    });

    await expect(resolvePredecessorContinuityContext({ sessionKey: "child-session" }, repository)).resolves.toMatchObject({
      lineageEdge: {
        parentSessionKey: "parent-session",
      },
      continuitySummaryText: "The previous session summary.",
      recentSessionText: "U: last user turn\nA: last assistant turn",
    });
    expect(repository.listSessionArtifacts).toHaveBeenCalledWith({
      sessionKey: "parent-session",
      kinds: ["continuity_summary", "recent_session"],
      limit: 10,
    });
  });

  it("resolves continuity artifacts from parent source refs when no parent session key exists", async () => {
    const repository = createRepository({
      lineageEdge: {
        id: "edge-1",
        childSessionKey: "child-session",
        parentSourceRef: "previous-session.jsonl",
        reason: "resume",
        observedAt: "2026-05-30T00:00:00.000Z",
      },
      artifacts: [
        {
          id: "summary-1",
          kind: "continuity_summary",
          sessionKey: "skeln:parent",
          source: "skeln",
          sourceId: "summary-1",
          sourceRef: "previous-session.jsonl",
          contentHash: "hash-1",
          summary: "The previous session summary.",
          createdAt: "2026-05-30T00:00:00.000Z",
        },
      ],
    });

    await expect(resolvePredecessorContinuityContext({ sessionKey: "child-session" }, repository)).resolves.toMatchObject({
      continuitySummaryText: "The previous session summary.",
    });
    expect(repository.listSessionArtifactsBySourceRef).toHaveBeenCalledWith({
      sourceRef: "previous-session.jsonl",
      kinds: ["continuity_summary", "recent_session"],
      limit: 10,
    });
    expect(repository.listSessionArtifacts).not.toHaveBeenCalled();
  });

  it("selects the first artifact summary per kind from repository ordering", async () => {
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
          id: "summary-new",
          kind: "continuity_summary",
          sessionKey: "parent-session",
          source: "skeln",
          sourceId: "summary-new",
          contentHash: "hash-new",
          summary: "Newer summary.",
          createdAt: "2026-05-30T00:00:01.000Z",
        },
        {
          id: "summary-old",
          kind: "continuity_summary",
          sessionKey: "parent-session",
          source: "skeln",
          sourceId: "summary-old",
          contentHash: "hash-old",
          summary: "Older summary.",
          createdAt: "2026-05-30T00:00:00.000Z",
        },
      ],
    });

    await expect(resolvePredecessorContinuityContext({ sessionKey: "child-session" }, repository)).resolves.toMatchObject({
      continuitySummaryText: "Newer summary.",
    });
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
