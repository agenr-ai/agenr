import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  countRetirementCandidates,
  getSurgeonHealthStats,
  inspectSurgeonEntry,
  listRetirementCandidates,
  listSupersessionCandidates,
} from "../../../src/adapters/db/surgeon-queries.js";
import { createSurgeonRun, logSurgeonAction } from "../../../src/adapters/db/surgeon-run-log.js";
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

    expect(actionable.map((candidate) => candidate.id)).toEqual([ids.temporary, ids.milestone, ids.statusArtifact, ids.fact]);

    const allScope = await listRetirementCandidates(client, {
      scope: "all",
      protectRecalledDays: 14,
      protectMinImportance: 9,
      now: TEST_NOW,
    });

    expect(allScope.map((candidate) => candidate.id)).toEqual([ids.temporary, ids.milestone, ids.statusArtifact, ids.fact, ids.lesson]);
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

    expect(filtered).toEqual([]);

    const paginated = await listRetirementCandidates(client, {
      scope: "all",
      project: "alpha",
      limit: 1,
      offset: 1,
      protectRecalledDays: 14,
      protectMinImportance: 9,
      now: TEST_NOW,
    });

    expect(paginated.map((candidate) => candidate.id)).toEqual(["alpha-fact-1"]);
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

  it("collects surgeon health stats and counts actionable retirement candidates consistently", async () => {
    const client = await createTestClient(clients);

    await insertEntry(client, {
      id: "recent-fact",
      subject: "Recent fact",
      type: "fact",
      importance: 4,
      expiry: "permanent",
      quality_score: 0.8,
      recall_count: 0,
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
      created_at: daysAgoIso(60),
      updated_at: daysAgoIso(60),
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
      total: 4,
      byType: {
        decision: 1,
        fact: 1,
        milestone: 2,
      },
      recency: {
        last7: 1,
        last30: 1,
        d30To90: 1,
        d90Plus: 1,
      },
      recall: {
        never: 2,
        oneToFive: 1,
        fivePlus: 1,
      },
      quality: {
        high: 2,
        medium: 1,
        low: 1,
        average: 0.625,
      },
      retirementCandidateCount: 3,
      recentlyEvaluatedCount: 0,
    });

    expect(
      await countRetirementCandidates(client, {
        protectRecalledDays: 14,
        protectMinImportance: 9,
        now: TEST_NOW,
      }),
    ).toEqual({ total: 3, recentlyEvaluated: 0 });
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
        supersession_kind,
        supersession_reason,
        cluster_id,
        retired,
        retired_at,
        retired_reason,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
