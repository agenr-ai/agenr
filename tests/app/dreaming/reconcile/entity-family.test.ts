import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { createTestClient, insertDurable, runClaimKeyPass } from "../../../helpers/dreaming-reconcile.js";

import { getLastDreamRun, getDreamRunActions, getDreamRunProposals } from "../../../../src/adapters/db/dreaming-run-log.js";

describe("reconcile dreaming pass - entity family", () => {
  const clients: Client[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });

  it("auto-converges low-risk entity family aliases and records structured evidence", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
      id: "mac-mini-policy",
      subject: "Mac mini update policy",
      type: "fact",
      claim_key: "mac_mini/manual_update_policy",
      tags: ["ssh", "mini", "ops"],
      source_context: "Mac mini remote access handbook",
    });
    await insertDurable(client, {
      id: "mac-mini-access",
      subject: "Mac mini ssh access",
      type: "fact",
      claim_key: "mac_mini/macbook_ssh_access",
      tags: ["ssh", "mini", "ops"],
      source_context: "Mac mini remote access handbook",
    });
    await insertDurable(client, {
      id: "macmini-policy-alias",
      subject: "Macmini update policy",
      type: "fact",
      claim_key: "macmini/manual_update_policy",
      tags: ["ssh", "mini", "ops"],
      source_context: "Mac mini remote access handbook",
    });
    await insertDurable(client, {
      id: "macmini-access-alias",
      subject: "Macmini ssh access",
      type: "fact",
      claim_key: "macmini/macbook_ssh_access",
      tags: ["ssh", "mini", "ops"],
      source_context: "Mac mini remote access handbook",
    });

    const result = await runClaimKeyPass(client, {
      apply: true,
    });

    const rows = await client.execute({
      sql: "SELECT id, claim_key FROM durables WHERE id IN (?, ?) ORDER BY id ASC",
      args: ["macmini-access-alias", "macmini-policy-alias"],
    });
    const actions = await getDreamRunActions(client, result.runId);
    const summary = (await getLastDreamRun(client))?.summaryJson?.reconcile;
    const observations = (await getLastDreamRun(client))?.summaryJson?.observations ?? [];

    expect(result.status).toBe("completed");
    expect(rows.rows).toEqual([
      { id: "macmini-access-alias", claim_key: "mac_mini/macbook_ssh_access" },
      { id: "macmini-policy-alias", claim_key: "mac_mini/manual_update_policy" },
    ]);
    expect(summary?.before).toMatchObject({
      entityFamilyGroupCount: 1,
    });
    expect(summary?.after).toMatchObject({
      entityFamilyGroupCount: 0,
    });
    expect(summary?.counts).toMatchObject({
      identifiedEntityFamilyConvergences: 2,
      appliedEntityFamilyConvergences: 2,
    });
    expect(observations).toContain(
      "Entity-family convergence auto-applied 2 durable rewrites across 1 family cluster and staged 0 unresolved family proposals.",
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["macmini-policy-alias"],
          details: expect.objectContaining({
            issue_kind: "entity_family_convergence",
            proposal_source: "entity_family_auto_convergence",
            canonical_entity_prefix: "mac_mini",
            competing_entity_prefixes: ["mac_mini", "macmini"],
            entity_family_evidence: expect.arrayContaining([
              expect.objectContaining({ kind: "shared_attribute_overlap" }),
              expect.objectContaining({ kind: "shared_tag_grounding" }),
              expect.objectContaining({ kind: "lexical_separator_variant" }),
            ]),
          }),
        }),
      ]),
    );
  });

  it("emits unresolved entity family proposals when multiple canonical prefixes remain plausible", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
      id: "jim-timezone",
      subject: "Jim timezone",
      type: "fact",
      claim_key: "jim/timezone",
      tags: ["profile", "user"],
      source_context: "Personal profile handbook",
    });
    await insertDurable(client, {
      id: "jim-editor",
      subject: "Jim editor preference",
      type: "fact",
      claim_key: "jim/editor_preference",
      tags: ["profile", "user"],
      source_context: "Personal profile handbook",
    });
    await insertDurable(client, {
      id: "james-timezone",
      subject: "James Martin timezone",
      type: "fact",
      claim_key: "james_martin/timezone",
      tags: ["profile", "user"],
      source_context: "Personal profile handbook",
    });
    await insertDurable(client, {
      id: "james-editor",
      subject: "James Martin editor preference",
      type: "fact",
      claim_key: "james_martin/editor_preference",
      tags: ["profile", "user"],
      source_context: "Personal profile handbook",
    });
    await insertDurable(client, {
      id: "jm-timezone",
      subject: "JM timezone",
      type: "fact",
      claim_key: "jm/timezone",
      tags: ["profile", "user"],
      source_context: "Personal profile handbook",
    });
    await insertDurable(client, {
      id: "jm-editor",
      subject: "JM editor preference",
      type: "fact",
      claim_key: "jm/editor_preference",
      tags: ["profile", "user"],
      source_context: "Personal profile handbook",
    });

    const result = await runClaimKeyPass(client, {
      apply: true,
    });

    const proposals = await getDreamRunProposals(client, result.runId);
    const rows = await client.execute({
      sql: "SELECT id, claim_key FROM durables WHERE id IN (?, ?, ?, ?, ?, ?) ORDER BY id ASC",
      args: ["james-editor", "james-timezone", "jim-editor", "jim-timezone", "jm-editor", "jm-timezone"],
    });
    const actions = await getDreamRunActions(client, result.runId);
    const observations = (await getLastDreamRun(client))?.summaryJson?.observations ?? [];

    expect(result.status).toBe("completed");
    expect(rows.rows).toEqual([
      { id: "james-editor", claim_key: "james_martin/editor_preference" },
      { id: "james-timezone", claim_key: "james_martin/timezone" },
      { id: "jim-editor", claim_key: "jim/editor_preference" },
      { id: "jim-timezone", claim_key: "jim/timezone" },
      { id: "jm-editor", claim_key: "jm/editor_preference" },
      { id: "jm-timezone", claim_key: "jm/timezone" },
    ]);
    expect(proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueKind: "entity_family_convergence",
          source: "entity_family_ambiguous",
          durableIds: ["james-editor", "james-timezone", "jim-editor", "jim-timezone", "jm-editor", "jm-timezone"],
          proposedClaimKeys: [],
          eligibleForApply: false,
        }),
      ]),
    );
    expect(observations).toContain(
      "Entity-family convergence auto-applied 0 durable rewrites across 0 family clusters and staged 1 unresolved family proposal.",
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["james-editor", "james-timezone", "jim-editor", "jim-timezone", "jm-editor", "jm-timezone"],
          details: expect.objectContaining({
            issue_kind: "entity_family_convergence",
            auto_applied: false,
            canonical_entity_prefix: null,
            competing_entity_prefixes: ["james_martin", "jim", "jm"],
            entity_family_unresolved_reason: "Multiple plausible canonical entity prefixes remain after conservative scoring.",
            entity_family_evidence: expect.arrayContaining([expect.objectContaining({ kind: "shared_attribute_overlap" })]),
          }),
        }),
      ]),
    );
  });

  it("keeps multi-target entity family proposals off the autonomous apply path", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
      id: "macbook-sandbox",
      subject: "MacBook sandbox environment separation",
      type: "fact",
      claim_key: "macbook/sandbox_environment_separation",
      tags: ["macbook", "workflow"],
      source_context: "User asked about sandbox workflow setup.",
    });
    await insertDurable(client, {
      id: "macbook-source",
      subject: "MacBook source of truth",
      type: "fact",
      claim_key: "macbook/source_of_truth",
      tags: ["macbook", "workflow"],
      source_context: "User asked about sandbox workflow setup.",
    });
    await insertDurable(client, {
      id: "macbook-repos-sandbox",
      subject: "MacBook repos sandbox environment separation",
      type: "fact",
      claim_key: "macbook_repos/sandbox_environment_separation",
      tags: ["macbook", "workflow"],
      source_context: "User asked about sandbox workflow setup.",
    });
    await insertDurable(client, {
      id: "macbook-repos-source",
      subject: "MacBook repos source of truth",
      type: "fact",
      claim_key: "macbook_repos/source_of_truth",
      tags: ["macbook", "workflow"],
      source_context: "User asked about sandbox workflow setup.",
    });

    const result = await runClaimKeyPass(client, {
      apply: true,
    });

    const proposals = await getDreamRunProposals(client, result.runId);
    expect(proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueKind: "entity_family_convergence",
          proposedClaimKeys: ["macbook_repos/sandbox_environment_separation", "macbook_repos/source_of_truth"],
          eligibleForApply: false,
        }),
      ]),
    );
  });
});
