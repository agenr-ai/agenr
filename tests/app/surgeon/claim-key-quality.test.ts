import { createClient, type Client } from "@libsql/client";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSurgeonPort } from "../../../src/adapters/db/surgeon-port.js";
import type { SurgeonProgressEvent } from "../../../src/app/surgeon/progress.js";
import { getLastSurgeonRun, getSurgeonRunActions, getSurgeonRunProposals } from "../../../src/adapters/db/surgeon-run-log.js";
import { initSchema } from "../../../src/adapters/db/schema.js";
import type { AgenrConfig } from "../../../src/config.js";
import type { LlmPort } from "../../../src/core/ports.js";
import type { Entry } from "../../../src/core/types.js";
import { runSurgeon } from "../../../src/app/surgeon/service.js";

const TEST_MODEL = getModel("openai", "gpt-5.4-mini");
const TEST_NOW = new Date("2026-04-04T15:00:00.000Z");

describe("claim_key_quality surgeon pass", () => {
  const clients: Client[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });

  it("discovers missing, noncanonical, suspect, mixed, and exact-key multi-active health issues", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, { id: "missing-1", subject: "Primary timezone", type: "fact" });
    await insertEntry(client, { id: "noncanonical-1", subject: "Home city", type: "fact", claim_key: " Jim / Home City " });
    await insertEntry(client, { id: "suspect-1", subject: "Project status", type: "fact", claim_key: "project/status" });
    await insertEntry(client, { id: "dup-1", subject: "Timezone old", type: "fact", claim_key: "jim/timezone" });
    await insertEntry(client, { id: "dup-2", subject: "Timezone new", type: "fact", claim_key: "jim/timezone" });
    await insertEntry(client, { id: "mixed-1", subject: "Shared policy", type: "preference", claim_key: "mac_mini/manual_update_policy" });
    await insertEntry(client, { id: "mixed-2", subject: "Shared policy", type: "preference" });

    const result = await runClaimKeyPass(client);
    const run = await getLastSurgeonRun(client);
    const summary = run?.summaryJson?.claim_key_quality;

    expect(result.status).toBe("completed");
    expect(summary?.before).toMatchObject({
      totalEntries: 7,
      missingCount: 2,
      malformedOrNoncanonicalCount: 1,
      suspectCanonicalCount: 1,
      mixedGroupCount: 1,
      exactKeyMultiActiveClusterCount: 1,
    });
  });

  it("normalizes clearly noncanonical claim keys in place and records structured action details", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, { id: "normalize-1", subject: "Home city", type: "fact", claim_key: " Jim / Home City " });

    const result = await runClaimKeyPass(client, {
      apply: true,
    });

    const row = await client.execute({
      sql: "SELECT claim_key FROM entries WHERE id = ?",
      args: ["normalize-1"],
    });

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBe("jim/home_city");
    expect(await getSurgeonRunActions(client, result.runId)).toEqual([
      expect.objectContaining({
        actionType: "update_entry",
        entryIds: ["normalize-1"],
        details: expect.objectContaining({
          issue_kind: "noncanonical_claim_key",
          old_claim_key: " Jim / Home City ",
          new_claim_key: "jim/home_city",
          proposal_source: "normalize",
          auto_applied: true,
        }),
      }),
    ]);
  });

  it("backfills only high-confidence trusted missing keys", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, { id: "backfill-hi", subject: "Timezone", type: "fact", content: "Jim's timezone is America/Chicago." });
    await insertEntry(client, { id: "backfill-lo", subject: "Employer", type: "fact", content: "Jim works at OpenAI." });
    const llm = new MockClaimLlm((callIndex) =>
      callIndex === 0 ? { entity: "Jim", attribute: "timezone", confidence: 0.96 } : { entity: "Jim", attribute: "employer", confidence: 0.62 },
    );

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const rows = await client.execute({
      sql: "SELECT id, claim_key FROM entries WHERE id IN (?, ?) ORDER BY id ASC",
      args: ["backfill-hi", "backfill-lo"],
    });
    const actions = await getSurgeonRunActions(client, result.runId);
    const run = await getLastSurgeonRun(client);
    const summary = run?.summaryJson?.claim_key_quality;

    expect(result.status).toBe("completed");
    expect(rows.rows).toEqual([
      { id: "backfill-hi", claim_key: "jim/timezone" },
      { id: "backfill-lo", claim_key: null },
    ]);
    expect(summary?.counts).toMatchObject({
      identifiedBackfills: 1,
      appliedBackfills: 1,
      skippedLowConfidence: 1,
    });
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryIds: ["backfill-hi"],
          details: expect.objectContaining({
            supported_auto_apply: false,
          }),
        }),
      ]),
    );
  });

  it("reuses a trusted same-subject canonical key before previewing a missing peer", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "trusted-group-seed",
      subject: "Mac mini update policy",
      type: "preference",
      claim_key: "mac_mini/manual_update_policy",
    });
    await insertEntry(client, {
      id: "trusted-group-missing",
      subject: "Mac mini update policy",
      type: "preference",
      content: "The Mac mini should be updated manually.",
    });

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () =>
        new MockClaimLlm(() => {
          throw new Error("trusted group reuse should avoid claim extraction preview");
        }),
    });

    const row = await client.execute({
      sql: "SELECT claim_key FROM entries WHERE id = ?",
      args: ["trusted-group-missing"],
    });
    const actions = await getSurgeonRunActions(client, result.runId);
    const run = await getLastSurgeonRun(client);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBe("mac_mini/manual_update_policy");
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryIds: ["trusted-group-missing"],
          details: expect.objectContaining({
            issue_kind: "missing_claim_key",
            new_claim_key: "mac_mini/manual_update_policy",
            proposal_source: "trusted_group_reuse",
          }),
        }),
      ]),
    );
    expect(run?.summaryJson?.observations).toContain("Missing-key decisions used 1 trusted-group reuses and no proposals after structural reuse checks.");
  });

  it("auto-applies deterministic repair previews during missing-key cleanup", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "deterministic-backfill",
      subject: "Jim's timezone",
      type: "fact",
      content: "Jim's timezone is America/Chicago.",
    });

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => new MockClaimLlm(() => new Error("preview failure forces deterministic repair")),
    });

    const row = await client.execute({
      sql: "SELECT claim_key FROM entries WHERE id = ?",
      args: ["deterministic-backfill"],
    });
    const actions = await getSurgeonRunActions(client, result.runId);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBe("jim/timezone");
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryIds: ["deterministic-backfill"],
          details: expect.objectContaining({
            issue_kind: "missing_claim_key",
            new_claim_key: "jim/timezone",
            proposal_source: "deterministic_repair",
            auto_applied: true,
          }),
        }),
      ]),
    );
  });

  it("auto-applies metadata-grounded missing-key backfills when the entity is explicitly anchored", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "metadata-backed",
      subject: "Project status",
      type: "fact",
      content: "The project is active.",
      project: "Agenr",
    });
    const llm = new MockClaimLlm(() => ({
      entity: "project",
      attribute: "status",
      confidence: 0.88,
    }));

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const row = await client.execute({
      sql: "SELECT claim_key FROM entries WHERE id = ?",
      args: ["metadata-backed"],
    });
    const actions = await getSurgeonRunActions(client, result.runId);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBe("agenr/status");
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryIds: ["metadata-backed"],
          details: expect.objectContaining({
            issue_kind: "missing_claim_key",
            new_claim_key: "agenr/status",
            proposal_source: "metadata_backfill_rewrite",
            auto_applied: true,
          }),
        }),
      ]),
    );
  });

  it("promotes metadata-grounded low-confidence missing-key candidates into structured proposals", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "metadata-proposal",
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

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const row = await client.execute({
      sql: "SELECT claim_key FROM entries WHERE id = ?",
      args: ["metadata-proposal"],
    });
    const proposals = await getSurgeonRunProposals(client, result.runId);
    const summary = (await getLastSurgeonRun(client))?.summaryJson?.claim_key_quality;

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBeNull();
    expect(proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueKind: "missing_claim_key",
          entryIds: ["metadata-proposal"],
          proposedClaimKeys: ["agenr/status"],
          source: "metadata_backfill_rewrite",
        }),
      ]),
    );
    expect(summary?.counts).toMatchObject({
      proposalsEmitted: 1,
      skippedAmbiguous: 1,
      skippedLowConfidence: 0,
    });
  });

  it("auto-applies supported mid-confidence source-of-truth candidates when trusted local grounding aligns", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "trusted-source-of-truth",
      subject: "Repo workflow source of truth",
      type: "decision",
      claim_key: "repo_workflow/source_of_truth",
      tags: ["workflow", "docs"],
      source_context: "AGENTS.md defines the repo workflow",
      content: "AGENTS.md is the source of truth for repo workflow.",
    });
    await insertEntry(client, {
      id: "supported-mid-confidence",
      subject: "Workflow authority rule",
      type: "decision",
      tags: ["workflow", "docs"],
      source_context: "AGENTS.md defines the repo workflow",
      content: "Follow AGENTS.md as the authoritative guide for repo workflow, even when older scratch notes disagree about the current process.",
    });
    const llm = new MockClaimLlm(() => ({
      entity: "repo workflow",
      attribute: "source of truth",
      confidence: 0.87,
    }));

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const row = await client.execute({
      sql: "SELECT claim_key FROM entries WHERE id = ?",
      args: ["supported-mid-confidence"],
    });
    const actions = await getSurgeonRunActions(client, result.runId);
    const run = await getLastSurgeonRun(client);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBe("repo_workflow/source_of_truth");
    expect(run?.summaryJson?.claim_key_quality?.counts).toMatchObject({
      identifiedBackfills: 1,
      appliedBackfills: 1,
    });
    expect(run?.summaryJson?.observations).toContain(
      "Missing-key decisions used 1 supported preview auto-applies and no proposals after structural reuse checks.",
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryIds: ["supported-mid-confidence"],
          details: expect.objectContaining({
            supported_auto_apply: true,
            support_class: "trusted_exact_reuse_grounded",
            support_evidence: expect.arrayContaining(["trusted_exact_reuse", "tag_grounding", "source_context_grounding", "template_support"]),
            supporting_entry_ids: ["trusted-source-of-truth"],
          }),
        }),
      ]),
    );
  });

  it("auto-applies grounded template-family candidates after safely compacting duplicated entity phrasing", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "changelog-seed-workflow",
      type: "decision",
      subject: "Changelog publish workflow",
      claim_key: "changelog/publish_workflow",
      tags: ["release", "docs"],
      source_context: "CHANGELOG.md governs release note operations",
      content: "Release notes are published from CHANGELOG.md.",
    });
    await insertEntry(client, {
      id: "changelog-seed-policy",
      type: "decision",
      subject: "Changelog archive policy",
      claim_key: "changelog/archive_policy",
      tags: ["release", "docs"],
      source_context: "CHANGELOG.md governs release note operations",
      content: "Archive old release notes only after they are copied into CHANGELOG.md.",
    });
    await insertEntry(client, {
      id: "changelog-supported",
      subject: "Release note authority",
      type: "decision",
      tags: ["release", "docs"],
      source_context: "CHANGELOG.md governs release note operations",
      content: "CHANGELOG.md is the authoritative source of truth for release notes.",
    });
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
      sql: "SELECT claim_key FROM entries WHERE id = ?",
      args: ["changelog-supported"],
    });
    const actions = await getSurgeonRunActions(client, result.runId);
    const run = await getLastSurgeonRun(client);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBe("changelog/source_of_truth");
    expect(run?.summaryJson?.observations).toContain(
      "Compact canonicalization rewrote 1 missing-key candidate before auto-apply and 0 before unresolved proposal logging.",
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryIds: ["changelog-supported"],
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
    await insertEntry(client, {
      id: "openclaw-seed-order",
      subject: "LLM handoff order seed",
      type: "decision",
      claim_key: "openclaw/llm_handoff_order",
      tags: ["openclaw", "workflow"],
      source_context: "OpenClaw runtime docs define hook ordering",
      content: "OpenClaw keeps heartbeat detection ahead of LLM handoff.",
    });
    await insertEntry(client, {
      id: "openclaw-seed-contract",
      subject: "Memory surface contract",
      type: "decision",
      claim_key: "openclaw/memory_surface_contract",
      tags: ["openclaw", "workflow"],
      source_context: "OpenClaw runtime docs define hook ordering",
      content: "OpenClaw exposes a stable memory surface contract to the host.",
    });
    await insertEntry(client, {
      id: "openclaw-ordering",
      subject: "Heartbeat handoff ordering",
      type: "decision",
      tags: ["openclaw", "workflow"],
      source_context: "OpenClaw runtime docs define hook ordering",
      content: "Heartbeat detection should happen before LLM handoff in OpenClaw.",
    });
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
      sql: "SELECT claim_key FROM entries WHERE id = ?",
      args: ["openclaw-ordering"],
    });
    const actions = await getSurgeonRunActions(client, result.runId);
    const run = await getLastSurgeonRun(client);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBe("openclaw/llm_handoff_order");
    expect(run?.summaryJson?.observations).toContain(
      "Compact canonicalization rewrote 1 missing-key candidate before auto-apply and 0 before unresolved proposal logging.",
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryIds: ["openclaw-ordering"],
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

  it("auto-applies supported stable-slot family candidates when local grounding is strong", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "jim-seed-workspace",
      subject: "Jim workspace",
      type: "preference",
      claim_key: "jim/primary_workspace",
      tags: ["workflow", "handoff"],
      source_context: "Jim workflow guide",
      content: "Jim's primary workspace is the agenr repo.",
    });
    await insertEntry(client, {
      id: "jim-seed-review",
      subject: "Jim review preference",
      type: "preference",
      claim_key: "jim/code_review_preference",
      tags: ["workflow", "handoff"],
      source_context: "Jim workflow guide",
      content: "Jim prefers short review loops before handoffs.",
    });
    await insertEntry(client, {
      id: "jim-supported-slot",
      subject: "Jim handoff preference",
      type: "preference",
      tags: ["workflow", "handoff"],
      source_context: "Jim workflow guide",
      content: "Jim prefers a code task handoff note before work changes owners.",
    });
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
      sql: "SELECT claim_key FROM entries WHERE id = ?",
      args: ["jim-supported-slot"],
    });
    const actions = await getSurgeonRunActions(client, result.runId);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBe("jim/code_task_handoff_preference");
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryIds: ["jim-supported-slot"],
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

  it("promotes template-supported architecture candidates into proposals before they are auto-safe", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
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
      sql: "SELECT claim_key FROM entries WHERE id = ?",
      args: ["architecture-proposal"],
    });
    const proposals = await getSurgeonRunProposals(client, result.runId);
    const run = await getLastSurgeonRun(client);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBeNull();
    expect(proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueKind: "missing_claim_key",
          entryIds: ["architecture-proposal"],
          proposedClaimKeys: ["agenr/core_adapter_boundary"],
        }),
      ]),
    );
    expect(run?.summaryJson?.observations).toContain(
      "Missing-key decisions used no auto-applies and 1 supported preview proposals after structural reuse checks.",
    );
  });

  it("does not treat dirty or suspect corpus keys as trusted reuse canon", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "dirty-group-seed",
      subject: "Project status",
      type: "fact",
      claim_key: "project/status",
      content: "The project is active.",
      tags: ["workflow", "docs"],
      source_context: "AGENTS.md defines the repo workflow",
    });
    await insertEntry(client, {
      id: "dirty-group-missing",
      subject: "Project status",
      type: "fact",
      content: "The project is healthy.",
      tags: ["workflow", "docs"],
      source_context: "AGENTS.md defines the repo workflow",
    });

    const result = await runClaimKeyPass(client, {
      apply: true,
    });

    const row = await client.execute({
      sql: "SELECT claim_key FROM entries WHERE id = ?",
      args: ["dirty-group-missing"],
    });
    const actions = await getSurgeonRunActions(client, result.runId);
    const summary = (await getLastSurgeonRun(client))?.summaryJson?.claim_key_quality;

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBeNull();
    expect(actions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryIds: ["dirty-group-missing"],
          details: expect.objectContaining({
            proposal_source: "trusted_group_reuse",
          }),
        }),
      ]),
    );
    expect(summary?.counts).toMatchObject({
      skippedNoClaim: 1,
      identifiedBackfills: 0,
      appliedBackfills: 0,
    });
  });

  it("does not trust dirty claim keys just because tags or source_context overlap", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "dirty-tagged-seed",
      subject: "Repo workflow details",
      type: "decision",
      claim_key: "repo_workflow/details",
      tags: ["workflow", "docs"],
      source_context: "AGENTS.md defines the repo workflow",
    });
    await insertEntry(client, {
      id: "clean-seed",
      subject: "Timezone seed",
      type: "fact",
      claim_key: "jim/timezone",
    });
    await insertEntry(client, {
      id: "dirty-tagged-missing",
      subject: "Repo workflow",
      type: "decision",
      tags: ["workflow", "docs"],
      source_context: "AGENTS.md defines the repo workflow",
      content: "AGENTS.md is the authoritative guide for repo workflow.",
    });
    const llm = new MockClaimLlm((_callIndex, systemPrompt) => {
      expect(systemPrompt).not.toContain("repo_workflow/details");
      return {
        no_claim: true,
        confidence: 0.2,
      };
    });

    await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });
  });

  it("does not auto-apply unsupported mid-confidence previews recklessly", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "plain-mid-confidence",
      subject: "Clinic visit planning note",
      type: "decision",
      content: "We talked through several ways clinic visits might be scheduled in the future.",
    });
    const llm = new MockClaimLlm(() => ({
      entity: "clinic_visits",
      attribute: "default_mode",
      confidence: 0.88,
    }));

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const row = await client.execute({
      sql: "SELECT claim_key FROM entries WHERE id = ?",
      args: ["plain-mid-confidence"],
    });
    const proposals = await getSurgeonRunProposals(client, result.runId);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBeNull();
    expect(proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryIds: ["plain-mid-confidence"],
          proposedClaimKeys: ["clinic_visits/default_mode"],
        }),
      ]),
    );
  });

  it("keeps supported cross-type collisions unresolved instead of auto-applying them", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "validator-fact-seed",
      subject: "Validator verification policy",
      type: "fact",
      claim_key: "validator/verification_policy",
      tags: ["validator", "policy"],
      source_context: "Validator docs define the release gate",
      content: "Validator policy requires verification before release.",
    });
    await insertEntry(client, {
      id: "validator-family-seed",
      subject: "Validator default mode",
      type: "decision",
      claim_key: "validator/default_mode",
      tags: ["validator", "policy"],
      source_context: "Validator docs define the release gate",
      content: "Validator defaults to strict mode.",
    });
    await insertEntry(client, {
      id: "validator-missing",
      subject: "Validator verification rule",
      type: "decision",
      tags: ["validator", "policy"],
      source_context: "Validator docs define the release gate",
      content: "Validator policy requires verification before release.",
    });
    const llm = new MockClaimLlm(() => ({
      entity: "validator",
      attribute: "verification policy",
      confidence: 0.88,
    }));

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const row = await client.execute({
      sql: "SELECT claim_key FROM entries WHERE id = ?",
      args: ["validator-missing"],
    });
    const proposals = await getSurgeonRunProposals(client, result.runId);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBeNull();
    expect(proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueKind: "missing_claim_key",
          entryIds: ["validator-missing", "validator-fact-seed"],
          proposedClaimKeys: ["validator/verification_policy"],
        }),
      ]),
    );
  });

  it("keeps awkward supported candidates unresolved when compact canonicalization is still semantically ambiguous", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "changelog-family-workflow",
      subject: "Changelog publish workflow",
      type: "decision",
      claim_key: "changelog/publish_workflow",
      tags: ["release", "docs"],
      source_context: "CHANGELOG.md governs release note operations",
      content: "Release notes are published from CHANGELOG.md.",
    });
    await insertEntry(client, {
      id: "changelog-family-policy",
      subject: "Changelog archive policy",
      type: "decision",
      claim_key: "changelog/archive_policy",
      tags: ["release", "docs"],
      source_context: "CHANGELOG.md governs release note operations",
      content: "Archive old release notes only after they are copied into CHANGELOG.md.",
    });
    await insertEntry(client, {
      id: "changelog-awkward",
      subject: "Release note authority",
      type: "decision",
      tags: ["release", "docs"],
      source_context: "CHANGELOG.md governs release note operations",
      content: "CHANGELOG.md is the authoritative source of truth for release notes.",
    });
    const llm = new MockClaimLlm(() => ({
      entity: "changelog",
      attribute: "authoritative source of truth and archive workflow for release notes",
      confidence: 0.89,
    }));

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const row = await client.execute({
      sql: "SELECT claim_key FROM entries WHERE id = ?",
      args: ["changelog-awkward"],
    });
    const actions = await getSurgeonRunActions(client, result.runId);
    const proposals = await getSurgeonRunProposals(client, result.runId);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBeNull();
    expect(proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueKind: "missing_claim_key",
          entryIds: ["changelog-awkward"],
          proposedClaimKeys: ["changelog/authoritative_source_of_truth_and_archive_workflow_for_release_notes"],
        }),
      ]),
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryIds: ["changelog-awkward"],
          details: expect.objectContaining({
            supported_candidate: true,
            support_class: "trusted_family_template_grounded",
            auto_apply_blocker: "non_compact_canonical_slot",
          }),
        }),
      ]),
    );
  });

  it("preloads missing-key previews with bounded concurrency and keeps collision decisions deterministic when previews resolve out of order", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, { id: "a-shared-fact", subject: "Shared slot fact", type: "fact", content: "The shared slot is active." });
    await insertEntry(client, { id: "b-shared-decision", subject: "Shared slot decision", type: "decision", content: "Decision: the shared slot is active." });
    await insertEntry(client, { id: "unique-fact", subject: "Unique timezone", type: "fact", content: "Jim's timezone is America/Chicago." });

    const pending = new Map<string, { resolve: (value: unknown) => void }>();
    const startedSubjects: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const responder = (_callIndex: number, _systemPrompt: string, userMessage: string) => {
      const subject = /Subject: (.+)/u.exec(userMessage)?.[1] ?? userMessage;
      startedSubjects.push(subject);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);

      return new Promise((resolve) => {
        pending.set(subject, {
          resolve: (value) => {
            inFlight -= 1;
            resolve(value);
          },
        });
      });
    };

    const runPromise = runClaimKeyPass(client, {
      apply: true,
      config: {
        claimExtraction: {
          concurrency: 2,
        },
      },
      createClaimExtractionLlm: () => new MockClaimLlm(responder),
    });

    await vi.waitFor(() => {
      expect(startedSubjects).toHaveLength(2);
      expect(startedSubjects).toEqual(expect.arrayContaining(["Shared slot fact", "Shared slot decision"]));
    });
    expect(maxInFlight).toBe(2);

    pending.get("Shared slot decision")?.resolve({
      entity: "shared",
      attribute: "status",
      confidence: 0.97,
    });

    await vi.waitFor(() => {
      expect(startedSubjects).toContain("Unique timezone");
    });

    pending.get("Unique timezone")?.resolve({
      entity: "Jim",
      attribute: "timezone",
      confidence: 0.97,
    });
    pending.get("Shared slot fact")?.resolve({
      entity: "shared",
      attribute: "status",
      confidence: 0.97,
    });

    const result = await runPromise;
    const rows = await client.execute({
      sql: "SELECT id, claim_key FROM entries WHERE id IN (?, ?, ?) ORDER BY id ASC",
      args: ["a-shared-fact", "b-shared-decision", "unique-fact"],
    });
    const proposals = await getSurgeonRunProposals(client, result.runId);

    expect(result.status).toBe("completed");
    expect(maxInFlight).toBe(2);
    expect(rows.rows).toEqual([
      { id: "a-shared-fact", claim_key: "shared/status" },
      { id: "b-shared-decision", claim_key: null },
      { id: "unique-fact", claim_key: "jim/timezone" },
    ]);
    expect(proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueKind: "missing_claim_key",
          entryIds: ["b-shared-decision", "a-shared-fact"],
          proposedClaimKeys: ["shared/status"],
        }),
      ]),
    );
  });

  it("emits a structured unresolved proposal instead of normalizing into an occupied canonical key", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, { id: "occupied", subject: "Home city canonical", type: "fact", claim_key: "jim/home_city" });
    await insertEntry(client, { id: "collision", subject: "Home city legacy", type: "fact", claim_key: " Jim / Home City " });

    const result = await runClaimKeyPass(client, {
      apply: true,
    });
    const proposals = await getSurgeonRunProposals(client, result.runId);
    const row = await client.execute({
      sql: "SELECT claim_key FROM entries WHERE id = ?",
      args: ["collision"],
    });

    expect(row.rows[0]?.claim_key).toBe(" Jim / Home City ");
    expect(proposals).toEqual([
      expect.objectContaining({
        issueKind: "noncanonical_claim_key",
        entryIds: ["collision"],
        currentClaimKeys: ["Jim / Home City"],
        proposedClaimKeys: ["jim/home_city"],
        scope: "single_entry",
        eligibleForApply: true,
      }),
    ]);
  });

  it("emits suspect-but-canonical proposals instead of mutating ambiguous generic keys", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, { id: "suspect", subject: "Project status", type: "fact", claim_key: "project/status", content: "The project is active." });
    const llm = new MockClaimLlm(() => ({
      entity: "Agenr",
      attribute: "status",
      confidence: 0.88,
    }));

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });
    const proposals = await getSurgeonRunProposals(client, result.runId);
    const row = await client.execute({
      sql: "SELECT claim_key FROM entries WHERE id = ?",
      args: ["suspect"],
    });

    expect(row.rows[0]?.claim_key).toBe("project/status");
    expect(proposals).toEqual([
      expect.objectContaining({
        issueKind: "suspect_canonical_claim_key",
        entryIds: ["suspect"],
        currentClaimKeys: ["project/status"],
        proposedClaimKeys: ["agenr/status"],
      }),
    ]);
  });

  it("emits mixed-key group proposals with durable required fields", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, { id: "mixed-a", subject: "Mac mini update policy", type: "preference", claim_key: "mac_mini/manual_update_policy" });
    await insertEntry(client, { id: "mixed-b", subject: "Mac mini update policy", type: "preference", claim_key: "mac_mini/update_window" });

    const result = await runClaimKeyPass(client);
    const proposal = (await getSurgeonRunProposals(client, result.runId)).find((item) => item.issueKind === "mixed_claim_key_group");

    expect(proposal).toMatchObject({
      runId: result.runId,
      issueKind: "mixed_claim_key_group",
      scope: "cluster",
      entryIds: ["mixed-a", "mixed-b"],
      currentClaimKeys: ["mac_mini/manual_update_policy", "mac_mini/update_window"],
      confidence: expect.any(Number),
      source: expect.any(String),
      rationale: expect.any(String),
      eligibleForApply: false,
    });
    expect(typeof proposal?.id).toBe("string");
    expect(typeof proposal?.groupId).toBe("string");
  });

  it("uses trusted cleanup hints only and does not propagate same-run repairs into later hints", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, { id: "trusted-seed", subject: "Timezone seed", type: "fact", claim_key: "jim/timezone" });
    await insertEntry(client, { id: "bad-seed-1", subject: "Project details", type: "fact", claim_key: "project/details" });
    await insertEntry(client, { id: "bad-seed-2", subject: "Legacy home city", type: "fact", claim_key: " Jim / Home City " });
    await insertEntry(client, { id: "missing-1", subject: "Status one", type: "fact", content: "The project is active." });
    await insertEntry(client, { id: "missing-2", subject: "Status two", type: "fact", content: "The project is healthy." });
    const llm = new MockClaimLlm((callIndex, systemPrompt) => {
      if (callIndex === 0) {
        expect(systemPrompt).toContain("jim/timezone");
        expect(systemPrompt).not.toContain("project/details");
        expect(systemPrompt).not.toContain(" Jim / Home City ");
        return { entity: "project", attribute: "status", confidence: 0.96 };
      }

      expect(systemPrompt).toContain("jim/timezone");
      expect(systemPrompt).not.toContain("project/status");
      return { entity: "Jim", attribute: "health_status", confidence: 0.95 };
    });

    await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });
  });

  it("trips the anomaly breaker on pathological convergence onto one claim key", async () => {
    const client = await createTestClient(clients);
    for (let index = 0; index < 26; index += 1) {
      await insertEntry(client, {
        id: `concentrated-${index}`,
        subject: `Timezone ${index}`,
        type: "fact",
        content: `Jim's timezone note ${index}.`,
      });
    }
    const llm = new MockClaimLlm(() => ({
      entity: "Jim",
      attribute: "timezone",
      confidence: 0.97,
    }));

    const result = await runClaimKeyPass(client, {
      createClaimExtractionLlm: () => llm,
    });
    const summary = (await getLastSurgeonRun(client))?.summaryJson?.claim_key_quality;

    expect(result.status).toBe("failed");
    expect(summary?.circuitBreaker).toMatchObject({
      kind: "claim_key_concentration",
    });
  });

  it("persists per-entry missing-key skip diagnostics for tuning follow-up", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "skip-no-claim",
      subject: "Retrospective story",
      type: "lesson",
      content: "We chased several hypotheses and eventually recovered after a long debugging session.",
    });
    await insertEntry(client, {
      id: "skip-malformed",
      subject: "Workflow planning",
      type: "decision",
      content: "We discussed several workflow options without deciding on a stable policy.",
    });
    await insertEntry(client, {
      id: "skip-rejected",
      subject: "Project details",
      type: "fact",
      content: "Project X uses blue-green deploys.",
    });
    await insertEntry(client, {
      id: "skip-low-confidence",
      subject: "Employer note",
      type: "fact",
      content: "Jim works at OpenAI.",
    });
    const attemptsBySubject = new Map<string, number>();
    const llm = new MockClaimLlm((_callIndex, _systemPrompt, userMessage) => {
      const subject = /Subject: (.+)/u.exec(userMessage)?.[1] ?? userMessage;
      const attempts = (attemptsBySubject.get(subject) ?? 0) + 1;
      attemptsBySubject.set(subject, attempts);

      if (subject === "Retrospective story") {
        return { no_claim: true, confidence: 0.24 };
      }

      if (subject === "Workflow planning") {
        return new Error("Unexpected token 'w' in JSON at position 1");
      }

      if (subject === "Project details") {
        return { entity: "Project X", attribute: "details", confidence: 0.88 };
      }

      return { entity: "Jim", attribute: "employer", confidence: 0.62 };
    });

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const summary = (await getLastSurgeonRun(client))?.summaryJson;

    expect(result.status).toBe("completed");
    expect(summary?.entries_skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entry_id: "skip-no-claim",
          reason: expect.stringContaining("missing_claim_key:no_claim"),
        }),
        expect.objectContaining({
          entry_id: "skip-malformed",
          reason: expect.stringContaining("missing_claim_key:malformed_output"),
        }),
        expect.objectContaining({
          entry_id: "skip-rejected",
          reason: expect.stringContaining("missing_claim_key:rejected_candidate"),
        }),
        expect.objectContaining({
          entry_id: "skip-low-confidence",
          reason: expect.stringContaining("missing_claim_key:low_confidence_candidate"),
        }),
      ]),
    );
    expect(summary?.entries_skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entry_id: "skip-rejected",
          reason: expect.stringContaining("warning="),
        }),
        expect.objectContaining({
          entry_id: "skip-low-confidence",
          reason: expect.stringContaining("confidence=0.62"),
        }),
      ]),
    );
  });

  it("allows a larger distributed cleanup batch without tiny-run throttling", async () => {
    const client = await createTestClient(clients);
    for (let index = 0; index < 12; index += 1) {
      await insertEntry(client, {
        id: `distributed-${index}`,
        subject: `Slot ${index}`,
        type: "fact",
        content: `Fact ${index}.`,
      });
    }
    const llm = new MockClaimLlm((callIndex) => ({
      entity: `entity_${callIndex}`,
      attribute: `attribute_${callIndex}`,
      confidence: 0.97,
    }));

    const result = await runClaimKeyPass(client, {
      createClaimExtractionLlm: () => llm,
    });
    const summary = (await getLastSurgeonRun(client))?.summaryJson?.claim_key_quality;

    expect(result.status).toBe("completed");
    expect(summary?.circuitBreaker).toBeNull();
    expect(summary?.counts.identifiedBackfills).toBe(12);
  });

  it("emits structured progress snapshots for deterministic claim-key cleanup stages", async () => {
    const client = await createTestClient(clients);
    const progress: SurgeonProgressEvent[] = [];
    await insertEntry(client, { id: "normalize-1", subject: "Home city", type: "fact", claim_key: " Jim / Home City " });
    await insertEntry(client, { id: "backfill-1", subject: "Timezone", type: "fact", content: "Jim's timezone is America/Chicago." });
    await insertEntry(client, { id: "suspect-1", subject: "Project status", type: "fact", claim_key: "project/status", content: "The project is active." });
    await insertEntry(client, { id: "mixed-a", subject: "Mac mini update policy", type: "preference", claim_key: "mac_mini/manual_update_policy" });
    await insertEntry(client, { id: "mixed-b", subject: "Mac mini update policy", type: "preference", claim_key: "mac_mini/update_window" });
    const llm = new MockClaimLlm((callIndex) =>
      callIndex === 0 ? { entity: "Jim", attribute: "timezone", confidence: 0.96 } : { entity: "Agenr", attribute: "status", confidence: 0.88 },
    );

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
      reportProgress: (event) => progress.push(event),
    });

    expect(result.status).toBe("completed");
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "phase", phase: "load_working_set_complete", workingSetSize: 5 }),
        expect.objectContaining({ kind: "phase", phase: "pass_start", passType: "claim_key_quality" }),
        expect.objectContaining({
          kind: "claim_key_quality_progress",
          stage: "health",
          status: "snapshot",
          health: expect.objectContaining({
            malformedOrNoncanonicalCount: 1,
            missingCount: 1,
            suspectCanonicalCount: 1,
            mixedGroupCount: 1,
          }),
        }),
        expect.objectContaining({ kind: "claim_key_quality_progress", stage: "invalid_noncanonical", status: "started", total: 1 }),
        expect.objectContaining({
          kind: "claim_key_quality_progress",
          stage: "invalid_noncanonical",
          status: "completed",
          counts: expect.objectContaining({
            appliedNormalizations: 1,
          }),
        }),
        expect.objectContaining({
          kind: "claim_key_quality_progress",
          stage: "missing",
          status: "started",
          previewQueued: 1,
          previewTotal: 1,
          previewConcurrency: 10,
        }),
        expect.objectContaining({
          kind: "claim_key_quality_progress",
          stage: "missing",
          status: "preview_progress",
          previewCompleted: 1,
          previewTotal: 1,
          completed: 0,
        }),
        expect.objectContaining({ kind: "claim_key_quality_progress", stage: "missing", status: "completed" }),
        expect.objectContaining({
          kind: "claim_key_quality_progress",
          stage: "suspect_canonical",
          status: "started",
          previewQueued: 1,
          previewTotal: 1,
        }),
        expect.objectContaining({
          kind: "claim_key_quality_progress",
          stage: "suspect_canonical",
          status: "completed",
          counts: expect.objectContaining({
            appliedBackfills: 1,
            proposalsEmitted: 1,
          }),
        }),
        expect.objectContaining({
          kind: "claim_key_quality_progress",
          stage: "mixed_key_groups",
          status: "completed",
          total: 1,
          unitLabel: "groups",
          counts: expect.objectContaining({
            proposalsEmitted: 2,
          }),
        }),
      ]),
    );
  });
});

async function runClaimKeyPass(
  client: Client,
  overrides: {
    apply?: boolean;
    verbose?: boolean;
    config?: AgenrConfig | null;
    createClaimExtractionLlm?: () => LlmPort & { metadata?: { usage?: { inputTokens?: number; outputTokens?: number; totalCost?: number } } };
    reportProgress?: (event: SurgeonProgressEvent) => void;
  } = {},
) {
  return runSurgeon(
    {
      pass: "claim_key_quality",
      budget: 10,
      contextLimit: 4_096,
      apply: overrides.apply === true,
      verbose: overrides.verbose === true,
      json: false,
    },
    {
      port: createSurgeonPort(client),
      config: overrides.config ?? null,
      model: TEST_MODEL,
      now: () => TEST_NOW,
      createClaimExtractionLlm: overrides.createClaimExtractionLlm,
      reportProgress: overrides.reportProgress,
    },
  );
}

async function createTestClient(clients: Client[]): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  await initSchema(client);
  return client;
}

async function insertEntry(client: Client, overrides: Partial<Entry> & Pick<Entry, "id" | "subject">): Promise<void> {
  const entry = buildEntry(overrides);
  await client.execute({
    sql: `
      INSERT INTO entries (
        id,
        type,
        subject,
        content,
        importance,
        expiry,
        tags,
        source_file,
        source_context,
        embedding,
        content_hash,
        norm_content_hash,
        minhash_sig,
        quality_score,
        recall_count,
        last_recalled_at,
        superseded_by,
        valid_from,
        valid_to,
        claim_key,
        supersession_kind,
        supersession_reason,
        cluster_id,
        user_id,
        project,
        retired,
        retired_at,
        retired_reason,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      entry.id,
      entry.type,
      entry.subject,
      entry.content,
      entry.importance,
      entry.expiry,
      JSON.stringify(entry.tags),
      entry.source_file ?? null,
      entry.source_context ?? null,
      null,
      entry.content_hash ?? null,
      entry.norm_content_hash ?? null,
      null,
      entry.quality_score,
      entry.recall_count,
      entry.last_recalled_at ?? null,
      entry.superseded_by ?? null,
      entry.valid_from ?? null,
      entry.valid_to ?? null,
      entry.claim_key ?? null,
      entry.supersession_kind ?? null,
      entry.supersession_reason ?? null,
      entry.cluster_id ?? null,
      entry.user_id ?? null,
      entry.project ?? null,
      entry.retired ? 1 : 0,
      entry.retired_at ?? null,
      entry.retired_reason ?? null,
      entry.created_at,
      entry.updated_at,
    ],
  });
}

function buildEntry(overrides: Partial<Entry> & Pick<Entry, "id" | "subject">): Entry {
  return {
    id: overrides.id,
    type: overrides.type ?? "fact",
    subject: overrides.subject,
    content: overrides.content ?? overrides.subject,
    importance: overrides.importance ?? 5,
    expiry: overrides.expiry ?? "permanent",
    tags: overrides.tags ?? [],
    source_file: overrides.source_file,
    source_context: overrides.source_context,
    embedding: undefined,
    content_hash: overrides.content_hash,
    norm_content_hash: overrides.norm_content_hash,
    quality_score: overrides.quality_score ?? 0.5,
    recall_count: overrides.recall_count ?? 0,
    last_recalled_at: overrides.last_recalled_at,
    superseded_by: overrides.superseded_by,
    valid_from: overrides.valid_from,
    valid_to: overrides.valid_to,
    claim_key: overrides.claim_key,
    supersession_kind: overrides.supersession_kind,
    supersession_reason: overrides.supersession_reason,
    cluster_id: overrides.cluster_id,
    user_id: overrides.user_id,
    project: overrides.project,
    retired: overrides.retired ?? false,
    retired_at: overrides.retired_at,
    retired_reason: overrides.retired_reason,
    created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-01-01T00:00:00.000Z",
  };
}

class MockClaimLlm implements LlmPort {
  public readonly metadata = {
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
    },
  };

  public constructor(private readonly responder: (callIndex: number, systemPrompt: string, userMessage: string) => unknown) {}

  public async complete(): Promise<string> {
    throw new Error("complete() is not used in these tests.");
  }

  public async completeJson<T>(systemPrompt: string, userMessage: string): Promise<T> {
    const callIndex = this.metadata.usage.inputTokens;
    this.metadata.usage.inputTokens += 1;
    const response = this.responder(callIndex, systemPrompt, userMessage);
    if (response instanceof Error) {
      throw response;
    }

    return response as T;
  }
}
