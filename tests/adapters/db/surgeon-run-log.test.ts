import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  completeSurgeonRun,
  createSurgeonRun,
  getDailySurgeonCost,
  getLastSurgeonRun,
  getSurgeonRunActions,
  getSurgeonRunProposals,
  getSurgeonRunHistory,
  logSurgeonAction,
  logSurgeonProposal,
} from "../../../src/adapters/db/surgeon-run-log.js";
import { initSchema } from "../../../src/adapters/db/schema.js";

describe("surgeon run log", () => {
  const clients: Client[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });

  it("creates and completes surgeon runs with structured summary data", async () => {
    const client = await createTestClient(clients);

    const runId = await createSurgeonRun(client, {
      passType: "retirement",
      project: "alpha",
      model: "gpt-5.4-mini",
      dryRun: true,
      config: {
        limit: 25,
      },
      startedAt: "2026-03-29T10:00:00.000Z",
    });

    let run = await getLastSurgeonRun(client);
    expect(run).toMatchObject({
      id: runId,
      passType: "retirement",
      project: "alpha",
      startedAt: "2026-03-29T10:00:00.000Z",
      completedAt: null,
      status: "running",
      model: "gpt-5.4-mini",
      dryRun: true,
      config: {
        limit: 25,
      },
      summaryJson: null,
    });

    await completeSurgeonRun(client, runId, {
      status: "completed",
      inputTokens: 1_250,
      outputTokens: 180,
      estimatedCostUsd: 0.12,
      actionsTaken: 3,
      actionsSkipped: 1,
      entriesRetired: 2,
      completedAt: "2026-03-29T10:05:00.000Z",
      summaryJson: {
        actions_taken: 3,
        entries_skipped: [{ entry_id: "entry-3", reason: "protected" }],
        observations: ["Temporary entries dominated the backlog."],
        recommendations: ["Run a broader all-scope pass next."],
      },
    });

    run = await getLastSurgeonRun(client);
    expect(run).toMatchObject({
      id: runId,
      status: "completed",
      inputTokens: 1_250,
      outputTokens: 180,
      estimatedCostUsd: 0.12,
      actionsTaken: 3,
      actionsSkipped: 1,
      entriesRetired: 2,
      completedAt: "2026-03-29T10:05:00.000Z",
      summaryJson: {
        actions_taken: 3,
        entries_skipped: [{ entry_id: "entry-3", reason: "protected" }],
        observations: ["Temporary entries dominated the backlog."],
        recommendations: ["Run a broader all-scope pass next."],
      },
    });
  });

  it("logs surgeon actions with both entry_id and entry_ids payloads", async () => {
    const client = await createTestClient(clients);
    const runId = await createSurgeonRun(client, {
      passType: "retirement",
      dryRun: false,
      startedAt: "2026-03-29T11:00:00.000Z",
    });

    await logSurgeonAction(client, {
      id: "action-1",
      runId,
      actionType: "retire",
      entryIds: ["entry-a", "entry-b"],
      reasoning: "Both entries are obsolete session artifacts.",
      recallDelta: {
        before: {
          query: "session artifact",
          topResults: [{ entryId: "entry-a", subject: "Session handoff", score: 0.91 }],
        },
        after: {
          query: "session artifact",
          topResults: [{ entryId: "entry-c", subject: "Current status", score: 0.88 }],
        },
      },
      details: {
        issue_kind: "retirement_candidate",
        auto_applied: true,
      },
      createdAt: "2026-03-29T11:01:00.000Z",
    });

    const stored = await client.execute({
      sql: `
        SELECT entry_id, entry_ids, details_json
        FROM surgeon_run_actions
        WHERE id = 'action-1'
      `,
    });

    expect(stored.rows).toEqual([
      {
        entry_id: "entry-a",
        entry_ids: '["entry-a","entry-b"]',
        details_json: '{"issue_kind":"retirement_candidate","auto_applied":true}',
      },
    ]);

    expect(await getSurgeonRunActions(client, runId)).toEqual([
      {
        id: "action-1",
        runId,
        actionType: "retire",
        entryIds: ["entry-a", "entry-b"],
        reasoning: "Both entries are obsolete session artifacts.",
        recallDelta: {
          before: {
            query: "session artifact",
            topResults: [{ entryId: "entry-a", subject: "Session handoff", score: 0.91 }],
          },
          after: {
            query: "session artifact",
            topResults: [{ entryId: "entry-c", subject: "Current status", score: 0.88 }],
          },
        },
        details: {
          issue_kind: "retirement_candidate",
          auto_applied: true,
        },
        createdAt: "2026-03-29T11:01:00.000Z",
      },
    ]);
  });

  it("stores structured unresolved proposals for later adjudication", async () => {
    const client = await createTestClient(clients);
    const runId = await createSurgeonRun(client, {
      passType: "claim_key_quality",
      dryRun: true,
      startedAt: "2026-03-29T12:00:00.000Z",
    });

    await logSurgeonProposal(client, {
      id: "proposal-1",
      runId,
      groupId: "claim-key-mixed:shared-subject::fact",
      issueKind: "mixed_claim_key_group",
      scope: "cluster",
      entryIds: ["entry-a", "entry-b"],
      currentClaimKeys: ["jim/home_city", "jim/city_of_residence"],
      proposedClaimKeys: ["jim/home_city"],
      rationale:
        "One trusted canonical family already exists, but unification remains ambiguous. " +
        'The entry stays unchanged until review. If approved, the replacement would persist claim_key_status "trusted" with claim_key_source "surgeon_family_reuse".',
      confidence: 0.84,
      source: "mixed_group_consensus",
      eligibleForApply: true,
      createdAt: "2026-03-29T12:01:00.000Z",
    });

    expect(await getSurgeonRunProposals(client, runId)).toEqual([
      {
        id: "proposal-1",
        runId,
        groupId: "claim-key-mixed:shared-subject::fact",
        issueKind: "mixed_claim_key_group",
        scope: "cluster",
        entryIds: ["entry-a", "entry-b"],
        currentClaimKeys: ["jim/home_city", "jim/city_of_residence"],
        proposedClaimKeys: ["jim/home_city"],
        rationale:
          "One trusted canonical family already exists, but unification remains ambiguous. " +
          'The entry stays unchanged until review. If approved, the replacement would persist claim_key_status "trusted" with claim_key_source "surgeon_family_reuse".',
        confidence: 0.84,
        source: "mixed_group_consensus",
        eligibleForApply: true,
        createdAt: "2026-03-29T12:01:00.000Z",
      },
    ]);
  });

  it("filters non-string JSON array members from stored action and proposal payloads", async () => {
    const client = await createTestClient(clients);
    const runId = await createSurgeonRun(client, {
      passType: "claim_key_quality",
      dryRun: true,
      startedAt: "2026-03-29T12:00:00.000Z",
    });

    await client.execute({
      sql: `
        INSERT INTO surgeon_run_actions (
          id,
          run_id,
          action_type,
          entry_ids,
          reasoning,
          recall_delta,
          details_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        "action-invalid-array",
        runId,
        "skip",
        '["entry-a",42,null,"entry-b"]',
        "Malformed row from legacy storage.",
        null,
        null,
        "2026-03-29T12:01:00.000Z",
      ],
    });
    await client.execute({
      sql: `
        INSERT INTO surgeon_run_proposals (
          id,
          run_id,
          group_id,
          issue_kind,
          scope,
          entry_ids,
          current_claim_keys,
          proposed_claim_keys,
          rationale,
          confidence,
          source,
          eligible_for_apply,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        "proposal-invalid-array",
        runId,
        "group-1",
        "mixed_claim_key_group",
        "cluster",
        '["entry-a",false,"entry-b"]',
        '["jim/home_city",3]',
        '["jim/home_city",null]',
        "Legacy row with mixed JSON types.",
        0.5,
        "manual",
        0,
        "2026-03-29T12:02:00.000Z",
      ],
    });

    await expect(getSurgeonRunActions(client, runId)).resolves.toEqual([
      expect.objectContaining({
        id: "action-invalid-array",
        entryIds: ["entry-a", "entry-b"],
      }),
    ]);
    await expect(getSurgeonRunProposals(client, runId)).resolves.toEqual([
      expect.objectContaining({
        id: "proposal-invalid-array",
        entryIds: ["entry-a", "entry-b"],
        currentClaimKeys: ["jim/home_city"],
        proposedClaimKeys: ["jim/home_city"],
      }),
    ]);
  });

  it("rejects invalid stored surgeon pass and status codes", async () => {
    const client = await createTestClient(clients);

    await client.execute({
      sql: `
        INSERT INTO surgeon_runs (
          id,
          pass_type,
          project,
          started_at,
          status,
          model,
          dry_run,
          config_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: ["invalid-run", "not_a_real_pass", null, "2026-03-29T09:00:00.000Z", "not_a_real_status", null, 0, null],
    });

    await expect(getSurgeonRunHistory(client, 10)).rejects.toThrow(/Invalid surgeon pass type|Invalid surgeon run status/i);
  });

  it("returns recent history in descending order and sums last-day cost", async () => {
    const client = await createTestClient(clients);
    const now = new Date("2026-03-29T12:00:00.000Z");

    const olderRunId = await createSurgeonRun(client, {
      passType: "retirement",
      dryRun: false,
      startedAt: "2026-03-28T11:59:59.000Z",
    });
    const recentRunId = await createSurgeonRun(client, {
      passType: "retirement",
      dryRun: false,
      startedAt: "2026-03-29T08:00:00.000Z",
    });
    const newestRunId = await createSurgeonRun(client, {
      passType: "retirement",
      dryRun: true,
      startedAt: "2026-03-29T09:00:00.000Z",
    });

    await completeSurgeonRun(client, olderRunId, {
      status: "completed",
      inputTokens: 10,
      outputTokens: 10,
      estimatedCostUsd: 0.75,
      actionsTaken: 1,
      actionsSkipped: 0,
      entriesRetired: 1,
    });
    await completeSurgeonRun(client, recentRunId, {
      status: "completed",
      inputTokens: 10,
      outputTokens: 10,
      estimatedCostUsd: 1.25,
      actionsTaken: 1,
      actionsSkipped: 0,
      entriesRetired: 1,
    });
    await completeSurgeonRun(client, newestRunId, {
      status: "completed",
      inputTokens: 10,
      outputTokens: 10,
      estimatedCostUsd: 2.5,
      actionsTaken: 1,
      actionsSkipped: 0,
      entriesRetired: 1,
    });

    const history = await getSurgeonRunHistory(client, 2);
    expect(history.map((run) => run.id)).toEqual([newestRunId, recentRunId]);
    expect(await getDailySurgeonCost(client, now)).toBe(3.75);
  });

  it("persists multiple runs correctly when they complete in reverse order", async () => {
    const client = await createTestClient(clients);
    const now = new Date("2026-03-29T12:00:00.000Z");

    const firstRunId = await createSurgeonRun(client, {
      passType: "retirement",
      dryRun: false,
      startedAt: "2026-03-29T09:00:00.000Z",
    });
    const secondRunId = await createSurgeonRun(client, {
      passType: "retirement",
      dryRun: true,
      startedAt: "2026-03-29T10:00:00.000Z",
    });

    await completeSurgeonRun(client, secondRunId, {
      status: "completed",
      inputTokens: 20,
      outputTokens: 5,
      estimatedCostUsd: 1.25,
      actionsTaken: 2,
      actionsSkipped: 1,
      entriesRetired: 1,
      completedAt: "2026-03-29T10:05:00.000Z",
    });
    await completeSurgeonRun(client, firstRunId, {
      status: "completed",
      inputTokens: 10,
      outputTokens: 4,
      estimatedCostUsd: 0.75,
      actionsTaken: 1,
      actionsSkipped: 0,
      entriesRetired: 1,
      completedAt: "2026-03-29T10:06:00.000Z",
    });

    const history = await getSurgeonRunHistory(client, 10);
    expect(history.map((run) => run.id)).toEqual([secondRunId, firstRunId]);
    expect(history).toEqual([
      expect.objectContaining({
        id: secondRunId,
        status: "completed",
        dryRun: true,
        actionsTaken: 2,
        actionsSkipped: 1,
        estimatedCostUsd: 1.25,
      }),
      expect.objectContaining({
        id: firstRunId,
        status: "completed",
        dryRun: false,
        actionsTaken: 1,
        actionsSkipped: 0,
        estimatedCostUsd: 0.75,
      }),
    ]);
    expect(await getDailySurgeonCost(client, now)).toBe(2);
  });
});

async function createTestClient(clients: Client[]): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  await initSchema(client);
  return client;
}
