import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import { initSchema } from "../../../src/adapters/db/schema.js";
import { buildMixedClaimKeySettlementReason } from "../../../src/core/dreaming/domain/proposal-review.js";
import { createInstanceContext } from "../../../src/app/web/instance-context.js";
import { settleManualMixedWebProposal } from "../../../src/app/web/proposal-settlement-service.js";
import { getDreamRunProposals } from "../../../src/adapters/db/dreaming-run-log.js";
import { insertDurable, runClaimKeyPass } from "../../helpers/dreaming-reconcile.js";
import { removeTestPath } from "../../helpers/temp-paths.js";

describe("settleManualMixedWebProposal", () => {
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

    const settled = await settleManualMixedWebProposal({
      proposalId: proposal!.id,
      choice: "separate",
      reason: "These are separate update-policy slots.",
      context,
    });

    expect(settled.proposal.reviewStatus).toBe("rejected");
    expect(settled.proposal.reviewReason).toBe(
      buildMixedClaimKeySettlementReason("separate", "These are separate update-policy slots.", "", 0),
    );
  });
});
