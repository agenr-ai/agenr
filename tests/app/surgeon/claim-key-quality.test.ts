import { createClient, type Client } from "@libsql/client";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { createSurgeonPort } from "../../../src/adapters/db/surgeon-port.js";
import { getLastSurgeonRun, getSurgeonRunActions, getSurgeonRunProposals } from "../../../src/adapters/db/surgeon-run-log.js";
import { initSchema } from "../../../src/adapters/db/schema.js";
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
    const summary = (await getLastSurgeonRun(client))?.summaryJson?.claim_key_quality;

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
});

async function runClaimKeyPass(
  client: Client,
  overrides: {
    apply?: boolean;
    createClaimExtractionLlm?: () => LlmPort & { metadata?: { usage?: { inputTokens?: number; outputTokens?: number; totalCost?: number } } };
  } = {},
) {
  return runSurgeon(
    {
      pass: "claim_key_quality",
      budget: 10,
      contextLimit: 4_096,
      apply: overrides.apply === true,
      verbose: false,
      json: false,
    },
    {
      port: createSurgeonPort(client),
      config: null,
      model: TEST_MODEL,
      now: () => TEST_NOW,
      createClaimExtractionLlm: overrides.createClaimExtractionLlm,
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
