import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSurgeonRun } from "../../../../src/adapters/db/surgeon-run-log.js";
import { serializeTags } from "../../../../src/adapters/db/row-mapping.js";
import { initSchema } from "../../../../src/adapters/db/schema.js";
import { createCompletePassTool } from "../../../../src/adapters/surgeon/tools/complete.js";
import { createHealthStatsTool } from "../../../../src/adapters/surgeon/tools/health.js";
import { createInspectEntryTool } from "../../../../src/adapters/surgeon/tools/inspect.js";
import { createSurgeonTools, type SurgeonToolCompletionState, type SurgeonToolDeps } from "../../../../src/adapters/surgeon/tools/index.js";
import { createRetireEntryTool } from "../../../../src/adapters/surgeon/tools/mutate.js";
import { createQueryCandidatesTool } from "../../../../src/adapters/surgeon/tools/query.js";
import { createSimulateRecallTool } from "../../../../src/adapters/surgeon/tools/recall-sim.js";
import { createUpdateEntryTool } from "../../../../src/adapters/surgeon/tools/update-entry.js";
import { createSurgeonCompletionGuardState } from "../../../../src/app/surgeon/completion-guard.js";
import type { RecallPorts } from "../../../../src/core/ports.js";
import type { Entry } from "../../../../src/core/types.js";

const TEST_NOW = new Date("2026-03-29T12:00:00.000Z");

describe("surgeon tools", () => {
  const clients: Client[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });

  it("creates the full seven-tool factory set", async () => {
    const client = await createTestClient(clients);
    const deps = createToolDeps(client);

    expect(createSurgeonTools(deps).map((tool) => tool.name)).toEqual([
      "get_health_stats",
      "query_candidates",
      "inspect_entry",
      "simulate_recall",
      "retire_entry",
      "update_entry",
      "complete_pass",
    ]);
  });

  it("returns health stats and the latest run as a valid tool result", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "health-entry",
      subject: "Health entry",
      type: "todo",
      expiry: "temporary",
      importance: 3,
      created_at: daysAgoIso(20),
      updated_at: daysAgoIso(10),
    });
    await createSurgeonRun(client, {
      passType: "retirement",
      dryRun: true,
      startedAt: "2026-03-29T10:00:00.000Z",
    });
    const tool = createHealthStatsTool(createToolDeps(client));

    const result = await tool.execute("tool-health", {});

    expect(result.content).toEqual([
      expect.objectContaining({
        type: "text",
      }),
    ]);
    expect(result.details).toMatchObject({
      now: TEST_NOW.toISOString(),
      health: {
        total: 1,
      },
      lastRun: {
        passType: "retirement",
      },
    });
  });

  it("tracks pagination progress when querying retirement candidates", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "candidate-1",
      subject: "Session handoff",
      type: "todo",
      expiry: "temporary",
      importance: 2,
      created_at: daysAgoIso(40),
      updated_at: daysAgoIso(15),
    });
    const completionGuards = createSurgeonCompletionGuardState({
      totalEntries: 1,
      retirementCandidates: 1,
    });
    const tool = createQueryCandidatesTool(createToolDeps(client, { completionGuards }));

    const result = await tool.execute("tool-query", {
      limit: 1,
      offset: 0,
    });

    expect(result.details).toMatchObject({
      count: 1,
      scope: "actionable",
    });
    expect(completionGuards.retirement.snapshot()).toEqual({
      queryCalls: 1,
      maxWindowEnd: 1,
      totalCount: null,
      sawExhaustedPage: false,
    });
  });

  it("inspects one entry with related context", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "target",
      subject: "Shared subject",
      cluster_id: "cluster-1",
      tags: ["alpha"],
      created_at: daysAgoIso(100),
      updated_at: daysAgoIso(5),
    });
    await insertEntry(client, {
      id: "same-subject",
      subject: "shared subject",
      cluster_id: "cluster-2",
      created_at: daysAgoIso(90),
      updated_at: daysAgoIso(4),
    });
    await insertEntry(client, {
      id: "same-cluster",
      subject: "Cluster peer",
      cluster_id: "cluster-1",
      created_at: daysAgoIso(80),
      updated_at: daysAgoIso(3),
    });
    const tool = createInspectEntryTool(createToolDeps(client));

    const result = await tool.execute("tool-inspect", {
      entry_id: "target",
    });

    expect(result.details).toMatchObject({
      found: true,
      entry: {
        id: "target",
      },
      related: {
        sameSubject: [{ id: "same-subject" }],
        sameCluster: [{ id: "same-cluster" }],
      },
    });
  });

  it("blocks retirement for protected core, high-importance, and recently recalled entries", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "core-entry",
      subject: "Core entry",
      expiry: "core",
      importance: 2,
    });
    await insertEntry(client, {
      id: "important-entry",
      subject: "Important entry",
      expiry: "permanent",
      importance: 9,
    });
    await insertEntry(client, {
      id: "recent-entry",
      subject: "Recent entry",
      expiry: "temporary",
      importance: 3,
      last_recalled_at: daysAgoIso(3),
    });
    const tool = createRetireEntryTool(createToolDeps(client, { apply: true }));

    const coreResult = await tool.execute("tool-retire-1", {
      entry_id: "core-entry",
      reason: "cleanup",
    });
    const importantResult = await tool.execute("tool-retire-2", {
      entry_id: "important-entry",
      reason: "cleanup",
    });
    const recentResult = await tool.execute("tool-retire-3", {
      entry_id: "recent-entry",
      reason: "cleanup",
    });

    expect(coreResult.details).toMatchObject({
      success: false,
      protected: true,
      reason: "Entry expiry is core.",
    });
    expect(importantResult.details).toMatchObject({
      success: false,
      protected: true,
      reason: "Entry importance is at or above 9.",
    });
    expect(recentResult.details).toMatchObject({
      success: false,
      protected: true,
      reason: "Entry was recalled within the last 14 days.",
    });
  });

  it("supports retire_entry dry-run and apply behavior", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "dry-run-entry",
      subject: "Dry run candidate",
      expiry: "temporary",
      importance: 2,
      created_at: daysAgoIso(80),
      updated_at: daysAgoIso(50),
    });
    const dryRunTool = createRetireEntryTool(createToolDeps(client, { apply: false }));
    const applyTool = createRetireEntryTool(createToolDeps(client, { apply: true }));

    const dryRunResult = await dryRunTool.execute("tool-retire-dry", {
      entry_id: "dry-run-entry",
      reason: "obsolete",
    });

    expect(dryRunResult.details).toMatchObject({
      success: true,
      dryRun: true,
      wouldRetire: true,
    });

    const applyResult = await applyTool.execute("tool-retire-apply", {
      entry_id: "dry-run-entry",
      reason: "obsolete",
    });

    expect(applyResult.details).toMatchObject({
      success: true,
      dryRun: false,
      retired: true,
      retiredCount: 1,
    });
  });

  it("simulates recall without writing telemetry and excludes the target entry", async () => {
    const excludedEntry = createEntry({
      id: "entry-a",
      subject: "Session handoff",
      content: "Session handoff details",
      importance: 5,
    });
    const keptEntry = createEntry({
      id: "entry-b",
      subject: "Current status",
      content: "Current status details",
      importance: 5,
    });
    const recordRecallEvents = vi.fn<RecallPorts["recordRecallEvents"]>().mockResolvedValue(undefined);
    const recallPorts: RecallPorts = {
      async embed() {
        return [];
      },
      async vectorSearch() {
        return [];
      },
      async ftsSearch() {
        return [
          {
            entry: {
              id: excludedEntry.id,
              subject: excludedEntry.subject,
              content: excludedEntry.content,
              importance: excludedEntry.importance,
              expiry: excludedEntry.expiry,
              created_at: excludedEntry.created_at,
              embedding: [],
            },
            rank: 0,
            tier: "exact",
          },
          {
            entry: {
              id: keptEntry.id,
              subject: keptEntry.subject,
              content: keptEntry.content,
              importance: keptEntry.importance,
              expiry: keptEntry.expiry,
              created_at: keptEntry.created_at,
              embedding: [],
            },
            rank: 1,
            tier: "all_tokens",
          },
        ];
      },
      async hydrateEntries(ids) {
        return [excludedEntry, keptEntry].filter((entry) => ids.includes(entry.id));
      },
      recordRecallEvents,
    };
    const tool = createSimulateRecallTool(createToolDeps(await createTestClient(clients), { recallPorts }));

    const result = await tool.execute("tool-recall", {
      query: "status details",
      exclude_entry_id: "entry-a",
      limit: 5,
    });

    expect(result.details).toMatchObject({
      count: 1,
      excludeEntryId: "entry-a",
    });
    expect(result.details.results.map((item) => item.entry.id)).toEqual(["entry-b"]);
    expect(recordRecallEvents).not.toHaveBeenCalled();
  });

  it("rejects update_entry core promotion when reasoning does not mention core", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "update-target",
      subject: "Update target",
      expiry: "permanent",
      importance: 5,
    });
    const tool = createUpdateEntryTool(createToolDeps(client, { apply: true }));

    const result = await tool.execute("tool-update-core", {
      entry_id: "update-target",
      expiry: "core",
      reasoning: "This should always show up at startup.",
    });

    expect(result.details).toMatchObject({
      success: false,
      reason: "Changing expiry to core requires reasoning that explicitly mentions core.",
    });
  });

  it("rejects update_entry when reasoning is blank", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "update-reasoning",
      subject: "Update reasoning",
    });
    const tool = createUpdateEntryTool(createToolDeps(client, { apply: false }));

    const result = await tool.execute("tool-update-reasoning", {
      entry_id: "update-reasoning",
      importance: 4,
      reasoning: "   ",
    });

    expect(result.details).toMatchObject({
      success: false,
      reason: "Reasoning is required.",
    });
  });

  it("rejects premature complete_pass attempts while candidates remain unpaged", async () => {
    const client = await createTestClient(clients);
    const recordRunAction = vi.fn<SurgeonToolDeps["recordRunAction"]>().mockResolvedValue(undefined);
    const completionGuards = createSurgeonCompletionGuardState({
      totalEntries: 100,
      retirementCandidates: 12,
    });
    const completionState = createCompletionState();
    const tool = createCompletePassTool(
      createToolDeps(client, {
        recordRunAction,
        completionGuards,
        completionState,
        budgetTracker: createBudgetTrackerStub({
          costUsd: 0.2,
          remainingCostUsd: 0.8,
          costCapUsd: 1,
          currentContextTokens: 800,
          contextLimit: 8_000,
        }),
        costCap: 1,
      }),
    );

    const result = await tool.execute("tool-complete-reject", {
      actions_taken: 1,
      entries_skipped: [{ entry_id: "entry-skip", reason: "uncertain" }],
      observations: ["Need more review."],
      recommendations: ["Keep paging."],
    });

    expect(result.details).toMatchObject({
      completed: false,
      rejected: true,
      rejectionCount: 1,
      pagedCandidates: 0,
      knownCandidates: 12,
    });
    expect(completionState.isComplete).toBe(false);
    expect(completionGuards.rejectionCounts.get("retirement")).toBe(1);
    expect(recordRunAction).toHaveBeenCalledTimes(1);
    expect(recordRunAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "skip",
        entryIds: ["entry-skip"],
        reasoning: "uncertain",
      }),
    );
  });

  it("accepts complete_pass after five prior rejections via the safety valve", async () => {
    const client = await createTestClient(clients);
    const completionGuards = createSurgeonCompletionGuardState({
      totalEntries: 100,
      retirementCandidates: 20,
    });
    completionGuards.rejectionCounts.set("retirement", 5);
    const completionState = createCompletionState();
    const tool = createCompletePassTool(
      createToolDeps(client, {
        completionGuards,
        completionState,
        budgetTracker: createBudgetTrackerStub({
          costUsd: 0.1,
          remainingCostUsd: 0.9,
          costCapUsd: 1,
          currentContextTokens: 500,
          contextLimit: 8_000,
        }),
        costCap: 1,
      }),
    );

    const result = await tool.execute("tool-complete-accept", {
      actions_taken: 3,
      entries_skipped: [],
      observations: ["Sweep complete enough."],
      recommendations: ["Run again later."],
    });

    expect(result.details).toMatchObject({
      completed: true,
      safetyValveUsed: true,
    });
    expect(completionState.isComplete).toBe(true);
    expect(completionState.summary).toEqual({
      actions_taken: 3,
      entries_skipped: [],
      observations: ["Sweep complete enough."],
      recommendations: ["Run again later."],
    });
  });
});

async function createTestClient(clients: Client[]): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  await initSchema(client);
  return client;
}

function createToolDeps(client: Client, overrides: Partial<SurgeonToolDeps> = {}): SurgeonToolDeps {
  return {
    executor: client,
    runId: overrides.runId ?? "run-1",
    project: overrides.project,
    apply: overrides.apply ?? false,
    protection: overrides.protection ?? {
      protectRecalledDays: 14,
      protectMinImportance: 9,
    },
    skipRecentlyEvaluatedDays: overrides.skipRecentlyEvaluatedDays ?? 7,
    now: overrides.now ?? (() => TEST_NOW),
    recordRunAction: overrides.recordRunAction ?? vi.fn<SurgeonToolDeps["recordRunAction"]>().mockResolvedValue(undefined),
    completionState: overrides.completionState ?? createCompletionState(),
    budgetTracker: overrides.budgetTracker,
    costCap: overrides.costCap,
    completionGuards: overrides.completionGuards,
    recallPorts: overrides.recallPorts,
  };
}

function createCompletionState(): SurgeonToolCompletionState {
  return {
    isComplete: false,
    summary: null,
    setComplete(summary) {
      this.isComplete = true;
      this.summary = summary;
    },
  };
}

function createBudgetTrackerStub(input: { costUsd: number; remainingCostUsd: number; costCapUsd: number; currentContextTokens: number; contextLimit: number }) {
  return {
    addUsage() {
      return;
    },
    isExhausted() {
      return false;
    },
    isCostCapExceeded() {
      return false;
    },
    remaining() {
      return {
        currentContextTokens: input.currentContextTokens,
        contextLimit: input.contextLimit,
        remainingContextTokens: Math.max(0, input.contextLimit - input.currentContextTokens),
        costCapUsd: input.costCapUsd,
        remainingCostUsd: input.remainingCostUsd,
      };
    },
    totals() {
      return {
        inputTokens: input.currentContextTokens,
        outputTokens: 0,
        costUsd: input.costUsd,
        lastInputTokens: input.currentContextTokens,
      };
    },
  };
}

async function insertEntry(client: Client, overrides: Partial<Entry> & Pick<Entry, "id" | "subject">): Promise<void> {
  const entry = createEntry(overrides);
  await client.execute({
    sql: `
      INSERT INTO entries (
        id,
        type,
        subject,
        content,
        importance,
        expiry,
        tags,
        source_file,
        source_context,
        embedding,
        content_hash,
        norm_content_hash,
        minhash_sig,
        quality_score,
        recall_count,
        last_recalled_at,
        superseded_by,
        cluster_id,
        retired,
        retired_at,
        retired_reason,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      entry.id,
      entry.type,
      entry.subject,
      entry.content,
      entry.importance,
      entry.expiry,
      serializeTags(entry.tags),
      entry.source_file ?? null,
      entry.source_context ?? null,
      null,
      entry.content_hash ?? null,
      entry.norm_content_hash ?? null,
      null,
      entry.quality_score,
      entry.recall_count,
      entry.last_recalled_at ?? null,
      entry.superseded_by ?? null,
      entry.cluster_id ?? null,
      entry.retired ? 1 : 0,
      entry.retired_at ?? null,
      entry.retired_reason ?? null,
      entry.created_at,
      entry.updated_at,
    ],
  });
}

function createEntry(overrides: Partial<Entry> & Pick<Entry, "id" | "subject">): Entry {
  return {
    id: overrides.id,
    type: overrides.type ?? "fact",
    subject: overrides.subject,
    content: overrides.content ?? `content for ${overrides.id}`,
    importance: overrides.importance ?? 3,
    expiry: overrides.expiry ?? "permanent",
    tags: overrides.tags ?? [],
    source_file: overrides.source_file,
    source_context: overrides.source_context,
    embedding: overrides.embedding,
    content_hash: overrides.content_hash ?? `${overrides.id}-hash`,
    norm_content_hash: overrides.norm_content_hash,
    quality_score: overrides.quality_score ?? 0.5,
    recall_count: overrides.recall_count ?? 0,
    last_recalled_at: overrides.last_recalled_at,
    superseded_by: overrides.superseded_by,
    cluster_id: overrides.cluster_id,
    retired: overrides.retired ?? false,
    retired_at: overrides.retired_at,
    retired_reason: overrides.retired_reason,
    created_at: overrides.created_at ?? daysAgoIso(30),
    updated_at: overrides.updated_at ?? overrides.created_at ?? daysAgoIso(30),
  };
}

function daysAgoIso(days: number): string {
  return new Date(TEST_NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}
