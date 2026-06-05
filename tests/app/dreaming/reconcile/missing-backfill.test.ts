import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { createTestClient, insertDurable, MockClaimLlm, runClaimKeyPass } from "../../../helpers/dreaming-reconcile.js";

import { getLastDreamRun, getDreamRunActions, getDreamRunProposals } from "../../../../src/adapters/db/dreaming-run-log.js";

describe("reconcile dreaming pass - missing backfill", () => {
  const clients: Client[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });

  it("backfills only high-confidence trusted missing keys", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, { id: "backfill-hi", subject: "Timezone", type: "fact", content: "Jim's timezone is America/Chicago." });
    await insertDurable(client, { id: "backfill-lo", subject: "Employer", type: "fact", content: "Jim works at OpenAI." });
    const llm = new MockClaimLlm((callIndex) =>
      callIndex === 0 ? { entity: "Jim", attribute: "timezone", confidence: 0.96 } : { entity: "Jim", attribute: "employer", confidence: 0.62 },
    );

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const rows = await client.execute({
      sql: "SELECT id, claim_key FROM durables WHERE id IN (?, ?) ORDER BY id ASC",
      args: ["backfill-hi", "backfill-lo"],
    });
    const actions = await getDreamRunActions(client, result.runId);
    const run = await getLastDreamRun(client);
    const summary = run?.summaryJson?.reconcile;

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
          durableIds: ["backfill-hi"],
          details: expect.objectContaining({
            supported_auto_apply: false,
          }),
        }),
      ]),
    );
  });

  it("reuses a trusted same-subject canonical key before previewing a missing peer", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
      id: "trusted-group-seed",
      subject: "Mac mini update policy",
      type: "preference",
      claim_key: "mac_mini/manual_update_policy",
    });
    await insertDurable(client, {
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
      sql: "SELECT claim_key, claim_key_status, claim_key_source FROM durables WHERE id = ?",
      args: ["trusted-group-missing"],
    });
    const actions = await getDreamRunActions(client, result.runId);
    const run = await getLastDreamRun(client);

    expect(result.status).toBe("completed");
    expect(row.rows[0]).toMatchObject({
      claim_key: "mac_mini/manual_update_policy",
      claim_key_status: "trusted",
      claim_key_source: "dreaming_reconcile",
    });
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["trusted-group-missing"],
          details: expect.objectContaining({
            issue_kind: "missing_claim_key",
            new_claim_key: "mac_mini/manual_update_policy",
            claim_key_status: "trusted",
            claim_key_source: "dreaming_reconcile",
            proposal_source: "trusted_group_reuse",
          }),
        }),
      ]),
    );
    expect(run?.summaryJson?.observations).toContain("Missing-key decisions used 1 trusted-group reuses and no proposals after structural reuse checks.");
  });

  it("auto-applies deterministic repair previews during missing-key cleanup", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
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
      sql: "SELECT claim_key, claim_key_status, claim_key_source, claim_key_rationale FROM durables WHERE id = ?",
      args: ["deterministic-backfill"],
    });
    const actions = await getDreamRunActions(client, result.runId);

    expect(result.status).toBe("completed");
    expect(row.rows[0]).toMatchObject({
      claim_key: "jim/timezone",
      claim_key_status: "tentative",
      claim_key_source: "deterministic_repair",
    });
    expect(String(row.rows[0]?.claim_key_rationale)).toMatch(/deterministic/i);
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["deterministic-backfill"],
          details: expect.objectContaining({
            issue_kind: "missing_claim_key",
            new_claim_key: "jim/timezone",
            claim_key_status: "tentative",
            claim_key_source: "deterministic_repair",
            proposal_source: "deterministic_repair",
            auto_applied: true,
          }),
        }),
      ]),
    );
  });

  it("auto-applies metadata-grounded missing-key backfills when the entity is explicitly anchored", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
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
      sql: "SELECT claim_key, claim_key_raw, claim_key_status, claim_key_source FROM durables WHERE id = ?",
      args: ["metadata-backed"],
    });
    const actions = await getDreamRunActions(client, result.runId);

    expect(result.status).toBe("completed");
    expect(row.rows[0]).toMatchObject({
      claim_key: "agenr/status",
      claim_key_raw: "project/status",
      claim_key_status: "trusted",
      claim_key_source: "dreaming_reconcile",
    });
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["metadata-backed"],
          details: expect.objectContaining({
            issue_kind: "missing_claim_key",
            new_claim_key: "agenr/status",
            claim_key_raw: "project/status",
            claim_key_status: "trusted",
            claim_key_source: "dreaming_reconcile",
            proposal_source: "metadata_backfill_rewrite",
            auto_applied: true,
          }),
        }),
      ]),
    );
  });

  it("promotes metadata-grounded low-confidence missing-key candidates into structured proposals", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
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
      sql: "SELECT claim_key FROM durables WHERE id = ?",
      args: ["metadata-proposal"],
    });
    const proposals = await getDreamRunProposals(client, result.runId);
    const summary = (await getLastDreamRun(client))?.summaryJson?.reconcile;

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBeNull();
    expect(proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueKind: "missing_claim_key",
          durableIds: ["metadata-proposal"],
          proposedClaimKeys: ["agenr/status"],
          source: "metadata_backfill_rewrite",
        }),
      ]),
    );
    expect(proposals[0]?.rationale).toContain("The entry stays unchanged until review.");
    expect(proposals[0]?.rationale).toContain('claim_key_status "trusted"');
    expect(proposals[0]?.rationale).toContain('claim_key_source "dreaming_reconcile"');
    expect(proposals[0]?.rationale).toContain('claim_key_raw "project/status"');
    expect(await getDreamRunActions(client, result.runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["metadata-proposal"],
          details: expect.objectContaining({
            proposal_deferred_until_review: true,
            proposal_claim_key_status: "trusted",
            proposal_claim_key_source: "dreaming_reconcile",
            proposal_claim_key_raw: "project/status",
          }),
        }),
      ]),
    );
    expect(summary?.counts).toMatchObject({
      proposalsEmitted: 1,
      flaggedAmbiguousProposals: 1,
      skippedLowConfidence: 0,
    });
  });

  it("auto-applies supported mid-confidence source-of-truth candidates when trusted local grounding aligns", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
      id: "trusted-source-of-truth",
      subject: "Repo workflow source of truth",
      type: "decision",
      claim_key: "repo_workflow/source_of_truth",
      tags: ["workflow", "docs"],
      source_context: "AGENTS.md defines the repo workflow",
      content: "AGENTS.md is the source of truth for repo workflow.",
    });
    await insertDurable(client, {
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
      sql: "SELECT claim_key FROM durables WHERE id = ?",
      args: ["supported-mid-confidence"],
    });
    const actions = await getDreamRunActions(client, result.runId);
    const run = await getLastDreamRun(client);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBe("repo_workflow/source_of_truth");
    expect(run?.summaryJson?.reconcile?.counts).toMatchObject({
      identifiedBackfills: 1,
      appliedBackfills: 1,
    });
    expect(run?.summaryJson?.observations).toContain(
      "Missing-key decisions used 1 supported preview auto-applies and no proposals after structural reuse checks.",
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["supported-mid-confidence"],
          details: expect.objectContaining({
            supported_auto_apply: true,
            support_class: "trusted_exact_reuse_grounded",
            support_evidence: expect.arrayContaining(["trusted_exact_reuse", "tag_grounding", "source_context_grounding", "template_support"]),
            supporting_durable_ids: ["trusted-source-of-truth"],
          }),
        }),
      ]),
    );
  });

  it("auto-applies grounded-family aligned candidates through the supported lane instead of the plain high-confidence lane", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
      id: "jim-seed-planning-rhythm",
      subject: "Jim planning rhythm",
      type: "preference",
      claim_key: "jim/weekly_planning_rhythm",
      tags: ["workflow", "handoff"],
      source_context: "Jim workflow guide",
      content: "Jim plans weekly work in a short rhythm with explicit task checkpoints.",
    });
    await insertDurable(client, {
      id: "jim-seed-meeting-style",
      subject: "Jim meeting style",
      type: "preference",
      claim_key: "jim/meeting_style",
      tags: ["workflow", "handoff"],
      source_context: "Jim workflow guide",
      content: "Jim keeps meeting style concise and focused on the next handoff.",
    });
    await insertDurable(client, {
      id: "jim-grounded-family-apply",
      subject: "Jim review handoff note",
      type: "preference",
      tags: ["workflow", "handoff"],
      source_context: "Jim workflow guide",
      content: "Jim's review handoff note lists open review risks before work changes owners.",
    });
    const llm = new MockClaimLlm(() => ({
      entity: "Jim",
      attribute: "review handoff note",
      confidence: 0.88,
    }));

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const row = await client.execute({
      sql: "SELECT claim_key FROM durables WHERE id = ?",
      args: ["jim-grounded-family-apply"],
    });
    const actions = await getDreamRunActions(client, result.runId);
    const run = await getLastDreamRun(client);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBe("jim/review_handoff_note");
    expect(run?.summaryJson?.observations).toContain("Grounded-family promotion auto-applied 1 candidate and staged 0 proposals.");
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["jim-grounded-family-apply"],
          details: expect.objectContaining({
            auto_apply_threshold: 0.86,
            promotion_lane: "structured_supported",
            supported_auto_apply: true,
            support_class: "trusted_family_grounded_alignment",
            support_family_reuse_count: 2,
            support_grounded_family_reuse_count: 2,
            support_strong_entity_attribute_lexical_alignment: true,
            support_evidence: expect.arrayContaining([
              "trusted_entity_family_reuse",
              "tag_grounding",
              "source_context_grounding",
              "entity_lexical_alignment",
              "attribute_lexical_alignment",
              "strong_entity_attribute_lexical_alignment",
            ]),
          }),
        }),
      ]),
    );
  });

  it("records grounded-family support-class proposals when the supported lane fires but confidence stays below auto-apply", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
      id: "repo-seed-checklist",
      subject: "Repo release checklist",
      type: "decision",
      claim_key: "repo_workflow/release_checklist",
      tags: ["workflow", "docs"],
      source_context: "AGENTS.md defines the repo workflow",
      content: "Repo releases use a release checklist before handoff.",
    });
    await insertDurable(client, {
      id: "repo-seed-review-loop",
      subject: "Repo review loop",
      type: "decision",
      claim_key: "repo_workflow/review_loop",
      tags: ["workflow", "docs"],
      source_context: "AGENTS.md defines the repo workflow",
      content: "Repo workflow keeps review loops short before handoff.",
    });
    await insertDurable(client, {
      id: "repo-grounded-family-proposal",
      subject: "Repo handoff review note",
      type: "decision",
      tags: ["workflow", "docs"],
      source_context: "AGENTS.md defines the repo workflow",
      content: "The repo handoff review note should list unresolved review risks before ownership changes.",
    });
    const llm = new MockClaimLlm(() => ({
      entity: "repo workflow",
      attribute: "handoff review note",
      confidence: 0.84,
    }));

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });

    const row = await client.execute({
      sql: "SELECT claim_key FROM durables WHERE id = ?",
      args: ["repo-grounded-family-proposal"],
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
          durableIds: ["repo-grounded-family-proposal"],
          proposedClaimKeys: ["repo_workflow/handoff_review_note"],
        }),
      ]),
    );
    expect(run?.summaryJson?.observations).toContain("Grounded-family promotion auto-applied 0 candidates and staged 1 proposal.");
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["repo-grounded-family-proposal"],
          details: expect.objectContaining({
            auto_apply_blocker: "below_auto_apply_threshold",
            auto_apply_threshold: 0.86,
            promotion_lane: "structured_supported",
            supported_candidate: true,
            support_class: "trusted_family_grounded_alignment",
            support_family_reuse_count: 2,
            support_grounded_family_reuse_count: 2,
            support_strong_entity_attribute_lexical_alignment: true,
          }),
        }),
      ]),
    );
  });

  it("summarizes shadow sibling-slot resonance for threshold-only grounded-family and relaxed stable-slot buckets", async () => {
    const client = await createTestClient(clients);
    for (let index = 0; index < 18; index += 1) {
      await insertDurable(client, {
        id: `openclaw-generic-${index}`,
        subject: `OpenClaw generic family note ${index}`,
        type: "decision",
        claim_key: `openclaw/family_echo_topic_${index}`,
        tags: ["openclaw", "session"],
        source_context: "OpenClaw session handbook",
        content: `OpenClaw generic family note ${index} keeps session metadata available to the host.`,
      });
    }
    await insertDurable(client, {
      id: "openclaw-resonant-window",
      subject: "OpenClaw session start context window",
      type: "decision",
      claim_key: "openclaw/session_start_context_window",
      tags: ["openclaw", "session"],
      source_context: "OpenClaw session handbook",
      content: "OpenClaw keeps a session start context window for prompt assembly.",
    });
    await insertDurable(client, {
      id: "openclaw-resonant-toggle",
      subject: "OpenClaw session start context toggle",
      type: "decision",
      claim_key: "openclaw/session_start_context_toggle",
      tags: ["openclaw", "session"],
      source_context: "OpenClaw session handbook",
      content: "OpenClaw exposes a session start context toggle before prompt assembly.",
    });
    await insertDurable(client, {
      id: "shadow-high-density-target",
      subject: "OpenClaw session start context flag",
      type: "decision",
      tags: ["openclaw", "session"],
      source_context: "OpenClaw session handbook",
      content: "OpenClaw uses a session start context flag before prompt assembly.",
    });
    await insertDurable(client, {
      id: "docs-seed-layering",
      subject: "Documentation layering strategy",
      type: "preference",
      claim_key: "documentation/layering_strategy",
      tags: ["docs", "style"],
      source_context: "Documentation handbook",
      content: "Documentation keeps a clear layering strategy for longer guides.",
    });
    await insertDurable(client, {
      id: "shadow-stable-slot-target",
      subject: "Documentation docs style preference",
      type: "preference",
      tags: ["docs", "style"],
      source_context: "Documentation handbook",
      content: "Documentation keeps a docs style preference with explicit headings.",
    });
    const llm = new MockClaimLlm((callIndex) =>
      callIndex === 0
        ? {
            entity: "OpenClaw",
            attribute: "session start context flag",
            confidence: 0.74,
          }
        : {
            entity: "documentation",
            attribute: "docs style preference",
            confidence: 0.78,
          },
    );

    const result = await runClaimKeyPass(client, {
      apply: true,
      includeShadowTelemetry: true,
      createClaimExtractionLlm: () => llm,
    });

    const actions = await getDreamRunActions(client, result.runId);
    const summary = (await getLastDreamRun(client))?.summaryJson?.reconcile;
    const observations = (await getLastDreamRun(client))?.summaryJson?.observations ?? [];

    expect(result.status).toBe("completed");
    expect(summary?.shadowSiblingSlotResonance).toMatchObject({
      thresholdOnlyCandidateCount: 2,
      resonanceApplicableCount: 2,
      resonanceFiredCount: 1,
      shadowQualifiedCount: 1,
      resonanceFiredClaimKeys: ["openclaw/session_start_context_flag"],
      shadowQualifiedClaimKeys: ["openclaw/session_start_context_flag"],
      buckets: expect.arrayContaining([
        expect.objectContaining({
          bucket: "high_density_grounded_family",
          candidateCount: 1,
          resonanceApplicableCount: 1,
          resonanceFiredCount: 1,
          shadowQualifiedCount: 1,
        }),
        expect.objectContaining({
          bucket: "relaxed_one_sibling_stable_slot",
          candidateCount: 1,
          resonanceApplicableCount: 1,
          resonanceFiredCount: 0,
          shadowQualifiedCount: 0,
        }),
      ]),
    });
    expect(observations).toContain(
      "Shadow sibling-slot resonance fired for 1/2 threshold-only candidates (high-density grounded-family 1/1, large grounding-diluted grounded-family 0/0, thin grounded-family tail 0/0, relaxed one-sibling stable-slot 0/1, other grounded-family alignment 0/0).",
    );
    expect(observations).toContain("Shadow sibling-slot-resonance rule would have qualified 1 candidate: openclaw/session_start_context_flag.");
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["shadow-high-density-target"],
          details: expect.objectContaining({
            support_class: "trusted_family_grounded_alignment",
            support_family_reuse_count: 20,
            support_grounded_family_reuse_count: 20,
            support_sibling_slot_resonance_fired: true,
            support_sibling_slot_resonance_dominant_shape: "session_start_context",
            support_sibling_slot_resonance_dominant_shape_count: 2,
            shadow_threshold_only_bucket: "high_density_grounded_family",
            shadow_would_qualify: true,
          }),
        }),
        expect.objectContaining({
          durableIds: ["shadow-stable-slot-target"],
          details: expect.objectContaining({
            support_class: "trusted_family_stable_slot",
            support_sibling_slot_resonance_fired: false,
            shadow_threshold_only_bucket: "relaxed_one_sibling_stable_slot",
            shadow_would_qualify: false,
          }),
        }),
      ]),
    );
  });
});
