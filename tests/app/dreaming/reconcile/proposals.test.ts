import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { createTestClient, insertDurable, MockClaimLlm, runClaimKeyPass } from "../../../helpers/dreaming-reconcile.js";

import { getLastDreamRun, getDreamRunActions, getDreamRunProposals } from "../../../../src/adapters/db/dreaming-run-log.js";

describe("reconcile dreaming pass - proposals", () => {
  const clients: Client[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });

  it("reuses the same open proposal row when the same logical issue is rediscovered on a later run", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
      id: "metadata-proposal-repeat",
      subject: "Project status",
      type: "fact",
      content: "The project is active.",
      project: "Agenr",
    });
    const llm = new MockClaimLlm(() => ({
      entity: "project",
      attribute: "status",
      confidence: 0.68,
    }));

    const firstResult = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });
    const firstProposal = (await getDreamRunProposals(client, firstResult.runId))[0];
    const secondResult = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });
    const openRows = await client.execute({
      sql: `
        SELECT id, run_id, created_at
        FROM dream_proposals
        WHERE review_status = 'open'
          AND issue_kind = 'missing_claim_key'
          AND EXISTS (SELECT 1 FROM json_each(durable_ids) AS je WHERE je.value = ?)
      `,
      args: ["metadata-proposal-repeat"],
    });

    expect(firstProposal).toMatchObject({
      issueKind: "missing_claim_key",
      durableIds: ["metadata-proposal-repeat"],
    });
    expect(openRows.rows).toEqual([
      {
        id: firstProposal?.id,
        run_id: secondResult.runId,
        created_at: firstProposal?.createdAt,
      },
    ]);
  });

  it("emits suspect-but-canonical proposals instead of mutating ambiguous generic keys", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, { id: "suspect", subject: "Project status", type: "fact", claim_key: "project/status", content: "The project is active." });
    const llm = new MockClaimLlm(() => ({
      entity: "Agenr",
      attribute: "status",
      confidence: 0.88,
    }));

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });
    const proposals = await getDreamRunProposals(client, result.runId);
    const row = await client.execute({
      sql: "SELECT claim_key FROM durables WHERE id = ?",
      args: ["suspect"],
    });

    expect(row.rows[0]?.claim_key).toBe("project/status");
    expect(proposals).toEqual([
      expect.objectContaining({
        issueKind: "suspect_canonical_claim_key",
        durableIds: ["suspect"],
        currentClaimKeys: ["project/status"],
        proposedClaimKeys: ["agenr/status"],
      }),
    ]);
  });

  it("emits mixed-key group proposals with durable required fields", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, { id: "mixed-a", subject: "Mac mini update policy", type: "preference", claim_key: "mac_mini/manual_update_policy" });
    await insertDurable(client, { id: "mixed-b", subject: "Mac mini update policy", type: "preference", claim_key: "mac_mini/update_window" });

    const result = await runClaimKeyPass(client);
    const proposal = (await getDreamRunProposals(client, result.runId)).find((item) => item.issueKind === "mixed_claim_key_group");

    expect(proposal).toMatchObject({
      runId: result.runId,
      issueKind: "mixed_claim_key_group",
      scope: "cluster",
      durableIds: ["mixed-a", "mixed-b"],
      currentClaimKeys: ["mac_mini/manual_update_policy", "mac_mini/update_window"],
      confidence: expect.any(Number),
      source: expect.any(String),
      rationale: expect.any(String),
      eligibleForApply: false,
    });
    expect(typeof proposal?.id).toBe("string");
    expect(typeof proposal?.groupId).toBe("string");
  });
});
