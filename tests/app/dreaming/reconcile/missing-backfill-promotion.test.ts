import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { getLastDreamRun, getDreamRunActions, getDreamRunProposals } from "../../../../src/adapters/db/dreaming-run-log.js";
import { createTestClient, insertDurable, MockClaimLlm, runClaimKeyPass } from "../../../helpers/dreaming-reconcile.js";
import {
  seedChangelogSourceOfTruthFamily,
  seedJimHandoffFamily,
  seedJimSingleSiblingHandoffFamily,
  seedOpenclawOrderingFamily,
} from "../../../helpers/missing-backfill-promotion-fixtures.js";

describe("reconcile dreaming pass - missing backfill promotion", () => {
  const clients: Client[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });
  it("auto-applies grounded template-family candidates after safely compacting duplicated entity phrasing", async () => {
    const client = await createTestClient(clients);
    await seedChangelogSourceOfTruthFamily(client);
    const llm = new MockClaimLlm(() => ({
      entity: "changelog",
      attribute: "changelog source of truth",
      confidence: 0.87,
    }));

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const row = await client.execute({
      sql: "SELECT claim_key FROM durables WHERE id = ?",
      args: ["changelog-supported"],
    });
    const actions = await getDreamRunActions(client, result.runId);
    const run = await getLastDreamRun(client);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBe("changelog/source_of_truth");
    expect(run?.summaryJson?.observations).toContain(
      "Compact canonicalization rewrote 1 missing-key candidate before auto-apply and 0 before unresolved proposal logging.",
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["changelog-supported"],
          details: expect.objectContaining({
            supported_auto_apply: true,
            support_class: "trusted_family_template_grounded",
            claim_key_compacted_from: "changelog/changelog_source_of_truth",
            claim_key_compaction_reason: "removed duplicated entity prefix from attribute",
            support_evidence: expect.arrayContaining(["trusted_entity_family_reuse", "tag_grounding", "source_context_grounding", "template_support"]),
          }),
        }),
      ]),
    );
  });

  it("auto-applies supported ordering candidates after compacting sentence-like relation tails", async () => {
    const client = await createTestClient(clients);
    await seedOpenclawOrderingFamily(client, { id: "openclaw-ordering" });
    const llm = new MockClaimLlm(() => ({
      entity: "OpenClaw",
      attribute: "heartbeat detection precedes llm handoff",
      confidence: 0.88,
    }));

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const row = await client.execute({
      sql: "SELECT claim_key FROM durables WHERE id = ?",
      args: ["openclaw-ordering"],
    });
    const actions = await getDreamRunActions(client, result.runId);
    const run = await getLastDreamRun(client);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBe("openclaw/llm_handoff_order");
    expect(run?.summaryJson?.observations).toContain(
      "Compact canonicalization rewrote 1 missing-key candidate before auto-apply and 0 before unresolved proposal logging.",
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["openclaw-ordering"],
          details: expect.objectContaining({
            supported_auto_apply: true,
            support_class: "trusted_exact_reuse_grounded",
            claim_key_compacted_from: "openclaw/heartbeat_detection_precedes_llm_handoff",
            claim_key_compaction_reason: "collapsed a sentence-like ordering phrase into a stable order slot",
            support_evidence: expect.arrayContaining(["trusted_exact_reuse", "tag_grounding", "source_context_grounding", "attribute_lexical_alignment"]),
          }),
        }),
      ]),
    );
  });

  it("auto-applies compacted exact-reuse candidates through the post-compaction support lane", async () => {
    const client = await createTestClient(clients);
    await seedOpenclawOrderingFamily(client, { id: "openclaw-ordering-mid-confidence" });
    const llm = new MockClaimLlm(() => ({
      entity: "OpenClaw",
      attribute: "heartbeat detection precedes llm handoff",
      confidence: 0.8,
    }));

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const row = await client.execute({
      sql: "SELECT claim_key FROM durables WHERE id = ?",
      args: ["openclaw-ordering-mid-confidence"],
    });
    const actions = await getDreamRunActions(client, result.runId);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBe("openclaw/llm_handoff_order");
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["openclaw-ordering-mid-confidence"],
          details: expect.objectContaining({
            auto_apply_threshold: 0.78,
            promotion_lane: "compacted_supported",
            supported_auto_apply: true,
            support_class: "trusted_exact_reuse_grounded",
            claim_key_compacted_from: "openclaw/heartbeat_detection_precedes_llm_handoff",
          }),
        }),
      ]),
    );
  });

  it("auto-applies supported stable-slot family candidates when local grounding is strong", async () => {
    const client = await createTestClient(clients);
    await seedJimHandoffFamily(client, { id: "jim-supported-slot" });
    const llm = new MockClaimLlm(() => ({
      entity: "Jim",
      attribute: "code task handoff preference",
      confidence: 0.88,
    }));

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const row = await client.execute({
      sql: "SELECT claim_key FROM durables WHERE id = ?",
      args: ["jim-supported-slot"],
    });
    const actions = await getDreamRunActions(client, result.runId);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBe("jim/code_task_handoff_preference");
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["jim-supported-slot"],
          details: expect.objectContaining({
            supported_auto_apply: true,
            support_class: "trusted_family_stable_slot",
            support_evidence: expect.arrayContaining([
              "trusted_entity_family_reuse",
              "tag_grounding",
              "source_context_grounding",
              "attribute_lexical_alignment",
              "stable_slot_support",
            ]),
          }),
        }),
      ]),
    );
  });

  it("auto-applies stable-slot family candidates with one grounded sibling when dual lexical grounding is strong", async () => {
    const client = await createTestClient(clients);
    await seedJimSingleSiblingHandoffFamily(client);
    const llm = new MockClaimLlm(() => ({
      entity: "Jim",
      attribute: "code task handoff preference",
      confidence: 0.88,
    }));

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const row = await client.execute({
      sql: "SELECT claim_key FROM durables WHERE id = ?",
      args: ["jim-single-sibling-slot"],
    });
    const actions = await getDreamRunActions(client, result.runId);
    const run = await getLastDreamRun(client);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBe("jim/code_task_handoff_preference");
    expect(run?.summaryJson?.observations).toContain(
      "Relaxed stable-slot promotion auto-applied 1 candidate and staged 0 proposals after accepting one grounded family sibling.",
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["jim-single-sibling-slot"],
          details: expect.objectContaining({
            supported_auto_apply: true,
            support_class: "trusted_family_stable_slot",
            support_family_reuse_count: 1,
            support_grounded_family_reuse_count: 1,
            support_relaxed_stable_slot_family_gate: true,
            support_strong_entity_attribute_lexical_alignment: true,
            support_evidence: expect.arrayContaining([
              "trusted_entity_family_reuse",
              "tag_grounding",
              "source_context_grounding",
              "attribute_lexical_alignment",
              "strong_entity_attribute_lexical_alignment",
              "stable_slot_support",
              "single_grounded_family_sibling",
            ]),
          }),
        }),
      ]),
    );
  });

  it("auto-applies compacted family stable-slot candidates after compaction preserves strong support", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
      id: "mac-mini-seed-policy",
      subject: "Mac mini update policy",
      type: "fact",
      claim_key: "mac_mini/manual_update_policy",
      tags: ["ssh", "macbook", "macmini"],
      source_context: "User asked about controlling the mini from the MacBook",
      content: "Mac mini updates stay manual unless Jim explicitly asks.",
    });
    await insertDurable(client, {
      id: "mac-mini-seed-access",
      subject: "Mini MacBook ssh access",
      type: "fact",
      claim_key: "mac_mini/ssh_access_to_macbook",
      tags: ["ssh", "macbook", "macmini"],
      source_context: "User asked about controlling the mini from the MacBook",
      content: "The Mac mini can reach the MacBook over passwordless SSH.",
    });
    await insertDurable(client, {
      id: "mac-mini-supported-compacted",
      subject: "MacBook mini ssh control",
      type: "fact",
      tags: ["ssh", "macbook", "macmini"],
      source_context: "User asked about controlling the mini from the MacBook",
      content: "The MacBook can run arbitrary shell commands on the Mac mini over passwordless SSH once the key is installed.",
    });
    const llm = new MockClaimLlm(() => ({
      entity: "mac mini",
      attribute: "ssh access from macbook",
      confidence: 0.78,
    }));

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const row = await client.execute({
      sql: "SELECT claim_key FROM durables WHERE id = ?",
      args: ["mac-mini-supported-compacted"],
    });
    const actions = await getDreamRunActions(client, result.runId);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBe("mac_mini/macbook_ssh_access");
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["mac-mini-supported-compacted"],
          details: expect.objectContaining({
            auto_apply_threshold: 0.78,
            promotion_lane: "compacted_supported",
            supported_auto_apply: true,
            support_class: "trusted_family_stable_slot",
            claim_key_compacted_from: "mac_mini/ssh_access_from_macbook",
            claim_key_compaction_reason: "collapsed a trailing object phrase into a compact stable slot name",
            support_evidence: expect.arrayContaining([
              "trusted_entity_family_reuse",
              "tag_grounding",
              "source_context_grounding",
              "attribute_lexical_alignment",
              "stable_slot_support",
            ]),
          }),
        }),
      ]),
    );
  });

  it("auto-applies compacted family order candidates once the final slot re-enters stable-slot promotion", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
      id: "gateway-seed-restart",
      subject: "Gateway restart policy",
      type: "lesson",
      claim_key: "openclaw_gateway/restart_policy",
      tags: ["openclaw", "gateway", "auth"],
      source_context: "Sub-agent spawns failed after a gateway restart until re-pairing.",
      content: "Gateway restarts require a fresh session re-authentication after stale token errors.",
    });
    await insertDurable(client, {
      id: "gateway-seed-log-level",
      subject: "Gateway log level",
      type: "lesson",
      claim_key: "openclaw_gateway/log_level",
      tags: ["openclaw", "gateway", "auth"],
      source_context: "Sub-agent spawns failed after a gateway restart until re-pairing.",
      content: "Gateway troubleshooting should keep log level details visible during auth failures.",
    });
    await insertDurable(client, {
      id: "gateway-ordering",
      subject: "Gateway restart auth",
      type: "lesson",
      tags: ["openclaw", "gateway", "auth"],
      source_context: "Sub-agent spawns failed after a gateway restart until re-pairing.",
      content: "Restarting the OpenClaw gateway can leave the current session paired to a stale token until a fresh session re-authenticates.",
    });
    const llm = new MockClaimLlm(() => ({
      entity: "openclaw gateway",
      attribute: "after restart requirement",
      confidence: 0.78,
    }));

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const row = await client.execute({
      sql: "SELECT claim_key FROM durables WHERE id = ?",
      args: ["gateway-ordering"],
    });
    const actions = await getDreamRunActions(client, result.runId);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBe("openclaw_gateway/restart_requirement_order");
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["gateway-ordering"],
          details: expect.objectContaining({
            auto_apply_threshold: 0.78,
            promotion_lane: "compacted_supported",
            supported_auto_apply: true,
            support_class: "trusted_family_stable_slot",
            claim_key_compacted_from: "openclaw_gateway/after_restart_requirement",
            claim_key_compaction_reason: "collapsed a sentence-like ordering phrase into a stable order slot",
            support_evidence: expect.arrayContaining([
              "trusted_entity_family_reuse",
              "tag_grounding",
              "source_context_grounding",
              "attribute_lexical_alignment",
              "stable_slot_support",
            ]),
          }),
        }),
      ]),
    );
  });

  it("promotes template-supported architecture candidates into proposals before they are auto-safe", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
      id: "architecture-proposal",
      subject: "Core-adapter boundary",
      type: "decision",
      tags: ["architecture", "workflow"],
      source_context: "Repo operating docs describe the layering boundary",
      content: "Keep pure logic in src/core and adapters outside it so future hosts can plug in cleanly and tests stay isolated from infrastructure concerns.",
    });
    const llm = new MockClaimLlm(() => ({
      entity: "Agenr",
      attribute: "core adapter boundary",
      confidence: 0.68,
    }));

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const row = await client.execute({
      sql: "SELECT claim_key FROM durables WHERE id = ?",
      args: ["architecture-proposal"],
    });
    const proposals = await getDreamRunProposals(client, result.runId);
    const run = await getLastDreamRun(client);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBeNull();
    expect(proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueKind: "missing_claim_key",
          durableIds: ["architecture-proposal"],
          proposedClaimKeys: ["agenr/core_adapter_boundary"],
        }),
      ]),
    );
    expect(run?.summaryJson?.observations).toContain(
      "Missing-key decisions used no auto-applies and 1 supported preview proposals after structural reuse checks.",
    );
  });

  it("keeps compacted but weakly supported candidates unresolved even when compaction improves the key shape", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
      id: "snowflake-seed-policy",
      subject: "Snowflake QA policy",
      type: "fact",
      claim_key: "snowflake_dispense_workflow/qa_policy",
      tags: ["snowflake", "delivery", "qa"],
      source_context: "Described during the Snowflake system walkthrough",
      content: "The Snowflake dispense delivery flow is checked by a QA script before shipment.",
    });
    await insertDurable(client, {
      id: "snowflake-weak-compacted",
      subject: "Snowflake dispense workflow",
      type: "fact",
      tags: ["snowflake", "delivery", "qa"],
      source_context: "Described during the Snowflake system walkthrough",
      content: "The Snowflake dispense delivery flow is view-driven and is checked by a QA script before final export.",
    });
    const llm = new MockClaimLlm(() => ({
      entity: "snowflake dispense workflow",
      attribute: "qa validation before export",
      confidence: 0.82,
    }));

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const row = await client.execute({
      sql: "SELECT claim_key FROM durables WHERE id = ?",
      args: ["snowflake-weak-compacted"],
    });
    const proposals = await getDreamRunProposals(client, result.runId);
    const actions = await getDreamRunActions(client, result.runId);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBeNull();
    expect(proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueKind: "missing_claim_key",
          durableIds: ["snowflake-weak-compacted"],
          proposedClaimKeys: ["snowflake_dispense_workflow/export_order"],
        }),
      ]),
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["snowflake-weak-compacted"],
          details: expect.objectContaining({
            auto_apply_blocker: "below_auto_apply_threshold",
            auto_apply_threshold: 0.92,
            promotion_lane: "high_confidence_preview",
            supported_candidate: true,
            claim_key_compacted_from: "snowflake_dispense_workflow/qa_validation_before_export",
            claim_key_compaction_reason: "collapsed a sentence-like ordering phrase into a stable order slot",
            support_evidence: expect.arrayContaining([
              "trusted_entity_family_reuse",
              "tag_grounding",
              "source_context_grounding",
              "attribute_lexical_alignment",
              "stable_slot_support",
            ]),
          }),
        }),
      ]),
    );
  });

  it("keeps one-sibling family stable-slot candidates unresolved when local alignment is not strong enough", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
      id: "validator-seed-release-policy",
      subject: "Validator release policy",
      type: "decision",
      claim_key: "validator/release_policy",
      tags: ["validator", "release"],
      source_context: "Validator docs define the release gate",
      content: "Validator release policy requires verification before shipment.",
    });
    await insertDurable(client, {
      id: "validator-weak-single-sibling",
      subject: "Validator release export",
      type: "decision",
      tags: ["validator", "release"],
      source_context: "Validator docs define the release gate",
      content: "Validator release steps end with one export pass before shipment.",
    });
    const llm = new MockClaimLlm(() => ({
      entity: "validator",
      attribute: "export order",
      confidence: 0.88,
    }));

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const row = await client.execute({
      sql: "SELECT claim_key FROM durables WHERE id = ?",
      args: ["validator-weak-single-sibling"],
    });
    const proposals = await getDreamRunProposals(client, result.runId);
    const actions = await getDreamRunActions(client, result.runId);
    const run = await getLastDreamRun(client);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBeNull();
    expect(proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueKind: "missing_claim_key",
          durableIds: ["validator-weak-single-sibling"],
          proposedClaimKeys: ["validator/export_order"],
        }),
      ]),
    );
    expect(run?.summaryJson?.observations).not.toContain(
      "Relaxed stable-slot promotion auto-applied 1 candidate and staged 0 proposals after accepting one grounded family sibling.",
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["validator-weak-single-sibling"],
          details: expect.objectContaining({
            auto_apply_blocker: "below_auto_apply_threshold",
            auto_apply_threshold: 0.92,
            promotion_lane: "high_confidence_preview",
            supported_candidate: true,
            support_family_reuse_count: 1,
            support_grounded_family_reuse_count: 1,
            support_evidence: expect.arrayContaining([
              "trusted_entity_family_reuse",
              "tag_grounding",
              "source_context_grounding",
              "entity_lexical_alignment",
              "attribute_lexical_alignment",
              "stable_slot_support",
            ]),
          }),
        }),
      ]),
    );
    expect(actions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["validator-weak-single-sibling"],
          details: expect.objectContaining({
            support_class: "trusted_family_stable_slot",
          }),
        }),
      ]),
    );
  });
});
