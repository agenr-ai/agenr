import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";

import { getDreamRunActions, getDreamRunProposals, getLastDreamRun } from "../../../../src/adapters/db/dreaming-run-log.js";
import { createTestClient, insertDurable, MockClaimLlm, runClaimKeyPass } from "../../../helpers/dreaming-reconcile.js";

describe("reconcile dreaming pass - claim-key alias convergence", () => {
  const clients: Client[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });

  it("emits a deterministic proposal in deep dry runs without mutating rows", async () => {
    const client = await createTestClient(clients);
    await insertQualityAliasCluster(client);

    const result = await runClaimKeyPass(client, { tier: "deep", apply: false });

    const proposals = await getDreamRunProposals(client, result.runId);
    const actions = await getDreamRunActions(client, result.runId);
    const rows = await qualityAliasRows(client);

    expect(result.status).toBe("completed");
    expect(rows).toEqual([
      { id: "quality-default", claim_key: "agenr/quality_score_default" },
      { id: "quality-heuristic", claim_key: "agenr/quality_score_heuristic" },
    ]);
    expect(proposals).toEqual([
      expect.objectContaining({
        issueKind: "claim_key_alias_convergence",
        scope: "cluster",
        durableIds: ["quality-default", "quality-heuristic"],
        currentClaimKeys: ["agenr/quality_score_default", "agenr/quality_score_heuristic"],
        proposedClaimKeys: ["agenr/quality_score_default"],
        eligibleForApply: false,
      }),
    ]);
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionType: "flag_review",
          details: expect.objectContaining({
            issue_kind: "claim_key_alias_convergence",
            alias_current_claim_keys: ["agenr/quality_score_default", "agenr/quality_score_heuristic"],
            alias_proposed_claim_key: "agenr/quality_score_default",
          }),
        }),
      ]),
    );
  });

  it("auto-applies high-confidence LLM-confirmed low-risk clusters in deep apply runs", async () => {
    const client = await createTestClient(clients);
    await insertQualityAliasCluster(client);
    const llm = new MockClaimLlm((_callIndex, systemPrompt, userMessage) => {
      expect(systemPrompt).toContain("same slot");
      expect(userMessage).toContain("agenr/quality_score_default");
      return {
        same_slot: true,
        canonical_claim_key: "agenr/quality_score_default",
        confidence: 0.94,
        rationale: "Both keys describe the same quality-score fallback slot for Agenr.",
      };
    });

    const result = await runClaimKeyPass(client, {
      tier: "deep",
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const rows = await qualityAliasRows(client);
    const proposals = await getDreamRunProposals(client, result.runId);
    const actions = await getDreamRunActions(client, result.runId);
    const summary = (await getLastDreamRun(client))?.summaryJson?.reconcile;

    expect(result.status).toBe("completed");
    expect(rows).toEqual([
      { id: "quality-default", claim_key: "agenr/quality_score_default" },
      { id: "quality-heuristic", claim_key: "agenr/quality_score_default" },
    ]);
    expect(proposals).toEqual([]);
    expect(summary?.counts).toMatchObject({
      identifiedAliasConvergences: 1,
      appliedAliasConvergences: 1,
    });
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["quality-heuristic"],
          details: expect.objectContaining({
            issue_kind: "claim_key_alias_convergence",
            proposal_source: "claim_key_alias_auto_convergence",
            alias_llm_same_slot: true,
            alias_llm_confidence: 0.94,
            alias_llm_rationale: "Both keys describe the same quality-score fallback slot for Agenr.",
          }),
        }),
      ]),
    );
  });

  it("leaves manual and trusted conflicts as proposals only", async () => {
    const client = await createTestClient(clients);
    await insertQualityAliasCluster(client, { heuristicTrusted: true });
    const llm = new MockClaimLlm(() => ({
      same_slot: true,
      canonical_claim_key: "agenr/quality_score_default",
      confidence: 0.95,
      rationale: "Same slot.",
    }));

    const result = await runClaimKeyPass(client, {
      tier: "deep",
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const rows = await qualityAliasRows(client);
    const proposals = await getDreamRunProposals(client, result.runId);
    const actions = await getDreamRunActions(client, result.runId);

    expect(rows).toEqual([
      { id: "quality-default", claim_key: "agenr/quality_score_default" },
      { id: "quality-heuristic", claim_key: "agenr/quality_score_heuristic" },
    ]);
    expect(proposals).toEqual([
      expect.objectContaining({
        issueKind: "claim_key_alias_convergence",
        eligibleForApply: false,
      }),
    ]);
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionType: "flag_review",
          details: expect.objectContaining({
            issue_kind: "claim_key_alias_convergence",
            alias_unresolved_reason: "Multiple trusted or manual claim keys are present, so operator review is required.",
            alias_llm_same_slot: true,
          }),
        }),
      ]),
    );
  });

  it("does not execute the full-corpus alias audit during standard runs", async () => {
    const client = await createTestClient(clients);
    await insertQualityAliasCluster(client);
    const llm = new MockClaimLlm(() => ({
      same_slot: true,
      canonical_claim_key: "agenr/quality_score_default",
      confidence: 0.95,
      rationale: "Same slot.",
    }));

    const result = await runClaimKeyPass(client, {
      tier: "standard",
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const rows = await qualityAliasRows(client);
    const proposals = await getDreamRunProposals(client, result.runId);

    expect(rows).toEqual([
      { id: "quality-default", claim_key: "agenr/quality_score_default" },
      { id: "quality-heuristic", claim_key: "agenr/quality_score_heuristic" },
    ]);
    expect(proposals.some((proposal) => proposal.issueKind === "claim_key_alias_convergence")).toBe(false);
  });

  it("stops LLM adjudication cleanly when the reconcile cost cap is exhausted", async () => {
    const client = await createTestClient(clients);
    await insertQualityAliasCluster(client);
    const llm = new MockClaimLlm(
      () => ({
        same_slot: true,
        canonical_claim_key: "agenr/quality_score_default",
        confidence: 0.95,
        rationale: "Same slot.",
      }),
      0.02,
    );

    const result = await runClaimKeyPass(client, {
      tier: "deep",
      apply: true,
      config: { dreaming: { dailyCostCap: 0.01 } },
      createClaimExtractionLlm: () => llm,
    });

    const rows = await qualityAliasRows(client);
    const proposals = await getDreamRunProposals(client, result.runId);
    const actions = await getDreamRunActions(client, result.runId);

    expect(result.status).toBe("cost_capped");
    expect(rows).toEqual([
      { id: "quality-default", claim_key: "agenr/quality_score_default" },
      { id: "quality-heuristic", claim_key: "agenr/quality_score_heuristic" },
    ]);
    expect(proposals).toEqual([
      expect.objectContaining({
        issueKind: "claim_key_alias_convergence",
        eligibleForApply: false,
      }),
    ]);
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionType: "flag_review",
          details: expect.objectContaining({
            issue_kind: "claim_key_alias_convergence",
            auto_apply_blocker: "LLM adjudication stopped after reaching the reconcile cost cap.",
            alias_llm_same_slot: true,
          }),
        }),
      ]),
    );
  });
});

async function insertQualityAliasCluster(client: Client, options: { heuristicTrusted?: boolean } = {}): Promise<void> {
  await insertDurable(client, {
    id: "quality-default",
    subject: "Agenr quality score",
    type: "fact",
    content: "Agenr durable quality scoring uses a default score when no evaluator is available.",
    claim_key: "agenr/quality_score_default",
    tags: ["agenr", "quality", "scoring"],
    project: "agenr",
    source_context: "Dreaming quality score implementation notes",
    claim_key_status: "trusted",
    claim_key_source: "manual",
    claim_key_confidence: 1,
  });
  await insertDurable(client, {
    id: "quality-heuristic",
    subject: "Agenr quality score",
    type: "fact",
    content: "Agenr durable quality scoring falls back to a heuristic score when no evaluator is available.",
    claim_key: "agenr/quality_score_heuristic",
    tags: ["agenr", "quality", "scoring"],
    project: "agenr",
    source_context: "Dreaming quality score implementation notes",
    claim_key_status: options.heuristicTrusted === true ? "trusted" : "tentative",
    claim_key_source: options.heuristicTrusted === true ? "manual" : "dreaming_extract",
    claim_key_confidence: options.heuristicTrusted === true ? 1 : 0.91,
  });
}

async function qualityAliasRows(client: Client): Promise<{ id: string; claim_key: string | null }[]> {
  const rows = await client.execute({
    sql: "SELECT id, claim_key FROM durables WHERE id IN (?, ?) ORDER BY id ASC",
    args: ["quality-default", "quality-heuristic"],
  });
  return rows.rows.map((row) => ({ id: String(row.id), claim_key: row.claim_key === null ? null : String(row.claim_key) }));
}
