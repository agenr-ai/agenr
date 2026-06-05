import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { createTestClient, insertDurable, runClaimKeyPass } from "../../../helpers/dreaming-reconcile.js";

import { getDreamRunActions, getDreamRunProposals } from "../../../../src/adapters/db/dreaming-run-log.js";

describe("reconcile dreaming pass - normalize", () => {
  const clients: Client[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });

  it("normalizes clearly noncanonical claim keys in place and records structured action details", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, { id: "normalize-1", subject: "Home city", type: "fact", claim_key: " Jim / Home City " });

    const result = await runClaimKeyPass(client, {
      apply: true,
    });

    const row = await client.execute({
      sql: `
        SELECT
          claim_key,
          claim_key_raw,
          claim_key_status,
          claim_key_source,
          claim_key_confidence,
          claim_key_rationale
        FROM durables
        WHERE id = ?
      `,
      args: ["normalize-1"],
    });

    expect(result.status).toBe("completed");
    expect(row.rows[0]).toMatchObject({
      claim_key: "jim/home_city",
      claim_key_raw: "Jim / Home City",
      claim_key_status: "trusted",
      claim_key_source: "dreaming_reconcile",
      claim_key_confidence: 0.99,
      claim_key_rationale: 'Canonical normalization preserves the slot while rewriting " Jim / Home City " to "jim/home_city".',
    });
    expect(await getDreamRunActions(client, result.runId)).toEqual([
      expect.objectContaining({
        actionType: "update_durable",
        durableIds: ["normalize-1"],
        details: expect.objectContaining({
          issue_kind: "noncanonical_claim_key",
          old_claim_key: " Jim / Home City ",
          new_claim_key: "jim/home_city",
          claim_key_raw: "Jim / Home City",
          claim_key_status: "trusted",
          claim_key_source: "dreaming_reconcile",
          claim_key_confidence: 0.99,
          claim_key_rationale: 'Canonical normalization preserves the slot while rewriting " Jim / Home City " to "jim/home_city".',
          proposal_source: "normalize",
          auto_applied: true,
        }),
      }),
    ]);
  });

  it("emits a structured unresolved proposal instead of normalizing into an occupied canonical key", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, { id: "occupied", subject: "Home city canonical", type: "fact", claim_key: "jim/home_city" });
    await insertDurable(client, { id: "collision", subject: "Home city legacy", type: "fact", claim_key: " Jim / Home City " });

    const result = await runClaimKeyPass(client, {
      apply: true,
    });
    const proposals = await getDreamRunProposals(client, result.runId);
    const row = await client.execute({
      sql: "SELECT claim_key FROM durables WHERE id = ?",
      args: ["collision"],
    });

    expect(row.rows[0]?.claim_key).toBe(" Jim / Home City ");
    expect(proposals).toEqual([
      expect.objectContaining({
        issueKind: "noncanonical_claim_key",
        durableIds: ["collision"],
        currentClaimKeys: ["Jim / Home City"],
        proposedClaimKeys: ["jim/home_city"],
        scope: "single_durable",
        eligibleForApply: true,
      }),
    ]);
  });
});
