import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  completeSurgeonRun,
  createSurgeonRun,
  getDailySurgeonCost,
  getLastSurgeonRun,
  getSurgeonRunActions,
  getSurgeonRunHistory,
  logSurgeonAction,
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
      createdAt: "2026-03-29T11:01:00.000Z",
    });

    const stored = await client.execute({
      sql: `
        SELECT entry_id, entry_ids
        FROM surgeon_run_actions
        WHERE id = 'action-1'
      `,
    });

    expect(stored.rows).toEqual([
      {
        entry_id: "entry-a",
        entry_ids: '["entry-a","entry-b"]',
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
        createdAt: "2026-03-29T11:01:00.000Z",
      },
    ]);
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
});

async function createTestClient(clients: Client[]): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  await initSchema(client);
  return client;
}
