import { describe, expect, it, vi } from "vitest";

import { recordWorkingSetEpisodePromotionOutcome } from "../../../src/adapters/shared/working-set-episode-promotion.js";
import type { RecordWorkingSetEpisodePromotionInput, WorkingMemoryRepository } from "../../../src/app/working-memory/repository.js";
import type { WorkingSetRecord } from "../../../src/app/working-memory/records.js";
import { createTestWorkingSet } from "../../app/working-memory/service-test-helpers.js";

describe("recordWorkingSetEpisodePromotionOutcome", () => {
  it("logs and skips when no working-memory repository is available", async () => {
    const logger = createCapturingLogger();

    await recordWorkingSetEpisodePromotionOutcome({
      repository: undefined,
      workingSetId: "ws-1",
      episodeId: "ep-1",
      actionLabel: "session-end episode",
      logger,
    });

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("reason=no_working_memory_repository"));
  });

  it("records the episode id on the closed working set", async () => {
    const logger = createCapturingLogger();
    const workingSet = createTestWorkingSet({
      id: "ws-1",
      scopeKind: "session",
      scopeKey: "session:session-1",
      status: "closed",
      revision: 4,
      snapshot: {
        objective: "Ship it.",
        candidates: [{ kind: "episodic", summary: "Did things.", provenance: { evidenceEventSequences: [1] }, promotionStatus: "pending" }],
      },
    });
    const { repository, promotionWrites } = createPromotionRepository(workingSet);

    await recordWorkingSetEpisodePromotionOutcome({
      repository,
      workingSetId: "ws-1",
      episodeId: "ep-1",
      actionLabel: "session-end episode",
      logger,
    });

    expect(promotionWrites).toHaveLength(1);
    expect(promotionWrites[0]?.episodeId).toBe("ep-1");
    expect(promotionWrites[0]?.snapshot.candidates?.[0]?.promotionStatus).toBe("promoted");
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("promotion recorded for workingSet=ws-1 episode=ep-1"));
  });

  it("logs a warning instead of throwing when the record fails", async () => {
    const logger = createCapturingLogger();
    const { repository } = createPromotionRepository(null);

    await recordWorkingSetEpisodePromotionOutcome({
      repository,
      workingSetId: "ws-missing",
      episodeId: "ep-1",
      actionLabel: "session-end episode",
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("reason=not_found"));
  });
});

/** Builds spy-backed info/warn logger doubles. */
function createCapturingLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

/** Builds a working-memory repository double that captures episode promotion writes. */
function createPromotionRepository(workingSet: WorkingSetRecord | null): {
  repository: WorkingMemoryRepository;
  promotionWrites: RecordWorkingSetEpisodePromotionInput[];
} {
  const promotionWrites: RecordWorkingSetEpisodePromotionInput[] = [];

  return {
    promotionWrites,
    repository: {
      getWorkingSet: async (id) => (workingSet && id === workingSet.id ? workingSet : null),
      findCurrentWorkingSets: async () => [],
      listWorkingSets: async () => [],
      listWorkingEvents: async () => [],
      createWorkingSet: async () => ({ kind: "active_set_exists", scopeKey: "test" }),
      updateWorkingSet: async () => ({ kind: "not_found" }),
      patchWorkingSetUsage: async () => ({ kind: "not_found" }),
      patchWorkingSetUsageAndUpdate: async () => ({ kind: "not_found" }),
      recordCandidateConsolidation: async () => ({ kind: "not_found" }),
      listReapableWorkingSets: async () => [],
      deleteWorkingSets: async () => ({ workingSetsDeleted: 0, workingEventsDeleted: 0 }),
      recordEpisodePromotion: async (input) => {
        if (!workingSet) {
          return { kind: "not_found" };
        }

        promotionWrites.push(input);
        return {
          workingSet: { ...workingSet, snapshot: input.snapshot, episodeId: input.episodeId, updatedAt: input.now },
        };
      },
    },
  };
}
