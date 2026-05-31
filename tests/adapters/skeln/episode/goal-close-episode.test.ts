import type { ExtensionContext } from "skeln";
import { beforeEach, describe, expect, it, vi } from "vitest";

const writeBoundedSessionEpisodeMock = vi.hoisted(() =>
  vi.fn<typeof import("../../../../src/adapters/skeln/episode/bounded-session-episode.js").writeSkelnBoundedSessionEpisode>(),
);

vi.mock("../../../../src/adapters/skeln/episode/bounded-session-episode.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/adapters/skeln/episode/bounded-session-episode.js")>();
  return {
    ...actual,
    writeSkelnBoundedSessionEpisode: writeBoundedSessionEpisodeMock,
  };
});

import { scheduleSkelnGoalCloseEpisodePromotion } from "../../../../src/adapters/skeln/episode/goal-close-episode.js";
import type { WorkingSetRecord } from "../../../../src/app/working-memory/records.js";
import type { WorkingMemoryResult } from "../../../../src/app/working-memory/results.js";
import type { AgenrSkelnServices } from "../../../../src/adapters/skeln/runtime.js";

describe("scheduleSkelnGoalCloseEpisodePromotion", () => {
  beforeEach(() => {
    writeBoundedSessionEpisodeMock.mockReset();
    writeBoundedSessionEpisodeMock.mockResolvedValue(undefined);
  });

  it("does not schedule promotion when close emitted no pending episodic candidate", () => {
    scheduleSkelnGoalCloseEpisodePromotion({
      context: {} as ExtensionContext,
      services: {} as AgenrSkelnServices,
      closeResult: buildCloseResult([]),
    });

    expect(writeBoundedSessionEpisodeMock).not.toHaveBeenCalled();
  });

  it("does not schedule promotion when episodic candidates are already promoted", () => {
    scheduleSkelnGoalCloseEpisodePromotion({
      context: {} as ExtensionContext,
      services: {} as AgenrSkelnServices,
      closeResult: buildCloseResult([
        {
          kind: "episodic",
          summary: "Done.",
          provenance: {
            evidenceEventSequences: [1],
            sourceRef: "working_set:ws-1#rev:1",
          },
          promotionStatus: "promoted",
        },
      ]),
    });

    expect(writeBoundedSessionEpisodeMock).not.toHaveBeenCalled();
  });

  it("schedules promotion when close emitted a pending episodic candidate", async () => {
    const context = {
      sessionManager: {
        getSessionId: () => "session-1",
        getSessionFile: () => "/tmp/session.jsonl",
      },
    } as ExtensionContext;
    const services = {} as AgenrSkelnServices;

    scheduleSkelnGoalCloseEpisodePromotion({
      context,
      services,
      closeResult: buildCloseResult([
        {
          kind: "episodic",
          summary: "Done.",
          provenance: {
            evidenceEventSequences: [1],
            sourceRef: "working_set:ws-1#rev:1",
          },
          promotionStatus: "pending",
        },
      ]),
    });

    await Promise.resolve();
    expect(writeBoundedSessionEpisodeMock).toHaveBeenCalledOnce();
    expect(writeBoundedSessionEpisodeMock.mock.calls[0]?.[0]).toMatchObject({
      context,
      services,
      actionLabel: "skeln goal close episode promotion",
      skipDetails: "session=session-1 workingSet=ws-1",
    });
  });

  it("logs promotion failures without throwing", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    writeBoundedSessionEpisodeMock.mockRejectedValue(new Error("summary failed"));

    scheduleSkelnGoalCloseEpisodePromotion({
      context: {
        sessionManager: {
          getSessionId: () => "session-1",
          getSessionFile: () => "/tmp/session.jsonl",
        },
      } as ExtensionContext,
      services: {} as AgenrSkelnServices,
      logger,
      closeResult: buildCloseResult([
        {
          kind: "episodic",
          summary: "Done.",
          provenance: {
            evidenceEventSequences: [1],
            sourceRef: "working_set:ws-1#rev:1",
          },
          promotionStatus: "pending",
        },
      ]),
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(logger.warn).toHaveBeenCalledWith("[agenr] skeln goal close episode promotion failed: summary failed");
  });
});

/** Builds one successful close result for goal-close episode tests. */
function buildCloseResult(
  candidates: Extract<WorkingMemoryResult, { ok: true; action: "close" }>["candidates"],
): Extract<WorkingMemoryResult, { ok: true; action: "close" }> {
  const workingSet = {
    id: "ws-1",
    scopeKey: "conversation:session-1",
    scopeKind: "conversation",
    title: "Goal",
    objective: "Ship it.",
    status: "closed",
    snapshot: { objective: "Ship it." },
    revision: 2,
    sessionId: "session-1",
    conversationKey: "session-1",
    source: "test",
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:00.000Z",
    lastActiveAt: "2026-05-31T00:00:00.000Z",
  } satisfies WorkingSetRecord;

  return {
    ok: true,
    action: "close",
    workingSet,
    event: {
      id: "event-1",
      workingSetId: "ws-1",
      sequence: 2,
      type: "closed",
      payload: {},
      createdAt: "2026-05-31T00:00:00.000Z",
    },
    candidates,
  };
}
