import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import { createDreamPort } from "../../../src/adapters/db/dreaming-port.js";
import { runDream } from "../../../src/app/dreaming/service.js";
import type { WorkingMemoryRepository } from "../../../src/app/working-memory/repository.js";
import type { WorkingSetRecord } from "../../../src/app/working-memory/records.js";
import { createTestClient } from "../../helpers/dreaming-reconcile.js";

describe("runDream reap stage", () => {
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    clients.length = 0;
  });

  it("reaps aged terminal working sets on standard apply runs and logs reap actions", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);
    const reapable = buildTerminalWorkingSet("ws-old", "2026-04-01T00:00:00.000Z");
    const pending = buildTerminalWorkingSet("ws-pending", "2026-04-01T00:00:00.000Z", {
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
    const workingMemory = createReapWorkingMemoryDouble([reapable, pending]);

    const result = await runDream(
      { tier: "standard", apply: true, verbose: false, json: false, skipBackup: true },
      {
        port,
        workingMemory: workingMemory.repository,
        config: null,
        now: () => new Date("2026-06-11T12:00:00.000Z"),
      },
    );

    expect(result.status).toBe("completed");
    expect(result.completionSummary?.reap).toEqual({
      terminalSetsScanned: 2,
      setsReaped: 1,
      eventsReaped: 2,
      setsSkippedPendingCandidates: 1,
      setsSkippedOpenProcedureProposals: 0,
      retentionDays: 30,
      dryRun: false,
    });
    expect(workingMemory.deletedIds).toEqual(["ws-old"]);
    expect(result.actionsTaken).toBe(1);
    expect(result.completionSummary?.observations).toContainEqual(expect.stringContaining("pending promotion"));

    const actions = await port.getRunActions(result.runId);
    const reapActions = actions.filter((action) => action.actionType === "reap_working_set");
    expect(reapActions).toHaveLength(1);
    expect(reapActions[0]?.details).toMatchObject({
      stage: "reap",
      working_set_id: "ws-old",
      working_set_status: "closed",
    });
  });

  it("preserves terminal working sets referenced by open procedure proposals", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);
    const reapable = buildTerminalWorkingSet("ws-old", "2026-04-01T00:00:00.000Z");
    const proposalBlocked = buildTerminalWorkingSet("ws-proposal", "2026-04-01T00:00:00.000Z", {
      snapshot: {
        candidates: [
          {
            kind: "procedural",
            subject: "Release procedure",
            content: "Run release validation and publish packages.",
            provenance: { evidenceEventSequences: [3, 4] },
            promotionStatus: "promoted",
          },
        ],
      },
    });
    const workingMemory = createReapWorkingMemoryDouble([reapable, proposalBlocked]);

    const result = await runDream(
      { tier: "standard", apply: true, verbose: false, json: false, skipBackup: true },
      {
        port,
        workingMemory: workingMemory.repository,
        procedureProposals: {
          listOpenProposalWorkingSetIds: async (workingSetIds) => new Set(workingSetIds.filter((id) => id === "ws-proposal")),
          getProposal: async () => null,
          listProposals: async () => [],
          findProposalByFingerprint: async () => null,
          createProposal: async () => {
            throw new Error("not used");
          },
          claimApply: async () => ({ kind: "not_found" }),
          completeApply: async () => ({ kind: "not_found" }),
          releaseApply: async () => undefined,
          reviewProposal: async () => ({ kind: "not_found" }),
        },
        config: null,
        now: () => new Date("2026-06-11T12:00:00.000Z"),
      },
    );

    expect(result.completionSummary?.reap).toMatchObject({
      terminalSetsScanned: 2,
      setsReaped: 1,
      setsSkippedPendingCandidates: 0,
      setsSkippedOpenProcedureProposals: 1,
    });
    expect(workingMemory.deletedIds).toEqual(["ws-old"]);
    expect(result.actionsSkipped).toBe(1);
    expect(result.completionSummary?.observations).toContainEqual(expect.stringContaining("open procedure proposals"));
  });

  it("reports reapable sets without deleting on dry runs", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);
    const workingMemory = createReapWorkingMemoryDouble([buildTerminalWorkingSet("ws-old", "2026-04-01T00:00:00.000Z")]);

    const result = await runDream(
      { tier: "standard", apply: false, verbose: false, json: false },
      {
        port,
        workingMemory: workingMemory.repository,
        config: null,
        now: () => new Date("2026-06-11T12:00:00.000Z"),
      },
    );

    expect(result.completionSummary?.reap).toMatchObject({ setsReaped: 1, eventsReaped: 0, dryRun: true });
    expect(workingMemory.deletedIds).toEqual([]);
    const actions = await port.getRunActions(result.runId);
    expect(actions.filter((action) => action.actionType === "reap_working_set")).toHaveLength(0);
  });

  it("honors the configured retention window", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);
    // Closed 10 days before the run, inside the default 30-day window but
    // outside a configured 7-day window.
    const workingMemory = createReapWorkingMemoryDouble([buildTerminalWorkingSet("ws-old", "2026-06-01T12:00:00.000Z")]);

    const result = await runDream(
      { tier: "standard", apply: true, verbose: false, json: false, skipBackup: true },
      {
        port,
        workingMemory: workingMemory.repository,
        config: { dreaming: { stages: { reap: { workingSetRetentionDays: 7 } } } },
        now: () => new Date("2026-06-11T12:00:00.000Z"),
      },
    );

    expect(result.completionSummary?.reap).toMatchObject({ retentionDays: 7, setsReaped: 1 });
    expect(workingMemory.deletedIds).toEqual(["ws-old"]);
  });

  it("records a skipped reap stage when no working-memory repository is wired", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    const result = await runDream(
      { tier: "standard", apply: false, verbose: false, json: false },
      {
        port,
        config: null,
        now: () => new Date("2026-06-11T12:00:00.000Z"),
      },
    );

    expect(result.completionSummary?.stages_skipped).toContainEqual({ stage: "reap", reason: "working_memory_unavailable" });
    expect(result.completionSummary?.reap).toBeUndefined();
  });
});

/** Builds one terminal working set closed at the given timestamp. */
function buildTerminalWorkingSet(id: string, closedAt: string, overrides: Partial<WorkingSetRecord> = {}): WorkingSetRecord {
  return {
    id,
    scopeKey: `session:${id}`,
    scopeKind: "session",
    status: "closed",
    snapshot: {},
    revision: 2,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: closedAt,
    lastActiveAt: closedAt,
    closedAt,
    ...overrides,
  };
}

/** Builds a working-memory double that serves and deletes terminal sets. */
function createReapWorkingMemoryDouble(workingSets: WorkingSetRecord[]): { repository: WorkingMemoryRepository; deletedIds: string[] } {
  const store = new Map(workingSets.map((workingSet) => [workingSet.id, workingSet]));
  const deletedIds: string[] = [];
  return {
    deletedIds,
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
      listReapableWorkingSets: async (input) => [...store.values()].filter((workingSet) => (workingSet.closedAt ?? workingSet.updatedAt) < input.closedBefore),
      deleteWorkingSets: async (ids) => {
        let workingSetsDeleted = 0;
        for (const id of ids) {
          if (store.delete(id)) {
            deletedIds.push(id);
            workingSetsDeleted += 1;
          }
        }
        return { workingSetsDeleted, workingEventsDeleted: workingSetsDeleted * 2 };
      },
    },
  };
}
