import { describe, expect, it } from "vitest";

import type { WorkingMemoryRepository } from "../../../src/app/working-memory/repository.js";
import type { WorkingSetRecord } from "../../../src/app/working-memory/records.js";
import { runWorkingSetRetention } from "../../../src/app/working-memory/retention.js";
import { createTestWorkingSet } from "./service-test-helpers.js";

const NOW = () => new Date("2026-06-11T12:00:00.000Z");

/** Builds an in-memory repository over a mutable working-set store. */
function createRetentionRepository(workingSets: WorkingSetRecord[]): { repository: WorkingMemoryRepository; store: Map<string, WorkingSetRecord> } {
  const store = new Map(workingSets.map((workingSet) => [workingSet.id, workingSet]));
  return {
    store,
    repository: {
      getWorkingSet: async (id) => store.get(id) ?? null,
      findCurrentWorkingSets: async () => [],
      listWorkingSets: async () => [],
      listWorkingEvents: async () => [],
      createWorkingSet: async () => ({ kind: "active_set_exists", scopeKey: "test" }),
      updateWorkingSet: async () => ({ kind: "not_found" }),
      patchWorkingSetUsage: async () => ({ kind: "not_found" }),
      patchWorkingSetUsageAndUpdate: async () => ({ kind: "not_found" }),
      recordEpisodePromotion: async () => ({ kind: "not_found" }),
      recordCandidateConsolidation: async () => ({ kind: "not_found" }),
      listReapableWorkingSets: async (input) =>
        [...store.values()]
          .filter(
            (workingSet) =>
              (workingSet.status === "closed" || workingSet.status === "abandoned") && (workingSet.closedAt ?? workingSet.updatedAt) < input.closedBefore,
          )
          .sort((left, right) => (left.closedAt ?? left.updatedAt).localeCompare(right.closedAt ?? right.updatedAt)),
      deleteWorkingSets: async (ids) => {
        let workingSetsDeleted = 0;
        for (const id of ids) {
          if (store.delete(id)) {
            workingSetsDeleted += 1;
          }
        }
        return { workingSetsDeleted, workingEventsDeleted: workingSetsDeleted * 2 };
      },
    },
  };
}

/** Builds one terminal working set closed at the given timestamp. */
function closedWorkingSet(id: string, closedAt: string, overrides: Partial<WorkingSetRecord> = {}): WorkingSetRecord {
  return createTestWorkingSet({
    id,
    scopeKind: "session",
    scopeKey: `session:${id}`,
    status: "closed",
    closedAt,
    ...overrides,
  });
}

describe("runWorkingSetRetention", () => {
  it("reaps terminal sets older than the retention window and keeps newer ones", async () => {
    // 30-day window from NOW puts the cutoff at 2026-05-12T12:00:00.000Z.
    const oldClosed = closedWorkingSet("ws-old", "2026-05-01T00:00:00.000Z");
    const oldAbandoned = closedWorkingSet("ws-abandoned", "2026-04-15T00:00:00.000Z", { status: "abandoned" });
    const recentClosed = closedWorkingSet("ws-recent", "2026-06-01T00:00:00.000Z");
    const { repository, store } = createRetentionRepository([oldClosed, oldAbandoned, recentClosed]);

    const result = await runWorkingSetRetention({ workingMemory: repository }, { now: NOW, retentionDays: 30, apply: true });

    expect(result.cutoff).toBe("2026-05-12T12:00:00.000Z");
    expect(result.terminalSetsScanned).toBe(2);
    expect(result.setsReaped).toBe(2);
    expect(result.eventsReaped).toBe(4);
    expect(result.setsSkippedPendingCandidates).toBe(0);
    expect(result.dryRun).toBe(false);
    expect(store.has("ws-old")).toBe(false);
    expect(store.has("ws-abandoned")).toBe(false);
    expect(store.has("ws-recent")).toBe(true);
  });

  it("keeps a set closed exactly at the cutoff boundary", async () => {
    const atCutoff = closedWorkingSet("ws-boundary", "2026-05-12T12:00:00.000Z");
    const { repository, store } = createRetentionRepository([atCutoff]);

    const result = await runWorkingSetRetention({ workingMemory: repository }, { now: NOW, retentionDays: 30, apply: true });

    expect(result.terminalSetsScanned).toBe(0);
    expect(result.setsReaped).toBe(0);
    expect(store.has("ws-boundary")).toBe(true);
  });

  it("never deletes a set whose candidates are still pending promotion", async () => {
    const pendingSet = closedWorkingSet("ws-pending", "2026-04-01T00:00:00.000Z", {
      snapshot: {
        candidates: [
          {
            kind: "semantic",
            subject: "Release cadence",
            content: "Releases ship monthly.",
            provenance: { evidenceEventSequences: [2] },
            promotionStatus: "pending",
          },
        ],
      },
    });
    const settledSet = closedWorkingSet("ws-settled", "2026-04-01T00:00:00.000Z", {
      snapshot: {
        candidates: [
          {
            kind: "episodic",
            summary: "Shipped the release.",
            provenance: { evidenceEventSequences: [1] },
            promotionStatus: "promoted",
          },
        ],
      },
    });
    const { repository, store } = createRetentionRepository([pendingSet, settledSet]);

    const result = await runWorkingSetRetention({ workingMemory: repository }, { now: NOW, retentionDays: 30, apply: true });

    expect(result.setsReaped).toBe(1);
    expect(result.setsSkippedPendingCandidates).toBe(1);
    expect(result.decisions).toEqual([
      { workingSetId: "ws-pending", status: "closed", closedAt: "2026-04-01T00:00:00.000Z", outcome: "skipped_pending_candidates" },
      { workingSetId: "ws-settled", status: "closed", closedAt: "2026-04-01T00:00:00.000Z", outcome: "reaped" },
    ]);
    expect(store.has("ws-pending")).toBe(true);
    expect(store.has("ws-settled")).toBe(false);
  });

  it("reports deletable sets without deleting on dry runs", async () => {
    const oldClosed = closedWorkingSet("ws-old", "2026-05-01T00:00:00.000Z");
    const { repository, store } = createRetentionRepository([oldClosed]);

    const result = await runWorkingSetRetention({ workingMemory: repository }, { now: NOW, retentionDays: 30, apply: false });

    expect(result.dryRun).toBe(true);
    expect(result.setsReaped).toBe(1);
    expect(result.eventsReaped).toBe(0);
    expect(store.has("ws-old")).toBe(true);
  });

  it("is idempotent across repeated apply passes", async () => {
    const oldClosed = closedWorkingSet("ws-old", "2026-05-01T00:00:00.000Z");
    const { repository } = createRetentionRepository([oldClosed]);

    const first = await runWorkingSetRetention({ workingMemory: repository }, { now: NOW, retentionDays: 30, apply: true });
    const second = await runWorkingSetRetention({ workingMemory: repository }, { now: NOW, retentionDays: 30, apply: true });

    expect(first.setsReaped).toBe(1);
    expect(second.terminalSetsScanned).toBe(0);
    expect(second.setsReaped).toBe(0);
    expect(second.eventsReaped).toBe(0);
  });

  it("falls back to updatedAt for terminal sets without closedAt", async () => {
    const legacyTerminal = createTestWorkingSet({
      id: "ws-legacy",
      scopeKind: "session",
      scopeKey: "session:ws-legacy",
      status: "abandoned",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    const { repository, store } = createRetentionRepository([legacyTerminal]);

    const result = await runWorkingSetRetention({ workingMemory: repository }, { now: NOW, retentionDays: 30, apply: true });

    expect(result.setsReaped).toBe(1);
    expect(result.decisions[0]?.closedAt).toBe("2026-03-01T00:00:00.000Z");
    expect(store.has("ws-legacy")).toBe(false);
  });

  it("rejects a negative retention window", async () => {
    const { repository } = createRetentionRepository([]);

    await expect(runWorkingSetRetention({ workingMemory: repository }, { now: NOW, retentionDays: -1, apply: true })).rejects.toThrow(
      /non-negative retentionDays/u,
    );
  });
});
