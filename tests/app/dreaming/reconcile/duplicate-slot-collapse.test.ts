import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";

import { getDreamRunActions, getDreamRunProposals, getLastDreamRun } from "../../../../src/adapters/db/dreaming-run-log.js";
import { createTestClient, insertDurable, runClaimKeyPass } from "../../../helpers/dreaming-reconcile.js";

describe("reconcile dreaming pass - duplicate slot collapse", () => {
  const clients: Client[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });

  it("auto-applies a collapse for a uniform trusted group and logs merge actions", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
      id: "shell-old",
      subject: "Mac mini default shell (old)",
      type: "fact",
      claim_key: "mac_mini/default_shell",
      claim_key_status: "trusted",
      importance: 5,
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await insertDurable(client, {
      id: "shell-mid",
      subject: "Mac mini default shell (mid)",
      type: "fact",
      claim_key: "mac_mini/default_shell",
      claim_key_status: "trusted",
      importance: 5,
      created_at: "2026-02-01T00:00:00.000Z",
    });
    await insertDurable(client, {
      id: "shell-new",
      subject: "Mac mini default shell (new)",
      type: "fact",
      claim_key: "mac_mini/default_shell",
      claim_key_status: "trusted",
      importance: 7,
      created_at: "2026-03-01T00:00:00.000Z",
    });

    const result = await runClaimKeyPass(client, { apply: true });

    const rows = await client.execute({
      sql: "SELECT id, superseded_by, supersession_kind, valid_to FROM durables ORDER BY id ASC",
      args: [],
    });
    const actions = await getDreamRunActions(client, result.runId);
    const mergeActions = actions.filter((action) => action.actionType === "merge");
    const summary = (await getLastDreamRun(client))?.summaryJson?.reconcile;

    expect(result.status).toBe("completed");
    // shell-new wins on importance; the others are superseded onto it.
    expect(rows.rows).toEqual([
      expect.objectContaining({ id: "shell-mid", superseded_by: "shell-new", supersession_kind: "duplicate_collapse" }),
      expect.objectContaining({ id: "shell-new", superseded_by: null, valid_to: null }),
      expect.objectContaining({ id: "shell-old", superseded_by: "shell-new", supersession_kind: "duplicate_collapse" }),
    ]);
    expect(rows.rows.filter((row) => row.id !== "shell-new").every((row) => row.valid_to !== null)).toBe(true);
    expect(mergeActions).toHaveLength(2);
    expect(mergeActions.map((action) => action.durableIds)).toEqual(
      expect.arrayContaining([
        ["shell-old", "shell-new"],
        ["shell-mid", "shell-new"],
      ]),
    );
    expect(summary?.counts).toMatchObject({
      identifiedDuplicateSlotCollapses: 1,
      appliedDuplicateSlotCollapses: 2,
    });
  });

  it("emits an open proposal without mutation for a mixed-status group", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
      id: "editor-trusted",
      subject: "Default editor trusted row",
      type: "fact",
      claim_key: "jim/default_editor",
      claim_key_status: "trusted",
      importance: 6,
      created_at: "2026-02-01T00:00:00.000Z",
    });
    await insertDurable(client, {
      id: "editor-tentative",
      subject: "Default editor tentative row",
      type: "fact",
      claim_key: "jim/default_editor",
      claim_key_status: "tentative",
      importance: 8,
      created_at: "2026-03-01T00:00:00.000Z",
    });

    const result = await runClaimKeyPass(client, { apply: true });

    const rows = await client.execute({
      sql: "SELECT id, superseded_by, valid_to FROM durables ORDER BY id ASC",
      args: [],
    });
    const proposals = await getDreamRunProposals(client, result.runId);
    const collapseProposals = proposals.filter((proposal) => proposal.issueKind === "duplicate_slot_collapse");
    const actions = await getDreamRunActions(client, result.runId);

    expect(result.status).toBe("completed");
    expect(rows.rows.every((row) => row.superseded_by === null && row.valid_to === null)).toBe(true);
    expect(collapseProposals).toHaveLength(1);
    expect(collapseProposals[0]).toMatchObject({
      issueKind: "duplicate_slot_collapse",
      scope: "cluster",
      reviewStatus: "open",
      eligibleForApply: true,
      currentClaimKeys: ["jim/default_editor"],
      proposedClaimKeys: ["jim/default_editor"],
      // Trusted status beats higher importance in survivor ordering.
      durableIds: ["editor-trusted", "editor-tentative"],
    });
    expect(actions.filter((action) => action.actionType === "merge")).toHaveLength(0);
  });

  it("exempts multivalued slot policies such as preference heads", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
      id: "pref-1",
      subject: "Editor preference one",
      type: "preference",
      claim_key: "jim/preference_editor_theme",
      claim_key_status: "trusted",
    });
    await insertDurable(client, {
      id: "pref-2",
      subject: "Editor preference two",
      type: "preference",
      claim_key: "jim/preference_editor_theme",
      claim_key_status: "trusted",
    });

    const result = await runClaimKeyPass(client, { apply: true });

    const proposals = await getDreamRunProposals(client, result.runId);
    const actions = await getDreamRunActions(client, result.runId);
    const rows = await client.execute({ sql: "SELECT superseded_by FROM durables", args: [] });
    const summary = (await getLastDreamRun(client))?.summaryJson?.reconcile;

    expect(result.status).toBe("completed");
    expect(proposals.filter((proposal) => proposal.issueKind === "duplicate_slot_collapse")).toHaveLength(0);
    expect(actions.filter((action) => action.actionType === "merge")).toHaveLength(0);
    expect(rows.rows.every((row) => row.superseded_by === null)).toBe(true);
    expect(summary?.counts).toMatchObject({
      identifiedDuplicateSlotCollapses: 0,
      appliedDuplicateSlotCollapses: 0,
    });
  });

  it("identifies collapses in dry-run mode without persisting any mutation", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
      id: "dry-a",
      subject: "Dry run row A",
      type: "fact",
      claim_key: "mac_mini/default_shell",
      claim_key_status: "trusted",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await insertDurable(client, {
      id: "dry-b",
      subject: "Dry run row B",
      type: "fact",
      claim_key: "mac_mini/default_shell",
      claim_key_status: "trusted",
      created_at: "2026-02-01T00:00:00.000Z",
    });

    const result = await runClaimKeyPass(client, { apply: false });

    const rows = await client.execute({ sql: "SELECT superseded_by, valid_to FROM durables", args: [] });
    const summary = (await getLastDreamRun(client))?.summaryJson?.reconcile;

    expect(result.status).toBe("completed");
    expect(rows.rows.every((row) => row.superseded_by === null && row.valid_to === null)).toBe(true);
    expect(summary?.counts).toMatchObject({
      identifiedDuplicateSlotCollapses: 1,
      appliedDuplicateSlotCollapses: 0,
    });
    // Projected health reflects the collapse even though nothing was written.
    expect(summary?.projectedAfter?.exactKeyMultiActiveClusterCount).toBe(0);
  });
});
