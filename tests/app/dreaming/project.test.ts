import { type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import { createDreamPort } from "../../../src/adapters/db/dreaming-port.js";
import { runProjectStage } from "../../../src/app/dreaming/project.js";
import { createTestClient, insertDurable, TEST_NOW } from "../../helpers/dreaming-reconcile.js";

describe("dreaming project stage", () => {
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    clients.length = 0;
  });

  it("projects an ordered profile snapshot with directive ids", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    await insertDurable(client, {
      id: "core-workflow",
      subject: "Branching workflow",
      content: "Always branch from local master before editing.",
      type: "decision",
      expiry: "core",
      importance: 8,
    });
    await insertDurable(client, {
      id: "preference-quiet",
      subject: "Quiet dinner preference",
      content: "Prefers quiet dinner recommendations.",
      type: "preference",
      expiry: "permanent",
      importance: 9,
    });
    await insertDurable(client, {
      id: "low-fact",
      subject: "Low priority fact",
      content: "Uses a low-priority test fixture.",
      type: "fact",
      expiry: "permanent",
      importance: 3,
    });
    await insertDurable(client, {
      id: "dir-goals",
      subject: "Weekly goals directive",
      content: "Ask about weekly goals at session start.",
      type: "directive",
      expiry: "core",
      importance: 10,
      claim_key: "user/memory_directive/weekly_goals",
      directive_polarity: "proactive",
      directive_trigger: "session_start",
    });

    const runId = await port.createRun({ tier: "standard", dryRun: false });
    const result = await runProjectStage(
      {
        runId,
        now: () => TEST_NOW,
        maxProfileDurables: 2,
      },
      { port },
    );

    expect(result.summary).toMatchObject({
      profileDurableCount: 2,
      directiveCount: 1,
      applied: false,
      snapshotId: null,
    });
    expect(result.snapshot?.durableIds).toEqual(["core-workflow", "preference-quiet"]);
    expect(result.snapshot?.directiveIds).toEqual(["dir-goals"]);

    const persisted = await client.execute("SELECT COUNT(*) AS count FROM profile_snapshots");
    expect(Number(persisted.rows[0]?.count)).toBe(0);
  });

  it("does not persist snapshot candidates", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    await insertDurable(client, {
      id: "core-workflow",
      subject: "Branching workflow",
      content: "Always branch from local master before editing.",
      type: "decision",
      expiry: "core",
      importance: 8,
    });

    const runId = await port.createRun({ tier: "standard", dryRun: true });
    const result = await runProjectStage(
      {
        runId,
        now: () => TEST_NOW,
      },
      { port },
    );

    expect(result.summary.applied).toBe(false);
    expect(result.snapshot?.durableIds).toEqual(["core-workflow"]);

    const persisted = await client.execute("SELECT COUNT(*) AS count FROM profile_snapshots");
    expect(Number(persisted.rows[0]?.count)).toBe(0);
  });
});
