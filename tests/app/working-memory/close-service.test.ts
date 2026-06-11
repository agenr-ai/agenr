import { describe, expect, it } from "vitest";

import { createHostWorkingSetPolicy } from "../../../src/app/working-memory/host-working-set-policy.js";
import { buildWorkingCloseSnapshot, handleClose } from "../../../src/app/working-memory/handlers.js";
import { CLOSE_EVENT_HISTORY_LIMIT } from "../../../src/app/working-memory/limits.js";
import type { WorkingEventRecord, WorkingSetRecord } from "../../../src/app/working-memory/records.js";
import type { UpdateWorkingSetInput, WorkingMemoryRepository } from "../../../src/app/working-memory/repository.js";
import type { WorkingCandidate, WorkingSnapshot } from "../../../src/app/working-memory/snapshot.js";
import { createTestWorkingSet } from "./service-test-helpers.js";

describe("buildWorkingCloseSnapshot", () => {
  it("does not append a second episodic candidate when one already exists", () => {
    const existingEpisode: WorkingCandidate = {
      kind: "episodic",
      summary: "Existing handoff.",
      provenance: {
        evidenceEventSequences: [1],
        sourceRef: "working_set:ws-1#rev:1",
      },
      promotionStatus: "pending",
    };

    const closeSnapshot = buildWorkingCloseSnapshot({
      workingSetId: "ws-1",
      snapshot: {
        summary: "Existing summary.",
        candidates: [existingEpisode],
      },
      currentRevision: 2,
      closeReason: "Done.",
      createEpisode: true,
      eventSequences: [1, 2],
      now: "2026-05-30T12:00:00.000Z",
    });

    expect(closeSnapshot.candidates).toEqual([existingEpisode]);
    expect(closeSnapshot.snapshot.candidates).toEqual([existingEpisode]);
  });

  it("builds the final summary from close reason, summary, objective, then the default fallback", () => {
    const cases: Array<{ closeReason: string; snapshot: WorkingSnapshot; expected: string }> = [
      {
        closeReason: "Explicit close.",
        snapshot: {
          summary: "Snapshot summary.",
          objective: "Snapshot objective.",
        },
        expected: "Explicit close.",
      },
      {
        closeReason: "  ",
        snapshot: {
          summary: "Snapshot summary.",
          objective: "Snapshot objective.",
        },
        expected: "Snapshot summary.",
      },
      {
        closeReason: "  ",
        snapshot: {
          objective: "Snapshot objective.",
        },
        expected: "Snapshot objective.",
      },
      {
        closeReason: "  ",
        snapshot: {},
        expected: "Working set closed.",
      },
    ];

    for (const testCase of cases) {
      expect(
        buildWorkingCloseSnapshot({
          workingSetId: "ws-1",
          snapshot: testCase.snapshot,
          currentRevision: 1,
          closeReason: testCase.closeReason,
          eventSequences: [],
          now: "2026-05-30T12:00:00.000Z",
        }).snapshot.checkpoint?.summary,
      ).toBe(testCase.expected);
    }
  });
});

describe("handleClose", () => {
  it("loads only the bounded close event history for episodic candidate evidence", async () => {
    const workingSet = createTestWorkingSet({
      id: "ws-close",
      scopeKind: "conversation",
      scopeKey: "conversation:close",
      revision: 7,
      snapshot: {
        objective: "Close with bounded evidence.",
      },
    });
    let observedEventLimit: number | undefined;
    let updateInput: UpdateWorkingSetInput | undefined;
    const repository = createCloseRepository({
      workingSet,
      listWorkingEvents: async (_workingSetId, limit) => {
        observedEventLimit = limit;
        return Array.from({ length: limit ?? 0 }, (_value, index) => createEvent(workingSet.id, index + 1));
      },
      updateWorkingSet: async (input) => {
        updateInput = input;
        return {
          workingSet: {
            ...workingSet,
            revision: input.expectedRevision + 1,
            status: input.status,
            snapshot: input.snapshot,
            closeReason: input.closeReason,
            closedAt: input.closedAt,
          },
          event: createEvent(workingSet.id, input.expectedRevision + 1, "closed"),
        };
      },
    });

    const result = await handleClose(
      {
        action: "close",
        workingSetId: workingSet.id,
        expectedRevision: workingSet.revision,
        closeReason: "Task complete.",
        createEpisode: true,
        actor: "user",
        source: "goal_command",
      },
      {
        repository,
        timestamp: "2026-05-30T12:00:00.000Z",
        policy: createHostWorkingSetPolicy(),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      action: "close",
      candidates: [
        {
          kind: "episodic",
          provenance: {
            evidenceEventSequences: expect.arrayContaining([1, CLOSE_EVENT_HISTORY_LIMIT]),
          },
        },
      ],
    });
    expect(observedEventLimit).toBe(CLOSE_EVENT_HISTORY_LIMIT);
    expect(updateInput?.snapshot.candidates?.[0]?.provenance.evidenceEventSequences).toHaveLength(CLOSE_EVENT_HISTORY_LIMIT);
  });
});

interface CloseRepositoryOverrides {
  workingSet: WorkingSetRecord;
  listWorkingEvents: WorkingMemoryRepository["listWorkingEvents"];
  updateWorkingSet: WorkingMemoryRepository["updateWorkingSet"];
}

function createCloseRepository(overrides: CloseRepositoryOverrides): WorkingMemoryRepository {
  return {
    getWorkingSet: async (id) => (id === overrides.workingSet.id ? overrides.workingSet : null),
    findCurrentWorkingSets: async () => [],
    listWorkingSets: async () => [],
    listWorkingEvents: overrides.listWorkingEvents,
    createWorkingSet: async () => ({ kind: "active_set_exists", scopeKey: "test" }),
    updateWorkingSet: overrides.updateWorkingSet,
    patchWorkingSetUsage: async () => ({ kind: "not_found" }),
    patchWorkingSetUsageAndUpdate: async () => ({ kind: "not_found" }),
    recordEpisodePromotion: async () => ({ kind: "not_found" }),
    recordCandidateConsolidation: async () => ({ kind: "not_found" }),
    listReapableWorkingSets: async () => [],
    deleteWorkingSets: async () => ({ workingSetsDeleted: 0, workingEventsDeleted: 0 }),
  };
}

function createEvent(workingSetId: string, sequence: number, eventType: WorkingEventRecord["eventType"] = "set_scratchpad"): WorkingEventRecord {
  return {
    id: `event-${sequence}`,
    workingSetId,
    sequence,
    eventType,
    payload: {},
    createdAt: "2026-05-30T12:00:00.000Z",
  };
}
