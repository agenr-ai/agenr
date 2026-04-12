import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  countRetirementCandidates,
  getSurgeonHealthStats,
  inspectSurgeonEntry,
  listClaimKeyQualityEntries,
  listRetirementCandidates,
  listSupersessionCandidates,
} from "../../../src/adapters/db/surgeon-queries.js";
import { createSurgeonRun, logSurgeonAction, logSurgeonProposal } from "../../../src/adapters/db/surgeon-run-log.js";
import { serializeTags } from "../../../src/adapters/db/row-mapping.js";
import { initSchema } from "../../../src/adapters/db/schema.js";
import type { Entry } from "../../../src/core/types.js";

const TEST_NOW = new Date("2026-03-29T12:00:00.000Z");

describe("surgeon queries", () => {
  const clients: Client[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });

  it("lists prioritized retirement candidates across actionable and all scopes", async () => {
    const client = await createTestClient(clients);
    const ids = await seedCandidateEntries(client);

    const actionable = await listRetirementCandidates(client, {
      scope: "actionable",
      protectRecalledDays: 14,
      protectMinImportance: 9,
      now: TEST_NOW,
    });

    expect(actionable.candidates.map((candidate) => candidate.id)).toEqual([ids.temporary, ids.milestone, ids.statusArtifact, ids.fact]);
    expect(actionable).toMatchObject({
      totalMatching: 4,
      availableCount: 4,
      scope: "actionable",
      scopeExhausted: true,
      nextOffset: null,
    });

    const allScope = await listRetirementCandidates(client, {
      scope: "all",
      protectRecalledDays: 14,
      protectMinImportance: 9,
      now: TEST_NOW,
    });

    expect(allScope.candidates.map((candidate) => candidate.id)).toEqual([ids.temporary, ids.milestone, ids.statusArtifact, ids.fact, ids.lesson]);
    expect(allScope).toMatchObject({
      totalMatching: 5,
      availableCount: 5,
      scope: "all",
      scopeExhausted: true,
      nextOffset: null,
    });
  });

  it("applies candidate filters for project tags, type, age, pagination, and recent evaluations", async () => {
    const client = await createTestClient(clients);

    await insertEntry(client, {
      id: "alpha-fact-1",
      subject: "Alpha candidate",
      type: "fact",
      importance: 4,
      expiry: "permanent",
      recall_count: 0,
      created_at: daysAgoIso(120),
      updated_at: daysAgoIso(90),
      tags: ["alpha"],
    });
    await insertEntry(client, {
      id: "alpha-fact-2",
      subject: "Alpha candidate recent",
      type: "fact",
      importance: 4,
      expiry: "permanent",
      recall_count: 0,
      created_at: daysAgoIso(5),
      updated_at: daysAgoIso(5),
      tags: ["alpha"],
    });
    await insertEntry(client, {
      id: "alpha-milestone",
      subject: "Alpha launch milestone",
      type: "milestone",
      importance: 3,
      expiry: "permanent",
      recall_count: 0,
      created_at: daysAgoIso(100),
      updated_at: daysAgoIso(50),
      tags: ["alpha"],
    });
    await insertEntry(client, {
      id: "beta-fact",
      subject: "Beta candidate",
      type: "fact",
      importance: 4,
      expiry: "permanent",
      recall_count: 0,
      created_at: daysAgoIso(150),
      updated_at: daysAgoIso(80),
      tags: ["beta"],
    });

    const previousRunId = await createSurgeonRun(client, {
      passType: "retirement",
      dryRun: false,
      startedAt: daysAgoIso(2),
    });
    await logSurgeonAction(client, {
      id: "action-skip",
      runId: previousRunId,
      actionType: "skip",
      entryIds: ["alpha-fact-1"],
      reasoning: "Already reviewed.",
      recallDelta: null,
      createdAt: daysAgoIso(2),
    });

    const filtered = await listRetirementCandidates(client, {
      scope: "all",
      type: "fact",
      project: "alpha",
      minAgeDays: 30,
      limit: 1,
      offset: 0,
      protectRecalledDays: 14,
      protectMinImportance: 9,
      skipRecentlyEvaluatedDays: 7,
      now: TEST_NOW,
    });

    expect(filtered.candidates).toEqual([]);
    expect(filtered).toMatchObject({
      totalMatching: 1,
      availableCount: 0,
      recentlyEvaluatedFilteredCount: 1,
      scopeExhausted: true,
    });

    const paginated = await listRetirementCandidates(client, {
      scope: "all",
      project: "alpha",
      limit: 1,
      offset: 1,
      protectRecalledDays: 14,
      protectMinImportance: 9,
      now: TEST_NOW,
    });

    expect(paginated.candidates.map((candidate) => candidate.id)).toEqual(["alpha-fact-1"]);
    expect(paginated).toMatchObject({
      totalMatching: 3,
      availableCount: 3,
      offset: 1,
      nextOffset: 2,
      scopeExhausted: false,
    });
  });

  it("suppresses candidates already skipped or updated earlier in the same run", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "same-run-fact",
      subject: "Same run candidate",
      type: "fact",
      importance: 4,
      expiry: "permanent",
      recall_count: 0,
      created_at: daysAgoIso(120),
      updated_at: daysAgoIso(90),
    });

    const runId = await createSurgeonRun(client, {
      passType: "retirement",
      dryRun: false,
      startedAt: daysAgoIso(1),
    });
    await logSurgeonAction(client, {
      id: "same-run-update",
      runId,
      actionType: "update_entry",
      entryIds: ["same-run-fact"],
      reasoning: "Demoted instead of retiring.",
      recallDelta: null,
      createdAt: daysAgoIso(1),
    });

    const page = await listRetirementCandidates(client, {
      scope: "all",
      protectRecalledDays: 14,
      protectMinImportance: 9,
      skipRecentlyEvaluatedDays: 0,
      runId,
      now: TEST_NOW,
    });

    expect(page.candidates).toEqual([]);
    expect(page).toMatchObject({
      totalMatching: 0,
      availableCount: 0,
      scopeExhausted: true,
    });
  });

  it("ignores malformed action entry_ids JSON when filtering recently evaluated candidates", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "json-valid-candidate",
      subject: "JSON valid candidate",
      type: "fact",
      importance: 4,
      expiry: "permanent",
      recall_count: 0,
      created_at: daysAgoIso(120),
      updated_at: daysAgoIso(90),
    });

    const runId = await createSurgeonRun(client, {
      passType: "retirement",
      dryRun: false,
      startedAt: daysAgoIso(1),
    });
    await client.execute({
      sql: `
        INSERT INTO surgeon_run_actions (
          id,
          run_id,
          action_type,
          entry_id,
          entry_ids,
          reasoning,
          recall_delta,
          details_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: ["action-malformed-json", runId, "skip", null, '{"not":"an array"', "Legacy malformed JSON.", null, null, daysAgoIso(1)],
    });

    const page = await listRetirementCandidates(client, {
      scope: "all",
      protectRecalledDays: 14,
      protectMinImportance: 9,
      skipRecentlyEvaluatedDays: 7,
      now: TEST_NOW,
    });

    expect(page.candidates.map((candidate) => candidate.id)).toEqual(["json-valid-candidate"]);
    expect(page).toMatchObject({
      totalMatching: 1,
      availableCount: 1,
      recentlyEvaluatedFilteredCount: 0,
    });
  });

  it("lists claim_key supersession clusters with two or more active entries", async () => {
    const client = await createTestClient(clients);

    await insertEntry(client, {
      id: "home-city-1",
      subject: "Jim home city",
      claim_key: "jim/home_city",
      created_at: daysAgoIso(40),
    });
    await insertEntry(client, {
      id: "home-city-2",
      subject: "Jim home city updated",
      claim_key: "jim/home_city",
      created_at: daysAgoIso(20),
    });
    await insertEntry(client, {
      id: "employer-1",
      subject: "Jim employer",
      claim_key: "jim/employer",
      created_at: daysAgoIso(10),
    });

    const clusters = await listSupersessionCandidates(client, {
      scope: "claim_key",
    });

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      groupKey: "jim/home_city",
      groupedBy: "claim_key",
    });
    expect(clusters[0]?.entries.map((entry) => entry.id)).toEqual(["home-city-1", "home-city-2"]);
  });

  it("lists subject supersession clusters for matching subject and type pairs", async () => {
    const client = await createTestClient(clients);

    await insertEntry(client, {
      id: "subject-1",
      subject: "mac mini update control",
      type: "preference",
      created_at: daysAgoIso(30),
    });
    await insertEntry(client, {
      id: "subject-2",
      subject: "mac mini update control",
      type: "preference",
      created_at: daysAgoIso(15),
    });
    await insertEntry(client, {
      id: "subject-3",
      subject: "different subject",
      type: "preference",
      created_at: daysAgoIso(5),
    });

    const clusters = await listSupersessionCandidates(client, {
      scope: "subject",
    });

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      groupKey: "mac mini update control::preference",
      groupedBy: "subject",
    });
    expect(clusters[0]?.entries.map((entry) => entry.id)).toEqual(["subject-1", "subject-2"]);
  });

  it("inspects entries with same-subject, cluster, and supersession context", async () => {
    const client = await createTestClient(clients);

    await insertEntry(client, {
      id: "target",
      subject: "Shared subject",
      type: "fact",
      importance: 4,
      expiry: "permanent",
      tags: ["alpha", "beta"],
      cluster_id: "cluster-1",
      created_at: daysAgoIso(120),
      updated_at: daysAgoIso(5),
    });
    await insertEntry(client, {
      id: "same-subject-active",
      subject: "shared subject",
      type: "fact",
      importance: 3,
      expiry: "temporary",
      cluster_id: "cluster-2",
      created_at: daysAgoIso(90),
      updated_at: daysAgoIso(4),
    });
    await insertEntry(client, {
      id: "same-subject-retired",
      subject: "Shared subject",
      type: "fact",
      importance: 3,
      expiry: "temporary",
      retired: true,
      retired_at: daysAgoIso(3),
      created_at: daysAgoIso(95),
      updated_at: daysAgoIso(3),
    });
    await insertEntry(client, {
      id: "same-cluster-active",
      subject: "Cluster sibling",
      type: "milestone",
      importance: 2,
      expiry: "temporary",
      cluster_id: "cluster-1",
      created_at: daysAgoIso(60),
      updated_at: daysAgoIso(2),
    });
    await insertEntry(client, {
      id: "superseded-1",
      subject: "Old version 1",
      type: "fact",
      importance: 2,
      expiry: "temporary",
      superseded_by: "target",
      retired: true,
      retired_at: daysAgoIso(20),
      created_at: daysAgoIso(200),
      updated_at: daysAgoIso(20),
    });
    await insertEntry(client, {
      id: "superseded-2",
      subject: "Old version 2",
      type: "fact",
      importance: 2,
      expiry: "temporary",
      superseded_by: "target",
      retired: false,
      created_at: daysAgoIso(150),
      updated_at: daysAgoIso(10),
    });

    const inspection = await inspectSurgeonEntry(client, "target");

    expect(inspection).not.toBeNull();
    expect(inspection?.entry.id).toBe("target");
    expect(inspection?.tags).toEqual(["alpha", "beta"]);
    expect(inspection?.related.sameSubject.map((entry) => entry.id)).toEqual(["same-subject-active"]);
    expect(inspection?.related.sameCluster.map((entry) => entry.id)).toEqual(["same-cluster-active"]);
    expect(inspection?.related.supersedesCount).toBe(2);
    expect(inspection?.related.supersedesSample.map((entry) => entry.id)).toEqual(["superseded-2", "superseded-1"]);
  });

  it("hydrates claim-key lifecycle fields for claim-key-quality working sets", async () => {
    const client = await createTestClient(clients);
    await insertEntry(client, {
      id: "lifecycle-entry",
      subject: "Home city",
      claim_key: "jim/home_city",
      claim_key_raw: "Jim / Home City",
      claim_key_status: "trusted",
      claim_key_source: "manual",
      claim_key_confidence: 1,
      claim_key_rationale: "manual claim key supplied by caller",
      claim_support_source_kind: "tool_call",
      claim_support_locator: "sessions/demo.jsonl#5",
      claim_support_observed_at: "2026-03-29T09:00:00.000Z",
      claim_support_mode: "explicit",
    });

    const entries = await listClaimKeyQualityEntries(client, {
      entryIds: ["lifecycle-entry"],
      includeInactive: true,
    });

    expect(entries).toEqual([
      expect.objectContaining({
        id: "lifecycle-entry",
        claim_key: "jim/home_city",
        claim_key_raw: "Jim / Home City",
        claim_key_status: "trusted",
        claim_key_source: "manual",
        claim_key_confidence: 1,
        claim_key_rationale: "manual claim key supplied by caller",
        claim_support_source_kind: "tool_call",
        claim_support_locator: "sessions/demo.jsonl#5",
        claim_support_observed_at: "2026-03-29T09:00:00.000Z",
        claim_support_mode: "explicit",
      }),
    ]);
  });

  it("collects surgeon health stats and counts actionable retirement candidates consistently", async () => {
    const client = await createTestClient(clients);
    const proposalRunId = await createSurgeonRun(client, {
      passType: "claim_key_quality",
      dryRun: true,
      startedAt: daysAgoIso(1),
    });
    await logSurgeonProposal(client, {
      id: "proposal-1",
      runId: proposalRunId,
      groupId: "claim-key-family:shared-slot",
      issueKind: "family_conflict",
      scope: "cluster",
      entryIds: ["old-milestone", "legacy-slot"],
      currentClaimKeys: ["shared/slot"],
      proposedClaimKeys: ["shared/slot"],
      rationale: "Need manual review before rewriting the family.",
      confidence: 0.62,
      source: "surgeon_family_reuse",
      eligibleForApply: false,
      createdAt: daysAgoIso(1),
    });

    await insertEntry(client, {
      id: "recent-fact",
      subject: "Recent fact",
      type: "fact",
      importance: 4,
      expiry: "permanent",
      quality_score: 0.8,
      recall_count: 0,
      claim_key: "recent/fact",
      claim_key_status: "trusted",
      claim_key_source: "manual",
      created_at: daysAgoIso(3),
      updated_at: daysAgoIso(3),
    });
    await insertEntry(client, {
      id: "mid-milestone",
      subject: "Mid milestone",
      type: "milestone",
      importance: 3,
      expiry: "temporary",
      quality_score: 0.5,
      recall_count: 2,
      claim_key: "mid/milestone",
      claim_key_status: "tentative",
      claim_key_source: "deterministic_repair",
      created_at: daysAgoIso(20),
      updated_at: daysAgoIso(20),
    });
    await insertEntry(client, {
      id: "old-milestone",
      subject: "Old milestone",
      type: "milestone",
      importance: 4,
      expiry: "permanent",
      quality_score: 0.3,
      recall_count: 6,
      claim_key_status: "unresolved",
      created_at: daysAgoIso(60),
      updated_at: daysAgoIso(60),
    });
    await insertEntry(client, {
      id: "legacy-slot",
      subject: "Legacy claim key",
      type: "fact",
      importance: 4,
      expiry: "permanent",
      quality_score: 0.6,
      recall_count: 1,
      claim_key: "legacy/slot",
      created_at: daysAgoIso(45),
      updated_at: daysAgoIso(45),
    });
    await insertEntry(client, {
      id: "very-old-important",
      subject: "Very old important",
      type: "decision",
      importance: 9,
      expiry: "permanent",
      quality_score: 0.9,
      recall_count: 0,
      created_at: daysAgoIso(120),
      updated_at: daysAgoIso(120),
    });

    const health = await getSurgeonHealthStats(client, {
      protectRecalledDays: 14,
      protectMinImportance: 9,
      now: TEST_NOW,
    });

    expect(health).toEqual({
      total: 5,
      byType: {
        decision: 1,
        fact: 2,
        milestone: 2,
      },
      claimKeyLifecycle: {
        trusted: 1,
        tentative: 1,
        unresolved: 1,
        legacy: 1,
        noKey: 1,
      },
      proposalBacklogCount: 1,
      eligibleProposalBacklogCount: 0,
      oldestOpenProposalCreatedAt: daysAgoIso(1),
      recency: {
        last7: 1,
        last30: 1,
        d30To90: 2,
        d90Plus: 1,
      },
      recall: {
        never: 2,
        oneToFive: 2,
        fivePlus: 1,
      },
      quality: {
        high: 2,
        medium: 2,
        low: 1,
        average: 0.62,
      },
      retirementCandidateCount: 3,
      retirementAvailableActionableCount: 3,
      retirementAvailableAllCount: 4,
      recentlyEvaluatedCount: 0,
    });

    expect(
      await countRetirementCandidates(client, {
        protectRecalledDays: 14,
        protectMinImportance: 9,
        now: TEST_NOW,
      }),
    ).toEqual({
      rawActionableCount: 3,
      availableActionableCount: 3,
      availableAllCount: 4,
      recentlyEvaluatedFilteredCount: 0,
    });
  });

  it("counts duplicate open proposals as one logical backlog issue", async () => {
    const client = await createTestClient(clients);
    const firstRunId = await createSurgeonRun(client, {
      passType: "claim_key_quality",
      dryRun: true,
      startedAt: daysAgoIso(2),
    });
    const secondRunId = await createSurgeonRun(client, {
      passType: "claim_key_quality",
      dryRun: true,
      startedAt: daysAgoIso(1),
    });

    await logSurgeonProposal(client, {
      id: "duplicate-proposal-1",
      runId: firstRunId,
      groupId: "group-duplicate",
      issueKind: "missing_claim_key",
      scope: "single_entry",
      entryIds: ["entry-a"],
      currentClaimKeys: [],
      proposedClaimKeys: ["jim/home_city"],
      rationale: "First open issue record.",
      confidence: 0.7,
      source: "mixed_group_consensus",
      eligibleForApply: false,
      createdAt: daysAgoIso(2),
    });
    await logSurgeonProposal(client, {
      id: "duplicate-proposal-2",
      runId: secondRunId,
      groupId: "group-duplicate",
      issueKind: "missing_claim_key",
      scope: "single_entry",
      entryIds: ["entry-a"],
      currentClaimKeys: [],
      proposedClaimKeys: ["jim/home_city"],
      rationale: "Refreshed open issue record.",
      confidence: 0.9,
      source: "mixed_group_consensus",
      eligibleForApply: true,
      createdAt: daysAgoIso(1),
    });

    const health = await getSurgeonHealthStats(client, {
      protectRecalledDays: 14,
      protectMinImportance: 9,
      now: TEST_NOW,
    });

    expect(health).toMatchObject({
      proposalBacklogCount: 1,
      eligibleProposalBacklogCount: 1,
      oldestOpenProposalCreatedAt: daysAgoIso(2),
    });
  });
});

async function createTestClient(clients: Client[]): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  await initSchema(client);
  return client;
}

async function seedCandidateEntries(client: Client): Promise<Record<string, string>> {
  const ids = {
    temporary: "temporary-old",
    milestone: "milestone-low",
    statusArtifact: "status-artifact",
    fact: "fact-never",
    lesson: "lesson-recalled",
    recentRecall: "fact-recent-recall",
    important: "important-entry",
  };

  await insertEntry(client, {
    id: ids.temporary,
    subject: "Temporary scratch note",
    type: "fact",
    importance: 2,
    expiry: "temporary",
    recall_count: 0,
    quality_score: 0.3,
    created_at: daysAgoIso(140),
    updated_at: daysAgoIso(130),
  });
  await insertEntry(client, {
    id: ids.milestone,
    subject: "follow-up migration milestone",
    type: "milestone",
    importance: 3,
    expiry: "permanent",
    recall_count: 0,
    quality_score: 0.4,
    created_at: daysAgoIso(120),
    updated_at: daysAgoIso(100),
  });
  await insertEntry(client, {
    id: ids.statusArtifact,
    subject: "Session handoff for surgeon phase two",
    type: "fact",
    importance: 5,
    expiry: "permanent",
    recall_count: 0,
    quality_score: 0.6,
    created_at: daysAgoIso(100),
    updated_at: daysAgoIso(80),
  });
  await insertEntry(client, {
    id: ids.fact,
    subject: "Stale implementation detail",
    type: "fact",
    importance: 5,
    expiry: "permanent",
    recall_count: 0,
    quality_score: 0.5,
    created_at: daysAgoIso(90),
    updated_at: daysAgoIso(70),
  });
  await insertEntry(client, {
    id: ids.lesson,
    subject: "Lesson from old rollout",
    type: "lesson",
    importance: 3,
    expiry: "permanent",
    recall_count: 2,
    quality_score: 0.7,
    created_at: daysAgoIso(80),
    updated_at: daysAgoIso(60),
  });
  await insertEntry(client, {
    id: ids.recentRecall,
    subject: "Recently recalled fact",
    type: "fact",
    importance: 4,
    expiry: "permanent",
    recall_count: 1,
    last_recalled_at: daysAgoIso(3),
    quality_score: 0.5,
    created_at: daysAgoIso(70),
    updated_at: daysAgoIso(3),
  });
  await insertEntry(client, {
    id: ids.important,
    subject: "Protected important entry",
    type: "fact",
    importance: 9,
    expiry: "temporary",
    recall_count: 0,
    quality_score: 0.9,
    created_at: daysAgoIso(60),
    updated_at: daysAgoIso(60),
  });

  return ids;
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
        claim_key_raw,
        claim_key_status,
        claim_key_source,
        claim_key_confidence,
        claim_key_rationale,
        claim_support_source_kind,
        claim_support_locator,
        claim_support_observed_at,
        claim_support_mode,
        supersession_kind,
        supersession_reason,
        cluster_id,
        retired,
        retired_at,
        retired_reason,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      entry.id,
      entry.type,
      entry.subject,
      entry.content,
      entry.importance,
      entry.expiry,
      serializeTags(entry.tags),
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
      entry.claim_key_raw ?? null,
      entry.claim_key_status ?? null,
      entry.claim_key_source ?? null,
      entry.claim_key_confidence ?? null,
      entry.claim_key_rationale ?? null,
      entry.claim_support_source_kind ?? null,
      entry.claim_support_locator ?? null,
      entry.claim_support_observed_at ?? null,
      entry.claim_support_mode ?? null,
      entry.supersession_kind ?? null,
      entry.supersession_reason ?? null,
      entry.cluster_id ?? null,
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
    content: overrides.content ?? `content for ${overrides.id}`,
    importance: overrides.importance ?? 3,
    expiry: overrides.expiry ?? "permanent",
    tags: overrides.tags ?? [],
    source_file: overrides.source_file,
    source_context: overrides.source_context,
    embedding: overrides.embedding,
    content_hash: overrides.content_hash ?? `${overrides.id}-hash`,
    norm_content_hash: overrides.norm_content_hash,
    quality_score: overrides.quality_score ?? 0.5,
    recall_count: overrides.recall_count ?? 0,
    last_recalled_at: overrides.last_recalled_at,
    superseded_by: overrides.superseded_by,
    valid_from: overrides.valid_from,
    valid_to: overrides.valid_to,
    claim_key: overrides.claim_key,
    claim_key_raw: overrides.claim_key_raw,
    claim_key_status: overrides.claim_key_status,
    claim_key_source: overrides.claim_key_source,
    claim_key_confidence: overrides.claim_key_confidence,
    claim_key_rationale: overrides.claim_key_rationale,
    claim_support_source_kind: overrides.claim_support_source_kind,
    claim_support_locator: overrides.claim_support_locator,
    claim_support_observed_at: overrides.claim_support_observed_at,
    claim_support_mode: overrides.claim_support_mode,
    supersession_kind: overrides.supersession_kind,
    supersession_reason: overrides.supersession_reason,
    cluster_id: overrides.cluster_id,
    retired: overrides.retired ?? false,
    retired_at: overrides.retired_at,
    retired_reason: overrides.retired_reason,
    created_at: overrides.created_at ?? daysAgoIso(30),
    updated_at: overrides.updated_at ?? overrides.created_at ?? daysAgoIso(30),
  };
}

function daysAgoIso(days: number): string {
  return new Date(TEST_NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}
