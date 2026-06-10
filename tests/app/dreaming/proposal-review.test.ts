import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import { createDreamPort } from "../../../src/adapters/db/dreaming-port.js";
import { getDurable } from "../../../src/adapters/db/queries.js";
import { applyDuplicateSlotCollapseProposal, applyProposalToDurables, loadActiveProposalDurables } from "../../../src/app/dreaming/proposal-review.js";
import type { DreamRunProposal } from "../../../src/core/dreaming/types.js";
import { closeTestDatabases } from "../../helpers/temp-paths.js";
import { createTestClient, insertDurable } from "../../helpers/dreaming-reconcile.js";

const clients: Client[] = [];

afterEach(async () => {
  await closeTestDatabases(clients.splice(0, clients.length));
});

function buildProposal(overrides: Partial<DreamRunProposal> & Pick<DreamRunProposal, "id" | "runId" | "durableIds">): DreamRunProposal {
  return {
    groupId: overrides.groupId ?? "group-1",
    issueKind: overrides.issueKind ?? "malformed_claim_key",
    scope: overrides.scope ?? "single_durable",
    currentClaimKeys: overrides.currentClaimKeys ?? ["Bad Key"],
    proposedClaimKeys: overrides.proposedClaimKeys ?? ["person/name"],
    rationale: overrides.rationale ?? "Normalize the malformed claim key.",
    confidence: overrides.confidence ?? 0.9,
    source: overrides.source ?? "dreaming_reconcile",
    eligibleForApply: overrides.eligibleForApply ?? true,
    createdAt: overrides.createdAt ?? "2026-04-04T12:00:00.000Z",
    reviewStatus: overrides.reviewStatus ?? "open",
    reviewedAt: overrides.reviewedAt ?? null,
    reviewReason: overrides.reviewReason ?? null,
    appliedActionCount: overrides.appliedActionCount ?? 0,
    ...overrides,
  };
}

describe("dreaming proposal review", () => {
  it("reads back a persisted proposal and reviews it as rejected", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);
    const runId = await port.createRun({ tier: "standard", dryRun: true });
    await insertDurable(client, { id: "durable-1", subject: "Alex Doe", claim_key: "Bad Key" });
    await port.logRunProposal(buildProposal({ id: "proposal-1", runId, durableIds: ["durable-1"] }));

    const stored = await port.getProposal("proposal-1");
    expect(stored?.reviewStatus).toBe("open");

    const reviewed = await port.reviewProposal({ proposalId: "proposal-1", status: "rejected", reason: "Not confident enough." });
    expect(reviewed).toBe(true);

    const after = await port.getProposal("proposal-1");
    expect(after?.reviewStatus).toBe("rejected");
    expect(after?.reviewReason).toBe("Not confident enough.");

    const secondAttempt = await port.reviewProposal({ proposalId: "proposal-1", status: "applied", reason: "Too late." });
    expect(secondAttempt).toBe(false);
  });

  it("applies a proposal by rewriting the durable claim key and logging an action", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);
    const runId = await port.createRun({ tier: "standard", dryRun: false });
    await insertDurable(client, { id: "durable-1", subject: "Alex Doe", claim_key: "Bad Key" });
    const proposal = buildProposal({ id: "proposal-1", runId, durableIds: ["durable-1"] });
    await port.logRunProposal(proposal);

    const { activeDurables, inactiveDurableIds } = await loadActiveProposalDurables(proposal, (durableId) => port.getDurable(durableId));
    expect(inactiveDurableIds).toEqual([]);

    const applied = await applyProposalToDurables(
      {
        proposal,
        activeDurables,
        reviewReason: "Confirmed canonical key.",
        reviewedAt: "2026-04-04T15:00:00.000Z",
        actionReviewStatus: "applied",
        requireAllUpdates: true,
      },
      {
        updateDurable: (durableId, fields) => port.updateDurable(durableId, fields),
        logRunAction: (action) => port.logRunAction(action),
      },
    );

    expect(applied.updatedDurableIds).toEqual(["durable-1"]);
    expect(applied.targetClaimKey).toBe("person/name");

    const updated = await getDurable(client, "durable-1");
    expect(updated?.claim_key).toBe("person/name");
    expect(updated?.claim_key_source).toBe("dreaming_reconcile");

    const actions = await port.getRunActions(runId);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.actionType).toBe("update_durable");
    expect(actions[0]?.durableIds).toEqual(["durable-1"]);
  });

  it("applies a duplicate-slot-collapse proposal by superseding non-survivors and logging merge actions", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);
    const runId = await port.createRun({ tier: "deep", dryRun: false });
    await insertDurable(client, {
      id: "slot-old",
      subject: "Default shell (old)",
      claim_key: "mac_mini/default_shell",
      claim_key_status: "trusted",
      importance: 5,
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await insertDurable(client, {
      id: "slot-new",
      subject: "Default shell (new)",
      claim_key: "mac_mini/default_shell",
      claim_key_status: "trusted",
      importance: 5,
      created_at: "2026-02-01T00:00:00.000Z",
    });
    const proposal = buildProposal({
      id: "proposal-collapse",
      runId,
      durableIds: ["slot-new", "slot-old"],
      issueKind: "duplicate_slot_collapse",
      scope: "cluster",
      currentClaimKeys: ["mac_mini/default_shell"],
      proposedClaimKeys: ["mac_mini/default_shell"],
      source: "duplicate_slot_collapse",
    });
    await port.logRunProposal(proposal);

    const { activeDurables } = await loadActiveProposalDurables(proposal, (durableId) => port.getDurable(durableId));
    const applied = await applyDuplicateSlotCollapseProposal(
      {
        proposal,
        activeDurables,
        reviewReason: "Collapse confirmed by operator.",
        reviewedAt: "2026-04-04T15:00:00.000Z",
      },
      {
        supersedeDurable: (oldDurableId, newDurableId, kind, reason) => port.supersedeDurable(oldDurableId, newDurableId, kind, reason),
        updateDurable: (durableId, fields) => port.updateDurable(durableId, fields, { includeInactive: true }),
        logRunAction: (action) => port.logRunAction(action),
      },
    );

    expect(applied.survivorId).toBe("slot-new");
    expect(applied.supersededDurableIds).toEqual(["slot-old"]);

    const superseded = await client.execute({
      sql: "SELECT superseded_by, supersession_kind, valid_to FROM durables WHERE id = ?",
      args: ["slot-old"],
    });
    expect(superseded.rows[0]).toMatchObject({
      superseded_by: "slot-new",
      supersession_kind: "duplicate_collapse",
      valid_to: "2026-04-04T15:00:00.000Z",
    });

    const survivor = await getDurable(client, "slot-new");
    expect(survivor?.superseded_by).toBeUndefined();

    const actions = await port.getRunActions(runId);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.actionType).toBe("merge");
    expect(actions[0]?.durableIds).toEqual(["slot-old", "slot-new"]);
    expect(actions[0]?.details).toMatchObject({
      proposal_id: "proposal-collapse",
      survivor_id: "slot-new",
      superseded_id: "slot-old",
      supersession_kind: "duplicate_collapse",
    });
  });
});
