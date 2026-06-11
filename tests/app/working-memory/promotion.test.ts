import { describe, expect, it } from "vitest";

import { markEpisodicCandidatesPromoted, recordWorkingSetEpisodicPromotion } from "../../../src/app/working-memory/promotion.js";
import type { WorkingMemoryRepository } from "../../../src/app/working-memory/repository.js";
import type { WorkingSnapshot } from "../../../src/app/working-memory/snapshot.js";
import { closeWorkingMemoryTestService, createTestWorkingSet, createWorkingMemoryTestService } from "./service-test-helpers.js";

const TRUSTED_SCOPE = {
  conversationKey: "promotion-session",
  sessionId: "promotion-session",
  cwd: "/tmp/project",
};

describe("markEpisodicCandidatesPromoted", () => {
  it("flips pending episodic candidates and leaves other candidates untouched", () => {
    const snapshot: WorkingSnapshot = {
      objective: "Ship it.",
      candidates: [
        {
          kind: "episodic",
          summary: "Shipped the feature.",
          provenance: { evidenceEventSequences: [1] },
          promotionStatus: "pending",
        },
        {
          kind: "episodic",
          summary: "Earlier handoff.",
          provenance: { evidenceEventSequences: [1] },
          promotionStatus: "dismissed",
        },
        {
          kind: "semantic",
          subject: "deploy",
          content: "Deploys run from CI only.",
          provenance: { evidenceEventSequences: [2] },
          promotionStatus: "pending",
        },
      ],
    };

    const result = markEpisodicCandidatesPromoted(snapshot);

    expect(result.changed).toBe(true);
    expect(result.snapshot.candidates).toEqual([
      expect.objectContaining({ kind: "episodic", summary: "Shipped the feature.", promotionStatus: "promoted" }),
      expect.objectContaining({ kind: "episodic", summary: "Earlier handoff.", promotionStatus: "dismissed" }),
      expect.objectContaining({ kind: "semantic", promotionStatus: "pending" }),
    ]);
    // Input snapshot is not mutated.
    expect(snapshot.candidates?.[0]?.promotionStatus).toBe("pending");
  });

  it("reports unchanged when no pending episodic candidates exist", () => {
    expect(markEpisodicCandidatesPromoted({}).changed).toBe(false);
    expect(
      markEpisodicCandidatesPromoted({
        candidates: [
          {
            kind: "episodic",
            summary: "Already recorded.",
            provenance: { evidenceEventSequences: [1] },
            promotionStatus: "promoted",
          },
        ],
      }).changed,
    ).toBe(false);
  });
});

describe("recordWorkingSetEpisodicPromotion", () => {
  it("fails with not_found when the working set does not exist", async () => {
    const repository = createPromotionRepository();

    const result = await recordWorkingSetEpisodicPromotion(repository, {
      workingSetId: "missing",
      episodeId: "episode-1",
      now: "2026-05-31T00:00:00.000Z",
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("fails with not_closed when the working set is still open", async () => {
    const repository = createPromotionRepository({
      workingSet: createTestWorkingSet({
        id: "ws-open",
        scopeKind: "conversation",
        scopeKey: "conversation:promotion-session",
        status: "active",
      }),
    });

    const result = await recordWorkingSetEpisodicPromotion(repository, {
      workingSetId: "ws-open",
      episodeId: "episode-1",
      now: "2026-05-31T00:00:00.000Z",
    });

    expect(result).toEqual({ ok: false, reason: "not_closed" });
  });

  it("is idempotent when the episode id is already recorded and nothing is pending", async () => {
    const workingSet = createTestWorkingSet({
      id: "ws-recorded",
      scopeKind: "conversation",
      scopeKey: "conversation:promotion-session",
      status: "closed",
      episodeId: "episode-1",
      snapshot: {
        candidates: [
          {
            kind: "episodic",
            summary: "Shipped.",
            provenance: { evidenceEventSequences: [1] },
            promotionStatus: "promoted",
          },
        ],
      },
    });
    let writes = 0;
    const repository = createPromotionRepository({
      workingSet,
      onRecordEpisodePromotion: () => {
        writes += 1;
      },
    });

    const result = await recordWorkingSetEpisodicPromotion(repository, {
      workingSetId: "ws-recorded",
      episodeId: "episode-1",
      now: "2026-05-31T00:00:00.000Z",
    });

    expect(result).toEqual({ ok: true, workingSet, changed: false });
    expect(writes).toBe(0);
  });

  it("flips the pending candidate and records the episode id on a real closed set", async () => {
    const { database, dbPath, repository, service } = await createWorkingMemoryTestService();

    try {
      const created = await service.run({
        action: "create",
        target: "goal",
        scope: TRUSTED_SCOPE,
        operation: {
          type: "set_objective",
          objective: "Ship the promotion seam.",
        },
        updateReason: "Started goal.",
        source: "goal_command",
      });
      if (!created.ok || created.action !== "create") {
        throw new Error("Expected create success.");
      }

      const closed = await service.run({
        action: "close",
        workingSetId: created.workingSet.id,
        closeReason: "Shipped the promotion seam.",
        createEpisode: true,
        source: "goal_command",
      });
      if (!closed.ok || closed.action !== "close") {
        throw new Error("Expected close success.");
      }
      expect(closed.candidates).toEqual([expect.objectContaining({ kind: "episodic", promotionStatus: "pending" })]);

      const result = await recordWorkingSetEpisodicPromotion(repository, {
        workingSetId: created.workingSet.id,
        episodeId: "episode-77",
        now: "2026-05-31T00:00:00.000Z",
      });

      expect(result).toMatchObject({ ok: true, changed: true });
      const reloaded = await repository.getWorkingSet(created.workingSet.id);
      expect(reloaded).toMatchObject({
        status: "closed",
        episodeId: "episode-77",
        // Bookkeeping writes never advance the optimistic-concurrency revision.
        revision: closed.workingSet.revision,
        snapshot: {
          candidates: [expect.objectContaining({ kind: "episodic", promotionStatus: "promoted" })],
        },
      });

      // A second record attempt is a no-op success.
      const repeated = await recordWorkingSetEpisodicPromotion(repository, {
        workingSetId: created.workingSet.id,
        episodeId: "episode-77",
        now: "2026-05-31T01:00:00.000Z",
      });
      expect(repeated).toMatchObject({ ok: true, changed: false });
    } finally {
      await closeWorkingMemoryTestService(database, dbPath);
    }
  });
});

/** Builds a stub repository for promotion unit tests. */
function createPromotionRepository(
  options: {
    workingSet?: ReturnType<typeof createTestWorkingSet>;
    onRecordEpisodePromotion?: () => void;
  } = {},
): WorkingMemoryRepository {
  return {
    getWorkingSet: async (id) => (options.workingSet && options.workingSet.id === id ? options.workingSet : null),
    findCurrentWorkingSets: async () => [],
    listWorkingSets: async () => [],
    listWorkingEvents: async () => [],
    createWorkingSet: async () => ({ kind: "active_set_exists", scopeKey: "test" }),
    updateWorkingSet: async () => ({ kind: "not_found" }),
    patchWorkingSetUsage: async () => ({ kind: "not_found" }),
    patchWorkingSetUsageAndUpdate: async () => ({ kind: "not_found" }),
    recordEpisodePromotion: async (input) => {
      options.onRecordEpisodePromotion?.();
      if (!options.workingSet || options.workingSet.id !== input.workingSetId) {
        return { kind: "not_found" };
      }

      return {
        workingSet: {
          ...options.workingSet,
          snapshot: input.snapshot,
          episodeId: input.episodeId,
          updatedAt: input.now,
        },
      };
    },
  };
}
