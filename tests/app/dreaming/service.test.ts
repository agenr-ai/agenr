import { describe, expect, it, vi } from "vitest";

import type { DreamPort } from "../../../src/app/dreaming/ports.js";
import { runDream } from "../../../src/app/dreaming/service.js";

function createDreamPortDouble(overrides: Partial<DreamPort> = {}): DreamPort {
  const base: DreamPort = {
    getDailyCost: vi.fn(async () => 0),
    createRun: vi.fn(async () => "run-1"),
    completeRun: vi.fn(async () => undefined),
    logRunAction: vi.fn(async () => undefined),
    getLastRun: vi.fn(async () => null),
    getRunHistory: vi.fn(async () => []),
    getRunActions: vi.fn(async () => []),
    getRunProposals: vi.fn(async () => []),
    listProposalBacklog: vi.fn(async () => []),
    getHealthStats: vi.fn(async () => ({
      total: 0,
      byType: {},
      claimKeyLifecycle: { trusted: 0, tentative: 0, unresolved: 0, legacy: 0, noKey: 0 },
      proposalBacklogCount: 0,
      eligibleProposalBacklogCount: 0,
      oldestOpenProposalCreatedAt: null,
      recency: { last7: 0, last30: 0, d30To90: 0, d90Plus: 0 },
      recall: { never: 0, oneToFive: 0, fivePlus: 0 },
      quality: { high: 0, medium: 0, low: 0, average: 0 },
    })),
    listReconcileDurables: vi.fn(async () => []),
    updateDurable: vi.fn(async () => false),
    logRunProposal: vi.fn(async () => undefined),
    countEpisodesSince: vi.fn(async () => 0),
    countIngestFilesSince: vi.fn(async () => 0),
    countDurablesCreatedSince: vi.fn(async () => 0),
    updateDreamState: vi.fn(async () => undefined),
  };

  return { ...base, ...overrides };
}

describe("runDream", () => {
  it("rejects runs when the daily dreaming cost cap is already exhausted", async () => {
    const port = createDreamPortDouble({
      getDailyCost: vi.fn(async () => 2.5),
    });

    await expect(
      runDream(
        {
          tier: "standard",
          apply: false,
          verbose: false,
          json: false,
        },
        {
          port,
          config: { dreaming: { dailyCostCap: 2.5 } },
        },
      ),
    ).rejects.toThrow("Daily dreaming cost cap reached");
  });

  it("records an empty reconcile summary when the working set is empty", async () => {
    const completeRun = vi.fn(async () => undefined);
    const port = createDreamPortDouble({
      completeRun,
      getLastRun: vi.fn(async () => null),
      listReconcileDurables: vi.fn(async () => []),
    });

    const result = await runDream(
      {
        tier: "light",
        apply: false,
        verbose: false,
        json: false,
      },
      {
        port,
        config: null,
        now: () => new Date("2026-06-05T12:00:00.000Z"),
      },
    );

    expect(result.status).toBe("completed");
    expect(result.tier).toBe("light");
    expect(result.actionsTaken).toBe(0);
    expect(completeRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        status: "completed",
        summaryJson: expect.objectContaining({
          durables_skipped: [],
          reconcile: expect.objectContaining({
            before: expect.objectContaining({ totalDurables: 0, activeDurables: 0 }),
          }),
        }),
      }),
    );
  });
});
