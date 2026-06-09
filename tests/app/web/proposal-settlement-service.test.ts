import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import { initSchema } from "../../../src/adapters/db/schema.js";
import { createDreamPort } from "../../../src/adapters/db/dreaming-port.js";
import { getDurable } from "../../../src/adapters/db/queries.js";
import { buildManualProposalSettlementReason } from "../../../src/core/dreaming/domain/proposal-review.js";
import { createInstanceContext } from "../../../src/app/web/instance-context.js";
import { settleManualWebProposal } from "../../../src/app/web/proposal-settlement-service.js";
import { getDreamRunProposals } from "../../../src/adapters/db/dreaming-run-log.js";
import type { DreamRunProposal } from "../../../src/core/dreaming/types.js";
import { insertDurable, runClaimKeyPass } from "../../helpers/dreaming-reconcile.js";
import { removeTestPath } from "../../helpers/temp-paths.js";

describe("settleManualWebProposal", () => {
  const clients: Client[] = [];
  const tempRoots: string[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.close();
    }
    for (const root of tempRoots.splice(0)) {
      await removeTestPath(root);
    }
  });

  it("persists a server-built settlement reason from the operator note", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agenr-settle-"));
    tempRoots.push(root);
    const dbPath = path.join(root, "knowledge.db");
    const client = createClient({ url: `file:${dbPath}` });
    clients.push(client);
    await initSchema(client);

    await insertDurable(client, {
      id: "mixed-a",
      subject: "Mac mini update policy",
      type: "preference",
      claim_key: "mac_mini/manual_update_policy",
    });
    await insertDurable(client, {
      id: "mixed-b",
      subject: "Mac mini update policy",
      type: "preference",
      claim_key: "mac_mini/update_window",
    });

    const result = await runClaimKeyPass(client);
    const proposal = (await getDreamRunProposals(client, result.runId)).find((item) => item.issueKind === "mixed_claim_key_group");
    expect(proposal).toBeDefined();

    const env: NodeJS.ProcessEnv = { ...process.env, AGENR_CONFIG_DIR: root };
    const context = createInstanceContext(
      {
        record: { id: "test", name: "Test", createdAt: "2026-04-04T15:00:00.000Z" },
        dbPath,
        configPath: path.join(root, "config.json"),
        dbExists: true,
      },
      env,
    );

    const settled = await settleManualWebProposal({
      proposalId: proposal!.id,
      choice: "separate",
      reason: "These are separate update-policy slots.",
      context,
    });

    expect(settled.proposal.reviewStatus).toBe("rejected");
    expect(settled.proposal.reviewReason).toBe(
      buildManualProposalSettlementReason("mixed_claim_key_group", "separate", "These are separate update-policy slots.", "", 0),
    );
  });

  it("writes a manual canonical key for an ineligible alias-convergence proposal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agenr-settle-"));
    tempRoots.push(root);
    const dbPath = path.join(root, "knowledge.db");
    const client = createClient({ url: `file:${dbPath}` });
    clients.push(client);
    await initSchema(client);
    const port = createDreamPort(client);
    const runId = await port.createRun({ tier: "deep", dryRun: false });

    await insertDurable(client, {
      id: "quality-a",
      subject: "Quality score default",
      type: "fact",
      claim_key: "agenr/quality_score_default",
    });
    await insertDurable(client, {
      id: "quality-b",
      subject: "Quality score default",
      type: "fact",
      claim_key: "agenr/durables_quality_score_default",
    });
    await port.logRunProposal(
      buildProposal({
        id: "proposal-alias",
        runId,
        durableIds: ["quality-a", "quality-b", "quality-missing"],
        issueKind: "claim_key_alias_convergence",
        currentClaimKeys: ["agenr/quality_score_default", "agenr/durables_quality_score_default"],
        proposedClaimKeys: ["agenr/durables_production_quality_score_default"],
        eligibleForApply: false,
      }),
    );

    const env: NodeJS.ProcessEnv = { ...process.env, AGENR_CONFIG_DIR: root };
    const context = createInstanceContext(
      {
        record: { id: "test", name: "Test", createdAt: "2026-04-04T15:00:00.000Z" },
        dbPath,
        configPath: path.join(root, "config.json"),
        dbExists: true,
      },
      env,
    );

    const settled = await settleManualWebProposal({
      proposalId: "proposal-alias",
      choice: "canonical",
      targetClaimKey: "agenr/durables_production_quality_score_default",
      reason: "These are the same durable slot.",
      context,
    });

    expect(settled.proposal.reviewStatus).toBe("rejected");
    expect(settled.proposal.reviewReason).toBe(
      buildManualProposalSettlementReason(
        "claim_key_alias_convergence",
        "canonical",
        "These are the same durable slot.",
        "agenr/durables_production_quality_score_default",
        0,
      ),
    );
    await expect(getDurable(client, "quality-a")).resolves.toMatchObject({
      claim_key: "agenr/durables_production_quality_score_default",
      claim_key_source: "manual",
    });
    await expect(getDurable(client, "quality-b")).resolves.toMatchObject({
      claim_key: "agenr/durables_production_quality_score_default",
      claim_key_source: "manual",
    });
  });
});

function buildProposal(overrides: Partial<DreamRunProposal> & Pick<DreamRunProposal, "id" | "runId" | "durableIds">): DreamRunProposal {
  return {
    groupId: overrides.groupId ?? "group-1",
    issueKind: overrides.issueKind ?? "claim_key_alias_convergence",
    scope: overrides.scope ?? "cluster",
    currentClaimKeys: overrides.currentClaimKeys ?? ["agenr/quality_score_default"],
    proposedClaimKeys: overrides.proposedClaimKeys ?? [],
    rationale: overrides.rationale ?? "Operator settlement required.",
    confidence: overrides.confidence ?? 0.72,
    source: overrides.source ?? "claim_key_alias_llm_adjudicated",
    eligibleForApply: overrides.eligibleForApply ?? false,
    createdAt: overrides.createdAt ?? "2026-04-04T12:00:00.000Z",
    reviewStatus: overrides.reviewStatus ?? "open",
    reviewedAt: overrides.reviewedAt ?? null,
    reviewReason: overrides.reviewReason ?? null,
    appliedActionCount: overrides.appliedActionCount ?? 0,
    ...overrides,
  };
}
