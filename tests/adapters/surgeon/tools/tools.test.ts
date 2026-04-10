import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSurgeonPort } from "../../../../src/adapters/db/surgeon-port.js";
import { createSurgeonRun } from "../../../../src/adapters/db/surgeon-run-log.js";
import { serializeTags } from "../../../../src/adapters/db/row-mapping.js";
import { finalizeBulkWrites, initSchema, prepareBulkWrites } from "../../../../src/adapters/db/schema.js";
import { createCompletePassTool } from "../../../../src/adapters/surgeon/tools/complete.js";
import { createHealthStatsTool } from "../../../../src/adapters/surgeon/tools/health.js";
import { createInspectEntryTool } from "../../../../src/adapters/surgeon/tools/inspect.js";
import {
  createSupersessionTools,
  createSurgeonTools,
  type SurgeonToolCompletionState,
  type SurgeonToolDeps,
} from "../../../../src/adapters/surgeon/tools/index.js";
import { createRetireEntryTool } from "../../../../src/adapters/surgeon/tools/mutate.js";
import { createQueryCandidatesTool } from "../../../../src/adapters/surgeon/tools/query.js";
import { createSimulateRecallTool } from "../../../../src/adapters/surgeon/tools/recall-sim.js";
import { createAssignClaimKeyTool } from "../../../../src/adapters/surgeon/tools/supersession-claim.js";
import { createLinkSupersessionTool } from "../../../../src/adapters/surgeon/tools/supersession-link.js";
import { createQuerySupersessionCandidatesTool } from "../../../../src/adapters/surgeon/tools/supersession-query.js";
import { createSetValidityTool } from "../../../../src/adapters/surgeon/tools/supersession-validity.js";
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

  it("creates the supersession tool factory set", async () => {
    const client = await createTestClient(clients);
    const deps = createToolDeps(client, {
      passType: "supersession",
    });

    expect(createSupersessionTools(deps).map((tool) => tool.name)).toEqual([
      "get_health_stats",
      "query_supersession_candidates",
      "inspect_entry",
      "simulate_recall",
      "link_supersession",
      "assign_claim_key",
      "set_validity",
      "update_entry",
      "complete_pass",
    ]);
  });

  it("returns health stats and the latest run as a valid tool result", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "health-entry",
      subject: "Health entry",
      type: "milestone",
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
    await prepareBulkWrites(client);
    await finalizeBulkWrites(client);
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
        claimKeyLifecycle: {
          trusted: 0,
          tentative: 0,
          unresolved: 0,
          legacy: 0,
          noKey: 1,
        },
        proposalBacklogCount: 0,
      },
      lastRun: {
        passType: "retirement",
      },
    });
    expect(result.details.lastBulkIngestAt).toEqual(expect.any(String));
    expect(Date.parse(String(result.details.lastBulkIngestAt))).not.toBeNaN();
  });

  it("tracks pagination progress when querying retirement candidates", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "candidate-1",
      subject: "Session handoff",
      type: "fact",
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

  it("returns clear empty-result guidance for both actionable and all candidate scopes", async () => {
    const client = await createTestClient(clients);
    const tool = createQueryCandidatesTool(createToolDeps(client));

    const actionableResult = await tool.execute("tool-query-actionable-empty", {});
    const allScopeResult = await tool.execute("tool-query-all-empty", {
      scope: "all",
    });

    expect(actionableResult.details).toMatchObject({
      count: 0,
      scope: "actionable",
    });
    expect(actionableResult.details.message).toContain("scope = 'all'");
    expect(allScopeResult.details).toMatchObject({
      count: 0,
      scope: "all",
    });
    expect(allScopeResult.details.message).toContain("candidate pool appears exhausted");
  });

  it("tracks supersession cluster review progress when querying claim_key candidates", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "claim-entry-1",
      subject: "Jim home city",
      claim_key: "jim/home_city",
      created_at: daysAgoIso(40),
    });
    await insertEntry(client, {
      id: "claim-entry-2",
      subject: "Jim home city update",
      claim_key: "jim/home_city",
      created_at: daysAgoIso(20),
    });

    const completionGuards = createSurgeonCompletionGuardState({
      totalEntries: 2,
      supersessionClaimKeyClusters: 1,
      supersessionSubjectClusters: 1,
    });
    const tool = createQuerySupersessionCandidatesTool(
      createToolDeps(client, {
        passType: "supersession",
        completionGuards,
      }),
    );

    const result = await tool.execute("tool-query-supersession", {
      scope: "claim_key",
      limit: 10,
      offset: 0,
    });

    expect(result.details).toMatchObject({
      count: 1,
      scope: "claim_key",
      claimKeyClusterCount: 1,
    });
    expect(completionGuards.supersession.snapshot()).toEqual({
      claimKeyClustersViewed: 1,
      claimKeyClustersTotal: 1,
      claimKeyClustersAdjudicated: 0,
      claimKeyScopeExhausted: true,
      subjectClustersViewed: 0,
      subjectClustersTotal: 0,
      subjectClustersAdjudicated: 0,
      subjectScopeExhausted: true,
      adjudicatedClusters: 0,
      widenedBeforeClaimKeyExhausted: false,
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

  it("returns found=false when inspect_entry targets a missing entry", async () => {
    const client = await createTestClient(clients);
    const tool = createInspectEntryTool(createToolDeps(client));

    const result = await tool.execute("tool-inspect-missing", {
      entry_id: "missing-entry",
    });

    expect(result.details).toEqual({
      found: false,
      entry: null,
      tags: [],
      related: null,
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

  it("returns a clean not-found result when retire_entry targets a missing entry", async () => {
    const client = await createTestClient(clients);
    const tool = createRetireEntryTool(createToolDeps(client, { apply: true }));

    const result = await tool.execute("tool-retire-missing", {
      entry_id: "missing-entry",
      reason: "cleanup",
    });

    expect(result.details).toMatchObject({
      success: false,
      dryRun: false,
      entryId: "missing-entry",
      reason: "Entry not found.",
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
              superseded_by: excludedEntry.superseded_by,
              retired: excludedEntry.retired,
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
              superseded_by: keptEntry.superseded_by,
              retired: keptEntry.retired,
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

  it("rejects simulate_recall when recall ports are unavailable", async () => {
    const client = await createTestClient(clients);
    const tool = createSimulateRecallTool(createToolDeps(client));

    await expect(
      tool.execute("tool-recall-missing-ports", {
        query: "status details",
      }),
    ).rejects.toThrow("Recall simulation is unavailable because no embedding-enabled recall ports are configured.");
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

  it("requires at least one mutable field for update_entry", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "update-no-fields",
      subject: "Update no fields",
    });
    const tool = createUpdateEntryTool(createToolDeps(client, { apply: false }));

    await expect(
      tool.execute("tool-update-no-fields", {
        entry_id: "update-no-fields",
        reasoning: "Reviewed but no mutation specified.",
      }),
    ).rejects.toThrow("update_entry requires at least one mutable field: importance, expiry, claim_key, valid_from, or valid_to.");
  });

  it("returns a dry-run change preview for update_entry", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "update-preview",
      subject: "Update preview",
      importance: 6,
      expiry: "permanent",
    });
    const tool = createUpdateEntryTool(createToolDeps(client, { apply: false }));

    const result = await tool.execute("tool-update-preview", {
      entry_id: "update-preview",
      importance: 4,
      reasoning: "Lower importance reflects that this note is less central now.",
    });

    expect(result.details).toMatchObject({
      success: true,
      dryRun: true,
      wouldUpdate: true,
      changes: {
        importance: {
          from: 6,
          to: 4,
        },
      },
    });
  });

  it("persists the manual lifecycle bundle when update_entry sets a claim key", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "update-claim-key",
      subject: "Update claim key",
    });
    const tool = createUpdateEntryTool(createToolDeps(client, { apply: true }));

    const result = await tool.execute("tool-update-claim-key", {
      entry_id: "update-claim-key",
      claim_key: "jim/home_city",
      reasoning: "This entry clearly describes the home_city slot.",
    });

    expect(result.details).toMatchObject({
      success: true,
      updated: true,
    });
    const row = await client.execute({
      sql: `
        SELECT claim_key, claim_key_status, claim_key_source, claim_key_confidence, claim_key_rationale
        FROM entries
        WHERE id = ?
      `,
      args: ["update-claim-key"],
    });
    expect(row.rows[0]).toMatchObject({
      claim_key: "jim/home_city",
      claim_key_status: "trusted",
      claim_key_source: "manual",
      claim_key_confidence: 1,
      claim_key_rationale: "manual claim key supplied by caller",
    });
  });

  it("rejects update_entry when claim_key is invalid", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "update-claim-key-invalid",
      subject: "Update claim key invalid",
    });
    const tool = createUpdateEntryTool(createToolDeps(client, { apply: false }));

    const result = await tool.execute("tool-update-claim-key-invalid", {
      entry_id: "update-claim-key-invalid",
      claim_key: "invalid",
      reasoning: "Attempting an invalid claim key.",
    });

    expect(result.details).toMatchObject({
      success: false,
      reason:
        "Expiry must be one of: core, permanent, temporary. Claim keys must use entity/attribute format. Validity timestamps must be ISO 8601 and ordered correctly.",
    });
  });

  it("rejects update_entry validity changes that conflict with an existing bound", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "update-existing-validity",
      subject: "Update existing validity",
      valid_from: "2026-03-01T00:00:00.000Z",
      valid_to: "2026-03-31T00:00:00.000Z",
    });
    const tool = createUpdateEntryTool(createToolDeps(client, { apply: false }));

    const result = await tool.execute("tool-update-existing-validity", {
      entry_id: "update-existing-validity",
      valid_from: "2026-04-15T00:00:00.000Z",
      reasoning: "Attempting a conflicting lower bound.",
    });

    expect(result.details).toMatchObject({
      success: false,
      reason: "valid_from must be earlier than valid_to.",
    });
  });

  it("supports link_supersession happy path and logs a conflict-resolution action", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "old-entry",
      subject: "Jim home city",
      claim_key: "jim/home_city",
      created_at: daysAgoIso(50),
    });
    await insertEntry(client, {
      id: "new-entry",
      subject: "Jim home city updated",
      claim_key: "jim/home_city",
      created_at: daysAgoIso(10),
    });
    const recordRunAction = vi.fn<SurgeonToolDeps["recordRunAction"]>().mockResolvedValue(undefined);
    const completionGuards = createSurgeonCompletionGuardState({
      totalEntries: 2,
      supersessionClaimKeyClusters: 1,
      supersessionSubjectClusters: 0,
    });
    completionGuards.supersession.recordPage({
      scope: "claim_key",
      claimKeyTotal: 1,
      subjectTotal: 0,
      clusters: [
        {
          groupKey: "jim/home_city",
          groupedBy: "claim_key",
          entries: [
            {
              id: "old-entry",
              subject: "Jim home city",
              type: "fact",
              importance: 3,
              expiry: "permanent",
              createdAt: daysAgoIso(50),
              content: "content for old-entry",
              claimKey: "jim/home_city",
              tags: [],
            },
            {
              id: "new-entry",
              subject: "Jim home city updated",
              type: "fact",
              importance: 3,
              expiry: "permanent",
              createdAt: daysAgoIso(10),
              content: "content for new-entry",
              claimKey: "jim/home_city",
              tags: [],
            },
          ],
        },
      ],
    });
    const tool = createLinkSupersessionTool(
      createToolDeps(client, {
        passType: "supersession",
        apply: true,
        recordRunAction,
        completionGuards,
      }),
    );

    const result = await tool.execute("tool-link-supersession", {
      old_entry_id: "old-entry",
      new_entry_id: "new-entry",
      kind: "update",
      reason: "The newer entry replaces the old city.",
    });

    expect(result.details).toMatchObject({
      success: true,
      dryRun: false,
      superseded: true,
      kind: "update",
    });

    const row = await client.execute({
      sql: "SELECT superseded_by, supersession_kind, supersession_reason FROM entries WHERE id = ?",
      args: ["old-entry"],
    });
    expect(row.rows[0]).toMatchObject({
      superseded_by: "new-entry",
      supersession_kind: "update",
      supersession_reason: "The newer entry replaces the old city.",
    });

    expect(recordRunAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "resolve_conflict",
        entryIds: ["old-entry", "new-entry"],
      }),
    );
    expect(completionGuards.supersession.snapshot().adjudicatedClusters).toBe(1);
  });

  it("enforces supersession hard rules and dry-run behavior", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "old-fact",
      subject: "Fact entry",
      type: "fact",
      claim_key: "jim/home_city",
    });
    await insertEntry(client, {
      id: "new-lesson",
      subject: "Lesson entry",
      type: "lesson",
      claim_key: "jim/home_city",
    });
    await insertEntry(client, {
      id: "milestone-old",
      subject: "Milestone entry",
      type: "milestone",
      claim_key: "jim/move",
    });
    await insertEntry(client, {
      id: "milestone-new",
      subject: "Milestone replacement",
      type: "milestone",
      claim_key: "jim/move",
    });
    await insertEntry(client, {
      id: "core-old",
      subject: "Core entry",
      expiry: "core",
      claim_key: "jim/name",
    });
    await insertEntry(client, {
      id: "core-new",
      subject: "Core replacement",
      claim_key: "jim/name",
    });
    await insertEntry(client, {
      id: "replacement-entry",
      subject: "Replacement entry",
      claim_key: "jim/timezone",
    });
    await insertEntry(client, {
      id: "already-superseded",
      subject: "Already superseded",
      claim_key: "jim/timezone",
      superseded_by: "replacement-entry",
    });

    const dryRunTool = createLinkSupersessionTool(
      createToolDeps(client, {
        passType: "supersession",
        apply: false,
      }),
    );
    const applyTool = createLinkSupersessionTool(
      createToolDeps(client, {
        passType: "supersession",
        apply: true,
      }),
    );

    await expect(
      applyTool.execute("tool-link-cross-type", {
        old_entry_id: "old-fact",
        new_entry_id: "new-lesson",
        kind: "update",
        reason: "invalid",
      }),
    ).resolves.toMatchObject({
      details: {
        success: false,
        reason: "Supersession requires both entries to have the same type.",
      },
    });

    await expect(
      applyTool.execute("tool-link-milestone", {
        old_entry_id: "milestone-old",
        new_entry_id: "milestone-new",
        kind: "update",
        reason: "invalid",
      }),
    ).resolves.toMatchObject({
      details: {
        success: false,
        reason: "Milestone entries are never superseded automatically.",
      },
    });

    await expect(
      applyTool.execute("tool-link-core", {
        old_entry_id: "core-old",
        new_entry_id: "core-new",
        kind: "update",
        reason: "invalid",
      }),
    ).resolves.toMatchObject({
      details: {
        success: false,
        reason: "Core-expiry entries are never superseded automatically.",
      },
    });

    await expect(
      applyTool.execute("tool-link-self", {
        old_entry_id: "old-fact",
        new_entry_id: "old-fact",
        kind: "update",
        reason: "invalid",
      }),
    ).resolves.toMatchObject({
      details: {
        success: false,
        reason: "An entry cannot supersede itself.",
      },
    });

    await expect(
      applyTool.execute("tool-link-existing", {
        old_entry_id: "already-superseded",
        new_entry_id: "replacement-entry",
        kind: "update",
        reason: "invalid",
      }),
    ).resolves.toMatchObject({
      details: {
        success: false,
        reason: "The old entry is already superseded.",
      },
    });

    const dryRunResult = await dryRunTool.execute("tool-link-dry-run", {
      old_entry_id: "old-fact",
      new_entry_id: "replacement-entry",
      kind: "duplicate",
      reason: "Same fact in different words.",
    });

    expect(dryRunResult.details).toMatchObject({
      success: true,
      dryRun: true,
      wouldSupersede: true,
      kind: "duplicate",
    });
  });

  it("assigns claim keys with the canonical manual lifecycle bundle and validates claim-key format", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "claim-target",
      subject: "Claim target",
    });
    const applyTool = createAssignClaimKeyTool(
      createToolDeps(client, {
        passType: "supersession",
        apply: true,
      }),
    );
    const invalidTool = createAssignClaimKeyTool(
      createToolDeps(client, {
        passType: "supersession",
        apply: false,
      }),
    );

    expect(
      (
        await invalidTool.execute("tool-claim-empty", {
          entry_id: "claim-target",
          claim_key: "noslash",
          reasoning: "invalid",
        })
      ).details,
    ).toMatchObject({
      success: false,
      reason: "Claim key must contain exactly one '/' with non-empty entity and attribute parts.",
    });
    expect(
      (
        await invalidTool.execute("tool-claim-leading", {
          entry_id: "claim-target",
          claim_key: "/leading_slash",
          reasoning: "invalid",
        })
      ).details,
    ).toMatchObject({
      success: false,
      reason: "Claim key must contain exactly one '/' with non-empty entity and attribute parts.",
    });
    expect(
      (
        await invalidTool.execute("tool-claim-trailing", {
          entry_id: "claim-target",
          claim_key: "trailing/",
          reasoning: "invalid",
        })
      ).details,
    ).toMatchObject({
      success: false,
      reason: "Claim key must contain exactly one '/' with non-empty entity and attribute parts.",
    });

    const result = await applyTool.execute("tool-claim-valid", {
      entry_id: "claim-target",
      claim_key: "jim/home_city",
      reasoning: "This entry clearly describes the home_city slot.",
    });

    expect(result.details).toMatchObject({
      success: true,
      updated: true,
    });
    const row = await client.execute({
      sql: `
        SELECT claim_key, claim_key_status, claim_key_source, claim_key_confidence, claim_key_rationale
        FROM entries
        WHERE id = ?
      `,
      args: ["claim-target"],
    });
    expect(row.rows[0]).toMatchObject({
      claim_key: "jim/home_city",
      claim_key_status: "trusted",
      claim_key_source: "manual",
      claim_key_confidence: 1,
      claim_key_rationale: "manual claim key supplied by caller",
    });
  });

  it("sets temporal validity and validates timestamp input", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "validity-target",
      subject: "Validity target",
    });
    const applyTool = createSetValidityTool(
      createToolDeps(client, {
        passType: "supersession",
        apply: true,
      }),
    );
    const invalidTool = createSetValidityTool(
      createToolDeps(client, {
        passType: "supersession",
        apply: false,
      }),
    );

    expect(
      (
        await invalidTool.execute("tool-validity-empty", {
          entry_id: "validity-target",
          reasoning: "invalid",
        })
      ).details,
    ).toMatchObject({
      success: false,
      reason: "At least one of valid_from or valid_to must be provided.",
    });

    expect(
      (
        await invalidTool.execute("tool-validity-order", {
          entry_id: "validity-target",
          valid_from: "2026-04-10T00:00:00.000Z",
          valid_to: "2026-04-01T00:00:00.000Z",
          reasoning: "invalid",
        })
      ).details,
    ).toMatchObject({
      success: false,
      reason: "valid_from must be earlier than valid_to.",
    });

    expect(
      (
        await invalidTool.execute("tool-validity-iso", {
          entry_id: "validity-target",
          valid_from: "not-a-date",
          reasoning: "invalid",
        })
      ).details,
    ).toMatchObject({
      success: false,
      reason: "valid_from must be a valid ISO 8601 timestamp.",
    });

    const result = await applyTool.execute("tool-validity-valid", {
      entry_id: "validity-target",
      valid_from: "2026-03-01T00:00:00.000Z",
      valid_to: "2026-03-31T00:00:00.000Z",
      reasoning: "The source material gives a clear March validity window.",
    });

    expect(result.details).toMatchObject({
      success: true,
      updated: true,
    });
    const row = await client.execute({
      sql: "SELECT valid_from, valid_to FROM entries WHERE id = ?",
      args: ["validity-target"],
    });
    expect(row.rows[0]).toMatchObject({
      valid_from: "2026-03-01T00:00:00.000Z",
      valid_to: "2026-03-31T00:00:00.000Z",
    });
  });

  it("rejects set_validity updates that conflict with an existing bound", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "validity-existing-bound",
      subject: "Validity existing bound",
      valid_from: "2026-03-01T00:00:00.000Z",
      valid_to: "2026-03-31T00:00:00.000Z",
    });
    const tool = createSetValidityTool(
      createToolDeps(client, {
        passType: "supersession",
        apply: false,
      }),
    );

    const result = await tool.execute("tool-validity-existing-bound", {
      entry_id: "validity-existing-bound",
      valid_from: "2026-04-10T00:00:00.000Z",
      reasoning: "This should conflict with the persisted valid_to bound.",
    });

    expect(result.details).toMatchObject({
      success: false,
      reason: "valid_from must be earlier than valid_to.",
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

  it("accepts complete_pass after enough prior rejections via the safety valve", async () => {
    const client = await createTestClient(clients);
    const completionGuards = createSurgeonCompletionGuardState({
      totalEntries: 100,
      retirementCandidates: 20,
    });
    completionGuards.rejectionCounts.set("retirement", 50);
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

  it("records one skip action per skipped entry when complete_pass succeeds", async () => {
    const client = await createTestClient(clients);
    const recordRunAction = vi.fn<SurgeonToolDeps["recordRunAction"]>().mockResolvedValue(undefined);
    const tool = createCompletePassTool(
      createToolDeps(client, {
        recordRunAction,
      }),
    );

    const result = await tool.execute("tool-complete-skips", {
      actions_taken: 0,
      entries_skipped: [{ entry_id: "entry-a", reason: "uncertain" }, { reason: "needs human review" }],
      observations: ["Conservative sweep complete."],
      recommendations: [],
    });

    expect(result.details).toMatchObject({
      completed: true,
    });
    expect(recordRunAction).toHaveBeenCalledTimes(2);
    expect(recordRunAction.mock.calls[0]?.[0]).toMatchObject({
      actionType: "skip",
      entryIds: ["entry-a"],
      reasoning: "uncertain",
    });
    expect(recordRunAction.mock.calls[1]?.[0]).toMatchObject({
      actionType: "skip",
      entryIds: [],
      reasoning: "needs human review",
    });
  });

  it("rejects shallow supersession completion until enough claim_key clusters are reviewed", async () => {
    const client = await createTestClient(clients);
    const completionGuards = createSurgeonCompletionGuardState({
      totalEntries: 50,
      supersessionClaimKeyClusters: 5,
      supersessionSubjectClusters: 0,
    });
    const completionState = createCompletionState();
    const tool = createCompletePassTool(
      createToolDeps(client, {
        passType: "supersession",
        completionGuards,
        completionState,
        budgetTracker: createBudgetTrackerStub({
          costUsd: 0.1,
          remainingCostUsd: 0.9,
          costCapUsd: 1,
          currentContextTokens: 400,
          contextLimit: 8_000,
        }),
        costCap: 1,
      }),
    );

    completionGuards.supersession.recordPage({
      scope: "claim_key",
      claimKeyTotal: 5,
      subjectTotal: 0,
      clusters: [
        {
          groupKey: "slot-1",
          groupedBy: "claim_key",
          entries: [
            {
              id: "slot-1-a",
              subject: "slot 1",
              type: "fact",
              importance: 3,
              expiry: "permanent",
              createdAt: daysAgoIso(20),
              content: "slot 1",
              claimKey: "slot-1",
              tags: [],
            },
            {
              id: "slot-1-b",
              subject: "slot 1 update",
              type: "fact",
              importance: 3,
              expiry: "permanent",
              createdAt: daysAgoIso(10),
              content: "slot 1 update",
              claimKey: "slot-1",
              tags: [],
            },
          ],
        },
      ],
    });
    completionGuards.supersession.markAdjudicated(["slot-1-a"]);

    const rejected = await tool.execute("tool-complete-supersession-reject", {
      actions_taken: 1,
      entries_skipped: [],
      observations: ["Need to keep paging claim_key clusters."],
      recommendations: [],
    });

    expect(rejected.details).toMatchObject({
      completed: false,
      rejected: true,
      claimKeyClustersViewed: 1,
      claimKeyClustersTotal: 5,
    });
    expect(completionState.isComplete).toBe(false);

    completionGuards.supersession.recordPage({
      scope: "claim_key",
      claimKeyTotal: 5,
      subjectTotal: 0,
      clusters: [
        {
          groupKey: "slot-2",
          groupedBy: "claim_key",
          entries: [
            {
              id: "slot-2-a",
              subject: "slot 2",
              type: "fact",
              importance: 3,
              expiry: "permanent",
              createdAt: daysAgoIso(20),
              content: "slot 2",
              claimKey: "slot-2",
              tags: [],
            },
            {
              id: "slot-2-b",
              subject: "slot 2 update",
              type: "fact",
              importance: 3,
              expiry: "permanent",
              createdAt: daysAgoIso(10),
              content: "slot 2 update",
              claimKey: "slot-2",
              tags: [],
            },
          ],
        },
        {
          groupKey: "slot-3",
          groupedBy: "claim_key",
          entries: [
            {
              id: "slot-3-a",
              subject: "slot 3",
              type: "fact",
              importance: 3,
              expiry: "permanent",
              createdAt: daysAgoIso(20),
              content: "slot 3",
              claimKey: "slot-3",
              tags: [],
            },
            {
              id: "slot-3-b",
              subject: "slot 3 update",
              type: "fact",
              importance: 3,
              expiry: "permanent",
              createdAt: daysAgoIso(10),
              content: "slot 3 update",
              claimKey: "slot-3",
              tags: [],
            },
          ],
        },
        {
          groupKey: "slot-4",
          groupedBy: "claim_key",
          entries: [
            {
              id: "slot-4-a",
              subject: "slot 4",
              type: "fact",
              importance: 3,
              expiry: "permanent",
              createdAt: daysAgoIso(20),
              content: "slot 4",
              claimKey: "slot-4",
              tags: [],
            },
            {
              id: "slot-4-b",
              subject: "slot 4 update",
              type: "fact",
              importance: 3,
              expiry: "permanent",
              createdAt: daysAgoIso(10),
              content: "slot 4 update",
              claimKey: "slot-4",
              tags: [],
            },
          ],
        },
        {
          groupKey: "slot-5",
          groupedBy: "claim_key",
          entries: [
            {
              id: "slot-5-a",
              subject: "slot 5",
              type: "fact",
              importance: 3,
              expiry: "permanent",
              createdAt: daysAgoIso(20),
              content: "slot 5",
              claimKey: "slot-5",
              tags: [],
            },
            {
              id: "slot-5-b",
              subject: "slot 5 update",
              type: "fact",
              importance: 3,
              expiry: "permanent",
              createdAt: daysAgoIso(10),
              content: "slot 5 update",
              claimKey: "slot-5",
              tags: [],
            },
          ],
        },
      ],
    });
    completionGuards.supersession.markAdjudicated(["slot-2-a", "slot-3-a", "slot-4-a", "slot-5-a"]);

    const accepted = await tool.execute("tool-complete-supersession-accept", {
      actions_taken: 5,
      entries_skipped: [],
      observations: ["Claim-key sweep complete."],
      recommendations: [],
    });

    expect(accepted.details).toMatchObject({
      completed: true,
    });
    expect(completionState.isComplete).toBe(true);
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
    passType: overrides.passType ?? "retirement",
    port: overrides.port ?? createSurgeonPort(client),
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
        valid_from,
        valid_to,
        claim_key,
        supersession_kind,
        supersession_reason,
        cluster_id,
        retired,
        retired_at,
        retired_reason,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      entry.valid_from ?? null,
      entry.valid_to ?? null,
      entry.claim_key ?? null,
      entry.supersession_kind ?? null,
      entry.supersession_reason ?? null,
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
    valid_from: overrides.valid_from,
    valid_to: overrides.valid_to,
    claim_key: overrides.claim_key,
    supersession_kind: overrides.supersession_kind,
    supersession_reason: overrides.supersession_reason,
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
