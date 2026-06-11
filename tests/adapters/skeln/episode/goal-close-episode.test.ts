import type { ExtensionContext } from "../../../../src/adapters/skeln/skeln-types.js";
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
import type { EpisodeTranscriptIngestResult } from "../../../../src/app/episode-ingest/index.js";
import type { WorkingSetRecord } from "../../../../src/app/working-memory/records.js";
import type { RecordWorkingSetEpisodePromotionInput, WorkingMemoryRepository } from "../../../../src/app/working-memory/repository.js";
import type { WorkingMemoryResult } from "../../../../src/app/working-memory/results.js";
import type { WorkingSnapshot } from "../../../../src/app/working-memory/snapshot.js";
import type { AgenrSkelnServices } from "../../../../src/adapters/skeln/runtime.js";

const PENDING_EPISODIC_CANDIDATE = {
  kind: "episodic",
  summary: "Done.",
  provenance: {
    evidenceEventSequences: [1],
    sourceRef: "working_set:ws-1#rev:1",
  },
  promotionStatus: "pending",
} as const;

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
          ...PENDING_EPISODIC_CANDIDATE,
          promotionStatus: "promoted",
        },
      ]),
    });

    expect(writeBoundedSessionEpisodeMock).not.toHaveBeenCalled();
  });

  it("snapshots host facts before bounded promotion write starts", () => {
    const calls: string[] = [];
    writeBoundedSessionEpisodeMock.mockImplementation(async () => {
      calls.push("write");
      return undefined;
    });

    scheduleSkelnGoalCloseEpisodePromotion({
      context: {
        sessionManager: {
          getSessionId: () => {
            calls.push("sessionId");
            return "session-1";
          },
          getSessionFile: () => {
            calls.push("sessionFile");
            return "/tmp/session.jsonl";
          },
        },
      } as ExtensionContext,
      services: {} as AgenrSkelnServices,
      closeResult: buildCloseResult([PENDING_EPISODIC_CANDIDATE]),
    });

    expect(calls).toEqual(["sessionId", "sessionFile", "write"]);
    expect(writeBoundedSessionEpisodeMock.mock.calls[0]?.[0]).toMatchObject({
      target: {
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
      },
    });
  });

  it("schedules promotion with the distilled closing snapshot as curated task state", async () => {
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
      closeResult: buildCloseResult([PENDING_EPISODIC_CANDIDATE], {
        objective: "Ship it.",
        checkpoint: {
          summary: "Done. Feature shipped.",
          recordedAt: "2026-05-31T00:00:00.000Z",
        },
        decisions: [{ decision: "Cut scope to one seam." }],
      }),
    });

    await Promise.resolve();
    expect(writeBoundedSessionEpisodeMock).toHaveBeenCalledOnce();
    expect(writeBoundedSessionEpisodeMock.mock.calls[0]?.[0]).toMatchObject({
      target: {
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
      },
      services,
      actionLabel: "skeln goal close episode promotion",
      skipDetails: "session=session-1 workingSet=ws-1",
      curatedTaskState: ["Objective: Ship it.", "Final checkpoint: Done. Feature shipped.", "Decisions:", "- Cut scope to one seam."].join("\n"),
    });
  });

  it("records the promotion flip on the closed set after a successful episode write", async () => {
    writeBoundedSessionEpisodeMock.mockResolvedValue(buildExecutedIngestResult("episode-9"));
    const repository = createRecordingRepository(
      buildClosedWorkingSet({
        objective: "Ship it.",
        candidates: [PENDING_EPISODIC_CANDIDATE],
      }),
    );
    const logger = { info: vi.fn(), warn: vi.fn() };

    scheduleSkelnGoalCloseEpisodePromotion({
      context: buildContext(),
      services: { workingMemoryRepository: repository.repository } as AgenrSkelnServices,
      logger,
      closeResult: buildCloseResult([PENDING_EPISODIC_CANDIDATE]),
    });

    await flushAsyncWork();
    expect(repository.recordedInputs).toHaveLength(1);
    expect(repository.recordedInputs[0]).toMatchObject({
      workingSetId: "ws-1",
      episodeId: "episode-9",
      snapshot: {
        candidates: [expect.objectContaining({ kind: "episodic", promotionStatus: "promoted" })],
      },
    });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("[agenr] skeln goal close promotion recorded for workingSet=ws-1 episode=episode-9 changed=true");
  });

  it("does not record promotion when the bounded write was skipped", async () => {
    writeBoundedSessionEpisodeMock.mockResolvedValue({
      kind: "skipped",
      skipped: {
        filePath: "/tmp/session.jsonl",
        reason: "below_activity_threshold",
        transcriptHash: "hash-1",
        messageCount: 1,
        agentId: null,
        surface: null,
        metadataSource: "reconstructed",
      },
    });
    const repository = createRecordingRepository(buildClosedWorkingSet({ candidates: [PENDING_EPISODIC_CANDIDATE] }));

    scheduleSkelnGoalCloseEpisodePromotion({
      context: buildContext(),
      services: { workingMemoryRepository: repository.repository } as AgenrSkelnServices,
      closeResult: buildCloseResult([PENDING_EPISODIC_CANDIDATE]),
    });

    await flushAsyncWork();
    expect(repository.recordedInputs).toHaveLength(0);
  });

  it("logs promotion-record failures without throwing", async () => {
    writeBoundedSessionEpisodeMock.mockResolvedValue(buildExecutedIngestResult("episode-9"));
    const repository = createRecordingRepository(null);
    const logger = { info: vi.fn(), warn: vi.fn() };

    scheduleSkelnGoalCloseEpisodePromotion({
      context: buildContext(),
      services: { workingMemoryRepository: repository.repository } as AgenrSkelnServices,
      logger,
      closeResult: buildCloseResult([PENDING_EPISODIC_CANDIDATE]),
    });

    await flushAsyncWork();
    expect(logger.warn).toHaveBeenCalledWith("[agenr] skeln goal close promotion status not recorded for workingSet=ws-1 episode=episode-9 reason=not_found");
  });

  it("does not touch live host context during scheduled promotion", async () => {
    let sessionFileReads = 0;

    scheduleSkelnGoalCloseEpisodePromotion({
      context: {
        sessionManager: {
          getSessionId: () => "session-1",
          getSessionFile: () => {
            sessionFileReads += 1;
            if (sessionFileReads > 1) {
              throw new Error("stale context access");
            }
            return "/tmp/session.jsonl";
          },
        },
      } as ExtensionContext,
      services: {} as AgenrSkelnServices,
      closeResult: buildCloseResult([PENDING_EPISODIC_CANDIDATE]),
    });

    expect(sessionFileReads).toBe(1);
    await Promise.resolve();
    expect(sessionFileReads).toBe(1);
  });

  it("logs promotion failures without throwing", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    writeBoundedSessionEpisodeMock.mockRejectedValue(new Error("summary failed"));

    scheduleSkelnGoalCloseEpisodePromotion({
      context: buildContext(),
      services: {} as AgenrSkelnServices,
      logger,
      closeResult: buildCloseResult([PENDING_EPISODIC_CANDIDATE]),
    });

    await flushAsyncWork();
    expect(logger.warn).toHaveBeenCalledWith("[agenr] skeln goal close episode promotion failed: summary failed");
  });
});

/** Waits for queued microtasks and immediates so scheduled writes settle. */
async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** Builds a live extension context double for scheduling tests. */
function buildContext(): ExtensionContext {
  return {
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => "/tmp/session.jsonl",
    },
  } as ExtensionContext;
}

/** Builds one executed single-transcript ingest result. */
function buildExecutedIngestResult(episodeId: string): EpisodeTranscriptIngestResult {
  return {
    kind: "executed",
    candidate: {
      filePath: "/tmp/session.jsonl",
      sessionId: "session-1",
      sourceRef: "/tmp/session.jsonl#working_set:ws-1",
      transcriptHash: "hash-1",
      messageCount: 4,
      agentId: null,
      surface: "skeln",
      metadataSource: "reconstructed",
      renderedTranscript: "User: Ship it.\nAssistant: Done.",
      estimatedInputTokens: 16,
    },
    session: {
      action: "written",
      filePath: "/tmp/session.jsonl",
      sessionId: "session-1",
      activityLevel: "substantial",
      episodeId,
      usage: {
        calls: 1,
        inputTokens: 16,
        outputTokens: 8,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 24,
        totalCost: 0,
      },
    },
  };
}

/** Builds one closed working-set record for promotion-record tests. */
function buildClosedWorkingSet(snapshot: WorkingSnapshot): WorkingSetRecord {
  return {
    id: "ws-1",
    scopeKey: "conversation:session-1",
    scopeKind: "conversation",
    status: "closed",
    snapshot,
    revision: 2,
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:00.000Z",
    lastActiveAt: "2026-05-31T00:00:00.000Z",
  };
}

/** Builds a repository double that records episode-promotion writes. */
function createRecordingRepository(workingSet: WorkingSetRecord | null): {
  repository: WorkingMemoryRepository;
  recordedInputs: RecordWorkingSetEpisodePromotionInput[];
} {
  const recordedInputs: RecordWorkingSetEpisodePromotionInput[] = [];
  const repository: WorkingMemoryRepository = {
    getWorkingSet: async (id) => (workingSet && workingSet.id === id ? workingSet : null),
    findCurrentWorkingSets: async () => [],
    listWorkingSets: async () => [],
    listWorkingEvents: async () => [],
    createWorkingSet: async () => ({ kind: "active_set_exists", scopeKey: "test" }),
    updateWorkingSet: async () => ({ kind: "not_found" }),
    patchWorkingSetUsage: async () => ({ kind: "not_found" }),
    patchWorkingSetUsageAndUpdate: async () => ({ kind: "not_found" }),
    recordEpisodePromotion: async (input) => {
      recordedInputs.push(input);
      if (!workingSet || workingSet.id !== input.workingSetId) {
        return { kind: "not_found" };
      }

      return {
        workingSet: {
          ...workingSet,
          snapshot: input.snapshot,
          episodeId: input.episodeId,
          updatedAt: input.now,
        },
      };
    },
    recordCandidateConsolidation: async () => ({ kind: "not_found" }),
    listReapableWorkingSets: async () => [],
    deleteWorkingSets: async () => ({ workingSetsDeleted: 0, workingEventsDeleted: 0 }),
  };

  return { repository, recordedInputs };
}

/** Builds one successful close result for goal-close episode tests. */
function buildCloseResult(
  candidates: Extract<WorkingMemoryResult, { ok: true; action: "close" }>["candidates"],
  snapshot: WorkingSnapshot = { objective: "Ship it." },
): Extract<WorkingMemoryResult, { ok: true; action: "close" }> {
  const workingSet = {
    id: "ws-1",
    scopeKey: "conversation:session-1",
    scopeKind: "conversation",
    title: "Goal",
    objective: "Ship it.",
    status: "closed",
    snapshot,
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
      eventType: "closed",
      payload: {},
      createdAt: "2026-05-31T00:00:00.000Z",
    },
    candidates,
  };
}
