import { type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import { createDreamPort } from "../../../src/adapters/db/dreaming-port.js";
import { getDurable } from "../../../src/adapters/db/queries.js";
import { applyExtractedDurables, runExtractStage } from "../../../src/app/dreaming/extract.js";
import { computeNormContentHash } from "../../../src/core/store/hashing.js";
import type { LlmPort } from "../../../src/core/ports.js";
import { createDeterministicEmbedding, createTestClient, insertDurable, TEST_NOW } from "../../helpers/dreaming-reconcile.js";

interface MinedDurableResponse {
  type: string;
  subject: string;
  content: string;
  claim_key?: string;
  importance?: number;
  expiry?: string;
  tags?: string[];
}

/** Minimal extraction LLM double returning a fixed durable set per call. */
class FakeExtractLlm implements LlmPort {
  public readonly metadata = { usage: { inputTokens: 0, outputTokens: 0, totalCost: 0 } };
  public calls = 0;

  public constructor(
    private readonly durables: MinedDurableResponse[],
    private readonly costPerCall = 0,
  ) {}

  public async complete(): Promise<string> {
    throw new Error("complete() is not used by the extract stage.");
  }

  public async completeJson<T>(): Promise<T> {
    this.calls += 1;
    this.metadata.usage.inputTokens += 1;
    this.metadata.usage.totalCost += this.costPerCall;
    return { durables: this.durables } as T;
  }
}

async function insertEpisode(
  client: Client,
  overrides: { id: string; summary: string; startedAt?: string; endedAt?: string; project?: string; createdAt?: string },
): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO episodes (id, source, source_id, started_at, ended_at, summary, project, created_at, updated_at)
      VALUES (?, 'openclaw', ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      overrides.id,
      `session-${overrides.id}`,
      overrides.startedAt ?? "2026-04-04T10:00:00.000Z",
      overrides.endedAt ?? "2026-04-04T11:00:00.000Z",
      overrides.summary,
      overrides.project ?? null,
      overrides.createdAt ?? "2026-04-04T11:00:00.000Z",
      overrides.createdAt ?? "2026-04-04T11:00:00.000Z",
    ],
  });
}

describe("dreaming extract stage", () => {
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    clients.length = 0;
  });

  it("returns no candidates when no mining LLM is configured", async () => {
    const client = await createTestClient(clients);
    await insertEpisode(client, { id: "ep-1", summary: "A session where the user mentioned several durable preferences." });

    const result = await runExtractStage(
      { now: () => TEST_NOW, maxEpisodes: 8, contextLookupEnabled: true, costCapUsd: 10 },
      { port: createDreamPort(client) },
    );

    expect(result.candidates).toEqual([]);
    expect(result.summary.episodesScanned).toBe(0);
  });

  it("classifies mined candidates as new, refines, and known", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    await insertDurable(client, {
      id: "home-1",
      subject: "Home base",
      content: "Home base is Boston for the foreseeable future.",
      type: "fact",
      claim_key: "user/home_base",
      claim_key_status: "trusted",
    });

    const knownContent = "Standups happen every weekday at 9am sharp in the team channel.";
    await insertDurable(client, {
      id: "known-1",
      subject: "Standup cadence",
      content: knownContent,
      type: "fact",
      norm_content_hash: computeNormContentHash(knownContent),
    });

    await insertEpisode(client, { id: "ep-1", summary: "Session covering home base, coffee, and standups." });

    const llm = new FakeExtractLlm([
      { type: "preference", subject: "Coffee", content: "Prefers oat milk in coffee during daily standups.", claim_key: "user/coffee_preference" },
      { type: "fact", subject: "Home base", content: "Home base is now San Francisco for the foreseeable future.", claim_key: "user/home_base" },
      { type: "fact", subject: "Standup cadence", content: knownContent },
    ]);

    const result = await runExtractStage(
      { now: () => TEST_NOW, maxEpisodes: 8, contextLookupEnabled: true, costCapUsd: 10 },
      { port, createExtractLlm: () => llm },
    );

    expect(result.summary.episodesScanned).toBe(1);
    expect(result.summary.candidatesEmitted).toBe(3);

    const byDisposition = Object.fromEntries(result.candidates.map((candidate) => [candidate.claimKey ?? candidate.subject, candidate]));

    expect(byDisposition["user/coffee_preference"]?.disposition).toBe("new");
    expect(byDisposition["user/home_base"]?.disposition).toBe("refines");
    expect(byDisposition["user/home_base"]?.refinesDurableId).toBe("home-1");
    expect(byDisposition["Standup cadence"]?.disposition).toBe("known");

    expect(result.summary.newCandidates).toBe(1);
    expect(result.summary.refineCandidates).toBe(1);
    expect(result.summary.knownCandidates).toBe(1);
  });

  it("reports cost capped after the extraction call that exhausts budget", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);
    await insertEpisode(client, { id: "ep-1", summary: "Session about a durable coffee preference." });
    await insertEpisode(client, { id: "ep-2", summary: "Session about another durable preference." });

    const llm = new FakeExtractLlm([{ type: "preference", subject: "Coffee", content: "Prefers oat milk in coffee.", claim_key: "user/coffee_preference" }], 1);

    const result = await runExtractStage(
      { now: () => TEST_NOW, maxEpisodes: 8, contextLookupEnabled: true, costCapUsd: 1 },
      { port, createExtractLlm: () => llm },
    );

    expect(result.status).toBe("cost_capped");
    expect(result.summary.episodesScanned).toBe(1);
    expect(result.summary.candidatesEmitted).toBe(1);
    expect(result.usage.estimatedCostUsd).toBe(1);
    expect(llm.calls).toBe(1);
  });

  it("treats every candidate as new when context-lookup is disabled", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    await insertDurable(client, {
      id: "home-1",
      subject: "Home base",
      content: "Home base is Boston.",
      type: "fact",
      claim_key: "user/home_base",
    });
    await insertEpisode(client, { id: "ep-1", summary: "Session about relocation plans." });

    const llm = new FakeExtractLlm([
      { type: "fact", subject: "Home base", content: "Home base is now San Francisco going forward.", claim_key: "user/home_base" },
    ]);

    const result = await runExtractStage(
      { now: () => TEST_NOW, maxEpisodes: 8, contextLookupEnabled: false, costCapUsd: 10 },
      { port, createExtractLlm: () => llm },
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.disposition).toBe("new");
  });

  it("inserts only new candidates and records insert actions", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    await insertDurable(client, {
      id: "home-1",
      subject: "Home base",
      content: "Home base is Boston.",
      type: "fact",
      claim_key: "user/home_base",
    });
    await insertEpisode(client, { id: "ep-1", summary: "Session about coffee and relocation." });

    const llm = new FakeExtractLlm([
      { type: "preference", subject: "Coffee", content: "Prefers oat milk in coffee during daily standups.", claim_key: "user/coffee_preference" },
      { type: "fact", subject: "Home base", content: "Home base is now San Francisco going forward.", claim_key: "user/home_base" },
    ]);

    const runId = await port.createRun({ tier: "standard", dryRun: false });
    const extract = await runExtractStage(
      { now: () => TEST_NOW, maxEpisodes: 8, contextLookupEnabled: true, costCapUsd: 10 },
      { port, createExtractLlm: () => llm },
    );

    const applied = await applyExtractedDurables(
      { runId, candidates: extract.candidates, now: () => TEST_NOW },
      { port, embedding: createDeterministicEmbedding() },
    );
    expect(applied.inserted).toBe(1);

    const newCandidate = extract.candidates.find((candidate) => candidate.disposition === "new");
    const inserted = await getDurable(client, newCandidate?.id ?? "");
    expect(inserted?.claim_key).toBe("user/coffee_preference");
    expect(inserted?.claim_key_source).toBe("dreaming_extract");
    expect(inserted?.claim_key_status).toBe("tentative");
    expect(inserted?.embedding?.length).toBe(1024);

    const actions = await port.getRunActions(runId);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.actionType).toBe("insert_durable");
    expect(actions[0]?.durableIds).toEqual([newCandidate?.id]);
  });
});
