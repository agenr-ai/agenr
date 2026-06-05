import { afterEach, vi, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { createTestClient, insertDurable, MockClaimLlm, runClaimKeyPass } from "../../../helpers/dreaming-reconcile.js";

import { getLastDreamRun, getDreamRunActions, getDreamRunProposals } from "../../../../src/adapters/db/dreaming-run-log.js";

describe("reconcile dreaming pass - missing backfill guards", () => {
  const clients: Client[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });

  it("does not treat dirty or suspect corpus keys as trusted reuse canon", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
      id: "dirty-group-seed",
      subject: "Project status",
      type: "fact",
      claim_key: "project/status",
      content: "The project is active.",
      tags: ["workflow", "docs"],
      source_context: "AGENTS.md defines the repo workflow",
    });
    await insertDurable(client, {
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
      sql: "SELECT claim_key FROM durables WHERE id = ?",
      args: ["dirty-group-missing"],
    });
    const actions = await getDreamRunActions(client, result.runId);
    const summary = (await getLastDreamRun(client))?.summaryJson?.reconcile;

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBeNull();
    expect(actions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["dirty-group-missing"],
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
    await insertDurable(client, {
      id: "dirty-tagged-seed",
      subject: "Repo workflow details",
      type: "decision",
      claim_key: "repo_workflow/details",
      tags: ["workflow", "docs"],
      source_context: "AGENTS.md defines the repo workflow",
    });
    await insertDurable(client, {
      id: "clean-seed",
      subject: "Timezone seed",
      type: "fact",
      claim_key: "jim/timezone",
    });
    await insertDurable(client, {
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
    await insertDurable(client, {
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
      sql: "SELECT claim_key FROM durables WHERE id = ?",
      args: ["plain-mid-confidence"],
    });
    const proposals = await getDreamRunProposals(client, result.runId);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBeNull();
    expect(proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["plain-mid-confidence"],
          proposedClaimKeys: ["clinic_visits/default_mode"],
        }),
      ]),
    );
  });

  it("keeps supported cross-type collisions unresolved instead of auto-applying them", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
      id: "validator-fact-seed",
      subject: "Validator verification policy",
      type: "fact",
      claim_key: "validator/verification_policy",
      tags: ["validator", "policy"],
      source_context: "Validator docs define the release gate",
      content: "Validator policy requires verification before release.",
    });
    await insertDurable(client, {
      id: "validator-family-seed",
      subject: "Validator default mode",
      type: "decision",
      claim_key: "validator/default_mode",
      tags: ["validator", "policy"],
      source_context: "Validator docs define the release gate",
      content: "Validator defaults to strict mode.",
    });
    await insertDurable(client, {
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
      sql: "SELECT claim_key FROM durables WHERE id = ?",
      args: ["validator-missing"],
    });
    const proposals = await getDreamRunProposals(client, result.runId);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBeNull();
    expect(proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueKind: "missing_claim_key",
          durableIds: ["validator-missing", "validator-fact-seed"],
          proposedClaimKeys: ["validator/verification_policy"],
        }),
      ]),
    );
  });

  it("keeps awkward supported candidates unresolved when compact canonicalization is still semantically ambiguous", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
      id: "changelog-family-workflow",
      subject: "Changelog publish workflow",
      type: "decision",
      claim_key: "changelog/publish_workflow",
      tags: ["release", "docs"],
      source_context: "CHANGELOG.md governs release note operations",
      content: "Release notes are published from CHANGELOG.md.",
    });
    await insertDurable(client, {
      id: "changelog-family-policy",
      subject: "Changelog archive policy",
      type: "decision",
      claim_key: "changelog/archive_policy",
      tags: ["release", "docs"],
      source_context: "CHANGELOG.md governs release note operations",
      content: "Archive old release notes only after they are copied into CHANGELOG.md.",
    });
    await insertDurable(client, {
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
      sql: "SELECT claim_key FROM durables WHERE id = ?",
      args: ["changelog-awkward"],
    });
    const actions = await getDreamRunActions(client, result.runId);
    const proposals = await getDreamRunProposals(client, result.runId);

    expect(result.status).toBe("completed");
    expect(row.rows[0]?.claim_key).toBeNull();
    expect(proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueKind: "missing_claim_key",
          durableIds: ["changelog-awkward"],
          proposedClaimKeys: ["changelog/authoritative_source_of_truth_and_archive_workflow_for_release_notes"],
        }),
      ]),
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durableIds: ["changelog-awkward"],
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
    await insertDurable(client, { id: "a-shared-fact", subject: "Shared slot fact", type: "fact", content: "The shared slot is active." });
    await insertDurable(client, {
      id: "b-shared-decision",
      subject: "Shared slot decision",
      type: "decision",
      content: "Decision: the shared slot is active.",
    });
    await insertDurable(client, { id: "unique-fact", subject: "Unique timezone", type: "fact", content: "Jim's timezone is America/Chicago." });

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
      sql: "SELECT id, claim_key FROM durables WHERE id IN (?, ?, ?) ORDER BY id ASC",
      args: ["a-shared-fact", "b-shared-decision", "unique-fact"],
    });
    const proposals = await getDreamRunProposals(client, result.runId);

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
          durableIds: ["b-shared-decision", "a-shared-fact"],
          proposedClaimKeys: ["shared/status"],
        }),
      ]),
    );
  });

  it("persists per-entry missing-key skip diagnostics for tuning follow-up", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, {
      id: "skip-no-claim",
      subject: "Retrospective story",
      type: "lesson",
      content: "We chased several hypotheses and eventually recovered after a long debugging session.",
    });
    await insertDurable(client, {
      id: "skip-malformed",
      subject: "Workflow planning",
      type: "decision",
      content: "We discussed several workflow options without deciding on a stable policy.",
    });
    await insertDurable(client, {
      id: "skip-rejected",
      subject: "Project details",
      type: "fact",
      content: "Project X uses blue-green deploys.",
    });
    await insertDurable(client, {
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

    const summary = (await getLastDreamRun(client))?.summaryJson;

    expect(result.status).toBe("completed");
    expect(summary?.durables_skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durable_id: "skip-no-claim",
          reason: expect.stringContaining("missing_claim_key:no_claim"),
        }),
        expect.objectContaining({
          durable_id: "skip-malformed",
          reason: expect.stringContaining("missing_claim_key:malformed_output"),
        }),
        expect.objectContaining({
          durable_id: "skip-rejected",
          reason: expect.stringContaining("missing_claim_key:rejected_candidate"),
        }),
        expect.objectContaining({
          durable_id: "skip-low-confidence",
          reason: expect.stringContaining("missing_claim_key:low_confidence_candidate"),
        }),
      ]),
    );
    expect(summary?.durables_skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durable_id: "skip-rejected",
          reason: expect.stringContaining("warning="),
        }),
        expect.objectContaining({
          durable_id: "skip-low-confidence",
          reason: expect.stringContaining("confidence=0.62"),
        }),
      ]),
    );
  });
});
