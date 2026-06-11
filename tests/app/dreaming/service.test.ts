import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDreamPort } from "../../../src/adapters/db/dreaming-port.js";
import { getDurable } from "../../../src/adapters/db/queries.js";
import type { DreamPort } from "../../../src/app/dreaming/ports.js";
import { backupDatabaseFile, runDream } from "../../../src/app/dreaming/service.js";
import type { WorkingMemoryRepository } from "../../../src/app/working-memory/repository.js";
import type { WorkingSetRecord } from "../../../src/app/working-memory/records.js";
import type { EmbeddingPort, LlmPort } from "../../../src/core/ports.js";
import { computeNormContentHash } from "../../../src/core/store/hashing.js";
import { createDeterministicEmbedding, createTestClient, insertDurable } from "../../helpers/dreaming-reconcile.js";

/** Extraction LLM double returning a fixed durable set for pipeline wiring tests. */
class PipelineExtractLlm implements LlmPort {
  public readonly metadata = { usage: { inputTokens: 0, outputTokens: 0, totalCost: 0 } };

  public constructor(
    private readonly durables: Array<Record<string, unknown>>,
    private readonly costPerCall = 0,
  ) {}

  public async complete(): Promise<string> {
    throw new Error("complete() is not used by the extract stage.");
  }

  public async completeJson<T>(): Promise<T> {
    this.metadata.usage.inputTokens += 1;
    this.metadata.usage.totalCost += this.costPerCall;
    return { durables: this.durables } as T;
  }
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function insertEpisode(client: Client, id: string, summary: string, overrides: { startedAt?: string; createdAt?: string } = {}): Promise<void> {
  const startedAt = overrides.startedAt ?? "2026-04-04T10:00:00.000Z";
  const createdAt = overrides.createdAt ?? "2026-04-04T11:00:00.000Z";
  await client.execute({
    sql: `
      INSERT INTO episodes (id, source, source_id, started_at, ended_at, summary, created_at, updated_at)
      VALUES (?, 'openclaw', ?, ?, '2026-04-04T11:00:00.000Z', ?, ?, ?)
    `,
    args: [id, `session-${id}`, startedAt, summary, createdAt, createdAt],
  });
}

function createDreamPortDouble(overrides: Partial<DreamPort> = {}): DreamPort {
  const port: DreamPort = {
    getDailyCost: vi.fn(async () => 0),
    createRun: vi.fn(async () => "run-1"),
    completeRun: vi.fn(async () => undefined),
    logRunAction: vi.fn(async () => undefined),
    getLastRun: vi.fn(async () => null),
    getLastCompletedRun: vi.fn(async () => null),
    getRunHistory: vi.fn(async () => []),
    getRecentAppliedLightRuns: vi.fn(async () => []),
    getRunActions: vi.fn(async () => []),
    getRunProposals: vi.fn(async () => []),
    getProposal: vi.fn(async () => null),
    getProposalStagingActionDetails: vi.fn(async () => null),
    reviewProposal: vi.fn(async () => false),
    listProposalBacklog: vi.fn(async () => []),
    getHealthStats: vi.fn(async () => ({
      total: 0,
      byType: {},
      claimKeyLifecycle: { trusted: 0, tentative: 0, unresolved: 0, noKey: 0 },
      proposalBacklogCount: 0,
      eligibleProposalBacklogCount: 0,
      oldestOpenProposalCreatedAt: null,
      recency: { last7: 0, last30: 0, d30To90: 0, d90Plus: 0 },
      recall: { never: 0, oneToFive: 0, fivePlus: 0 },
      quality: { high: 0, medium: 0, low: 0, average: 0 },
    })),
    listReconcileDurables: vi.fn(async () => []),
    listUnsynthesizedEpisodeEvidence: vi.fn(async () => []),
    countUnsynthesizedEpisodes: vi.fn(async () => 0),
    markEpisodesSynthesized: vi.fn(async () => undefined),
    listSessionHostStoreDurables: vi.fn(async () => []),
    findActiveDurablesByClaimKey: vi.fn(async () => []),
    listActiveClaimKeyContext: vi.fn(async () => []),
    findExistingNormContentHashes: vi.fn(async () => new Set<string>()),
    insertDurable: vi.fn(async () => "durable-1"),
    supersedeDurable: vi.fn(async () => true),
    getDurable: vi.fn(async () => null),
    getDurables: vi.fn(async () => []),
    closeDurableValidity: vi.fn(async () => false),
    updateDurable: vi.fn(async () => false),
    logRunProposal: vi.fn(async () => undefined),
    countEpisodesSince: vi.fn(async () => 0),
    countIngestFilesSince: vi.fn(async () => 0),
    countDurablesCreatedSince: vi.fn(async () => 0),
    sumDurableImportanceCreatedSince: vi.fn(async () => 0),
    updateDreamState: vi.fn(async () => undefined),
    createProfileSnapshot: vi.fn(async () => undefined),
    getActiveProfileSnapshot: vi.fn(async () => null),
    tryAcquireRunLock: vi.fn(async () => true),
    heartbeatRunLock: vi.fn(async () => true),
    releaseRunLock: vi.fn(async () => undefined),
    withTransaction: vi.fn(async (fn) => fn(port)),
    ...overrides,
  };

  return port;
}

describe("runDream pipeline integration", () => {
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    clients.length = 0;
  });

  it("runs extract and temporalize, inserting new durables and superseding revised ones", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    await insertDurable(client, {
      id: "home-1",
      subject: "Home base",
      content: "Home base is Boston for the foreseeable future.",
      type: "fact",
      claim_key: "user/home_base",
      claim_key_status: "trusted",
      valid_from: "2026-01-01T00:00:00.000Z",
    });
    await insertEpisode(client, "ep-1", "Session covering the move to San Francisco and a coffee preference.");

    const llm = new PipelineExtractLlm(
      [
        { type: "preference", subject: "Coffee", content: "Prefers oat milk in coffee during daily standups.", claim_key: "user/coffee_preference" },
        { type: "fact", subject: "Home base", content: "Home base is now San Francisco for the foreseeable future.", claim_key: "user/home_base" },
      ],
      0.25,
    );

    const result = await runDream(
      { tier: "standard", apply: true, verbose: false, json: false, skipBackup: true },
      {
        port,
        config: null,
        now: () => new Date("2026-04-04T15:00:00.000Z"),
        createExtractLlm: () => llm,
        embedding: createDeterministicEmbedding(),
      },
    );

    expect(result.status).toBe("completed");
    expect(result.completionSummary?.extract?.newCandidates).toBe(1);
    expect(result.completionSummary?.extract?.durablesInserted).toBe(1);
    expect(result.completionSummary?.temporalize?.revisionsApplied).toBe(1);

    const successorRow = await client.execute({
      sql: `SELECT embedding FROM durables WHERE claim_key_source = 'dreaming_temporalize' LIMIT 1`,
      args: [],
    });
    expect(successorRow.rows[0]?.embedding).toBeTruthy();

    const predecessor = await client.execute({ sql: `SELECT superseded_by, valid_to FROM durables WHERE id = ?`, args: ["home-1"] });
    expect(predecessor.rows[0]?.superseded_by).toBeTruthy();
    expect(predecessor.rows[0]?.valid_to).toBe("2026-04-04T15:00:00.000Z");

    const successor = await getDurable(client, predecessor.rows[0]?.superseded_by as string);
    expect(successor?.content).toBe("Home base is now San Francisco for the foreseeable future.");
    expect(successor?.claim_key_source).toBe("dreaming_temporalize");

    const activeProfile = await port.getActiveProfileSnapshot();
    expect(activeProfile?.id).toBe(result.completionSummary?.project?.snapshotId);
    expect(activeProfile?.durableIds.length).toBeGreaterThan(0);
    expect(result.completionSummary?.project).toMatchObject({
      applied: true,
      profileDurableCount: expect.any(Number),
    });
  });
});

describe("runDream", () => {
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    clients.length = 0;
  });

  it("records a budget_exhausted run when the daily dreaming cost cap is already exhausted", async () => {
    const completeRun = vi.fn(async () => undefined);
    const port = createDreamPortDouble({
      getDailyCost: vi.fn(async () => 2.5),
      completeRun,
    });

    const result = await runDream(
      {
        tier: "standard",
        apply: false,
        verbose: false,
        json: false,
      },
      {
        port,
        config: { dreaming: { dailyCostCap: 2.5 } },
      },
    );

    expect(result.status).toBe("budget_exhausted");
    expect(result.summary).toContain("Daily dreaming cost cap reached");
    expect(result.actionsTaken).toBe(0);
    expect(completeRun).toHaveBeenCalledWith(
      result.runId,
      expect.objectContaining({
        status: "budget_exhausted",
        error: expect.stringContaining("Daily dreaming cost cap reached"),
        summaryJson: expect.objectContaining({
          observations: [expect.stringContaining("Daily dreaming cost cap reached")],
        }),
      }),
    );
  });

  it("rejects disabled dreaming tiers before creating run state", async () => {
    const getDailyCost = vi.fn(async () => 0);
    const createRun = vi.fn(async () => "run-1");
    const port = createDreamPortDouble({
      getDailyCost,
      createRun,
    });

    await expect(
      runDream(
        {
          tier: "standard",
          apply: false,
          verbose: false,
          json: false,
        },
        {
          port,
          config: { dreaming: { tiers: { standard: { enabled: false } } } },
        },
      ),
    ).rejects.toThrow('Dreaming tier "standard" is disabled in config.');

    expect(getDailyCost).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });

  it("records skipped reconcile and prune stages for light runs", async () => {
    const completeRun = vi.fn(async () => undefined);
    const port = createDreamPortDouble({
      completeRun,
      getLastRun: vi.fn(async () => null),
      listReconcileDurables: vi.fn(async () => []),
    });

    const result = await runDream(
      {
        tier: "light",
        apply: false,
        verbose: false,
        json: false,
      },
      {
        port,
        config: null,
        now: () => new Date("2026-06-05T12:00:00.000Z"),
      },
    );

    expect(result.status).toBe("completed");
    expect(result.tier).toBe("light");
    expect(result.actionsTaken).toBe(0);
    expect(completeRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        status: "completed",
        summaryJson: expect.objectContaining({
          stages_skipped: [
            { stage: "reconcile", reason: "light_tier" },
            { stage: "prune", reason: "light_tier" },
            { stage: "reap", reason: "light_tier" },
          ],
          durables_skipped: [],
        }),
      }),
    );
    expect(result.completionSummary?.reconcile).toBeUndefined();
  });

  it("skips reconcile and prune on light tier without calling the reconcile LLM factory", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    await insertDurable(client, {
      id: "missing-claim",
      subject: "Office preference",
      content: "Prefers quiet desks for focus work.",
      type: "preference",
    });
    await insertEpisode(client, "ep-1", "Session about the user's coffee preferences.");

    const createExtractLlm = vi.fn(() => new PipelineExtractLlm([]));
    const createClaimExtractionLlm = vi.fn(() => new PipelineExtractLlm([]));
    const result = await runDream(
      {
        tier: "light",
        apply: false,
        verbose: false,
        json: false,
      },
      {
        port,
        config: null,
        now: () => new Date("2026-06-05T12:00:00.000Z"),
        createExtractLlm,
        createClaimExtractionLlm,
      },
    );

    expect(result.status).toBe("completed");
    expect(result.completionSummary?.stages_skipped).toEqual([
      { stage: "reconcile", reason: "light_tier" },
      { stage: "prune", reason: "light_tier" },
      { stage: "reap", reason: "light_tier" },
    ]);
    expect(result.completionSummary?.reconcile).toBeUndefined();
    expect(result.completionSummary?.prune).toBeUndefined();
    expect(createClaimExtractionLlm).not.toHaveBeenCalled();
  });

  it("caps light-tier extract at two episode sessions by default", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    for (let index = 1; index <= 3; index += 1) {
      await insertEpisode(client, `ep-${index}`, `Session ${index} about coffee preferences.`);
    }

    const llm = new PipelineExtractLlm(
      [{ type: "preference", subject: "Coffee", content: "Prefers oat milk in coffee.", claim_key: "user/coffee_preference" }],
      0,
    );

    const result = await runDream(
      {
        tier: "light",
        apply: false,
        verbose: false,
        json: false,
      },
      {
        port,
        config: null,
        now: () => new Date("2026-06-05T12:00:00.000Z"),
        createExtractLlm: () => llm,
      },
    );

    expect(result.completionSummary?.extract?.episodesScanned).toBe(2);
  });

  it("does not let light-tier extract inherit the standard extract session cap", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    for (let index = 1; index <= 4; index += 1) {
      await insertEpisode(client, `ep-${index}`, `Session ${index} about coffee preferences.`);
    }

    const llm = new PipelineExtractLlm(
      [{ type: "preference", subject: "Coffee", content: "Prefers oat milk in coffee.", claim_key: "user/coffee_preference" }],
      0,
    );

    const result = await runDream(
      {
        tier: "light",
        apply: false,
        verbose: false,
        json: false,
      },
      {
        port,
        config: { dreaming: { stages: { extract: { maxSessionsPerRun: 4 } } } },
        now: () => new Date("2026-06-05T12:00:00.000Z"),
        createExtractLlm: () => llm,
      },
    );

    expect(result.completionSummary?.extract?.episodesScanned).toBe(2);
  });

  it("uses the configured light-tier extract session cap", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    for (let index = 1; index <= 4; index += 1) {
      await insertEpisode(client, `ep-${index}`, `Session ${index} about coffee preferences.`);
    }

    const llm = new PipelineExtractLlm(
      [{ type: "preference", subject: "Coffee", content: "Prefers oat milk in coffee.", claim_key: "user/coffee_preference" }],
      0,
    );

    const result = await runDream(
      {
        tier: "light",
        apply: false,
        verbose: false,
        json: false,
      },
      {
        port,
        config: { dreaming: { stages: { extract: { lightMaxSessionsPerRun: 3, maxSessionsPerRun: 4 } } } },
        now: () => new Date("2026-06-05T12:00:00.000Z"),
        createExtractLlm: () => llm,
      },
    );

    expect(result.completionSummary?.extract?.episodesScanned).toBe(3);
  });

  it("never re-mines episodes that an apply run already synthesized", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    await insertEpisode(client, "ep-1", "Session about the user's coffee preferences.");

    const first = await runDream(
      { tier: "light", apply: true, verbose: false, json: false, skipBackup: true },
      {
        port,
        config: null,
        now: () => new Date("2026-06-05T12:00:00.000Z"),
        createExtractLlm: () =>
          new PipelineExtractLlm([{ type: "preference", subject: "Coffee", content: "Prefers oat milk in coffee.", claim_key: "user/coffee_preference" }]),
        embedding: createDeterministicEmbedding(),
      },
    );

    expect(first.completionSummary?.extract?.episodesScanned).toBe(1);
    expect(first.completionSummary?.extract?.durablesInserted).toBe(1);

    // A rephrased mining output must not become a duplicate durable: the
    // episode was synthesized by the first run and is never read again.
    const second = await runDream(
      { tier: "light", apply: true, verbose: false, json: false, skipBackup: true },
      {
        port,
        config: null,
        now: () => new Date("2026-06-05T13:00:00.000Z"),
        createExtractLlm: () =>
          new PipelineExtractLlm([
            { type: "preference", subject: "Coffee habits", content: "Oat milk is the user's go-to coffee milk.", claim_key: "user/coffee_milk" },
          ]),
        embedding: createDeterministicEmbedding(),
      },
    );

    expect(second.completionSummary?.extract?.episodesScanned).toBe(0);
    expect(second.completionSummary?.extract?.durablesInserted).toBe(0);

    const synthesized = await client.execute("SELECT episode_id, run_id FROM dream_synthesized_episodes");
    expect(synthesized.rows).toHaveLength(1);
    expect(synthesized.rows[0]?.episode_id).toBe("ep-1");
    expect(synthesized.rows[0]?.run_id).toBe(first.runId);
  });

  it("does not mark episodes synthesized during dry runs", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    await insertEpisode(client, "ep-1", "Session about the user's coffee preferences.");

    const dryRun = await runDream(
      { tier: "light", apply: false, verbose: false, json: false },
      {
        port,
        config: null,
        now: () => new Date("2026-06-05T12:00:00.000Z"),
        createExtractLlm: () => new PipelineExtractLlm([]),
      },
    );

    expect(dryRun.completionSummary?.extract?.episodesScanned).toBe(1);

    const synthesized = await client.execute("SELECT COUNT(*) AS count FROM dream_synthesized_episodes");
    expect(Number(synthesized.rows[0]?.count)).toBe(0);

    const applyRun = await runDream(
      { tier: "light", apply: true, verbose: false, json: false, skipBackup: true },
      {
        port,
        config: null,
        now: () => new Date("2026-06-05T13:00:00.000Z"),
        createExtractLlm: () => new PipelineExtractLlm([]),
        embedding: createDeterministicEmbedding(),
      },
    );

    expect(applyRun.completionSummary?.extract?.episodesScanned).toBe(1);
  });

  it("scans evidence since the last completed run instead of the in-flight run", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    await insertEpisode(client, "ep-1", "Session before the first run.", { createdAt: "2026-06-05T11:00:00.000Z" });

    const first = await runDream(
      { tier: "light", apply: true, verbose: false, json: false, skipBackup: true },
      {
        port,
        config: null,
        now: () => new Date("2026-06-05T12:00:00.000Z"),
        createExtractLlm: () => new PipelineExtractLlm([]),
        embedding: createDeterministicEmbedding(),
      },
    );

    expect(first.completionSummary?.scan?.episodesSinceLastRun).toBe(1);

    await insertEpisode(client, "ep-2", "Session after the first run.", { createdAt: "2026-06-05T13:00:00.000Z" });

    const second = await runDream(
      { tier: "light", apply: true, verbose: false, json: false, skipBackup: true },
      {
        port,
        config: null,
        now: () => new Date("2026-06-05T14:00:00.000Z"),
        createExtractLlm: () => new PipelineExtractLlm([]),
        embedding: createDeterministicEmbedding(),
      },
    );

    // Before episode-synthesis tracking, the in-flight run's own `running` row
    // reset the cursor to the epoch and every run re-counted all episodes.
    expect(second.completionSummary?.scan?.episodesSinceLastRun).toBe(1);
    expect(second.completionSummary?.scan?.episodesPendingSynthesis).toBe(1);
    expect(second.completionSummary?.extract?.episodesScanned).toBe(1);
  });

  it("preserves cost-capped status when extract exhausts the remaining run budget", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    await insertDurable(client, {
      id: "missing-1",
      subject: "Office preference",
      content: "Prefers quiet desks for focus work.",
      type: "preference",
    });
    await insertEpisode(client, "ep-1", "Session about the user's coffee preferences.");

    const llm = new PipelineExtractLlm(
      [{ type: "preference", subject: "Coffee", content: "Prefers oat milk in coffee.", claim_key: "user/coffee_preference" }],
      1,
    );
    const createClaimExtractionLlm = vi.fn(() => new PipelineExtractLlm([]));

    const result = await runDream(
      {
        tier: "standard",
        apply: false,
        verbose: false,
        json: false,
      },
      {
        port,
        config: { dreaming: { dailyCostCap: 1 } },
        now: () => new Date("2026-04-04T15:00:00.000Z"),
        createExtractLlm: () => llm,
        createClaimExtractionLlm,
      },
    );

    expect(result.status).toBe("cost_capped");
    expect(result.estimatedCostUsd).toBe(1);
    expect(result.completionSummary?.extract?.episodesScanned).toBe(1);
    expect(result.completionSummary?.observations).toContain("Extract stage stopped early after reaching the daily dreaming cost cap.");
    expect(createClaimExtractionLlm).not.toHaveBeenCalled();

    const lastRun = await port.getLastRun();
    expect(lastRun?.status).toBe("cost_capped");
    expect(lastRun?.estimatedCostUsd).toBe(1);
  });

  it("does not apply a profile snapshot when an apply run is cost-capped", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    await insertDurable(client, {
      id: "profile-seed",
      subject: "Profile seed",
      content: "Prefers quiet desks for focus work.",
      type: "preference",
      claim_key: "user/office_preference",
      claim_key_status: "trusted",
    });
    await insertEpisode(client, "ep-1", "Session about the user's coffee preferences.");

    const llm = new PipelineExtractLlm(
      [{ type: "preference", subject: "Coffee", content: "Prefers oat milk in coffee.", claim_key: "user/coffee_preference" }],
      1,
    );

    const result = await runDream(
      {
        tier: "standard",
        apply: true,
        verbose: false,
        json: false,
        skipBackup: true,
      },
      {
        port,
        config: { dreaming: { dailyCostCap: 1 } },
        now: () => new Date("2026-04-04T15:00:00.000Z"),
        createExtractLlm: () => llm,
        embedding: createDeterministicEmbedding(),
      },
    );

    expect(result.status).toBe("cost_capped");
    expect(result.completionSummary?.project).toMatchObject({
      applied: false,
      snapshotId: null,
    });
    expect(await port.getActiveProfileSnapshot()).toBeNull();

    const persisted = await client.execute("SELECT COUNT(*) AS count FROM profile_snapshots");
    expect(Number(persisted.rows[0]?.count)).toBe(0);
  });

  it("does not activate project-scoped profile snapshots globally", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    await insertDurable(client, {
      id: "agenr-policy",
      subject: "Agenr workflow",
      content: "Agenr work uses pnpm check before committing.",
      type: "decision",
      expiry: "core",
      importance: 9,
      project: "agenr",
      claim_key: "agenr/workflow",
      claim_key_status: "trusted",
    });

    const result = await runDream(
      {
        tier: "standard",
        project: "agenr",
        apply: true,
        verbose: false,
        json: false,
        skipBackup: true,
      },
      {
        port,
        config: null,
        now: () => new Date("2026-04-04T15:00:00.000Z"),
      },
    );

    expect(result.status).toBe("completed");
    expect(result.completionSummary?.project).toMatchObject({
      profileDurableCount: 1,
      applied: false,
      snapshotId: null,
    });
    expect(await port.getActiveProfileSnapshot()).toBeNull();

    const persisted = await client.execute("SELECT COUNT(*) AS count FROM profile_snapshots");
    expect(Number(persisted.rows[0]?.count)).toBe(0);
  });

  it("runs prune after projection while protecting the projected profile bundle", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    for (let index = 0; index < 8; index += 1) {
      await insertDurable(client, {
        id: `core-${index}`,
        subject: `Core durable ${index}`,
        content: `Core durable ${index} should remain in the profile bundle.`,
        type: "fact",
        expiry: "core",
        importance: 9,
        claim_key: `user/core_${index}`,
        claim_key_status: "trusted",
      });
    }
    await insertDurable(client, {
      id: "temporary-low",
      subject: "Temporary low signal",
      content: "Temporary low signal session artifact.",
      type: "fact",
      expiry: "temporary",
      importance: 2,
      claim_key: "user/temp_artifact",
      claim_key_status: "tentative",
    });

    const result = await runDream(
      {
        tier: "standard",
        apply: true,
        verbose: false,
        json: false,
        skipBackup: true,
      },
      {
        port,
        config: null,
        now: () => new Date("2026-04-04T15:00:00.000Z"),
      },
    );

    expect(result.completionSummary?.prune).toMatchObject({
      candidatesIdentified: 1,
      candidatesRetirable: 1,
      durablesStaled: 1,
      dryRun: false,
    });
    expect(result.completionSummary?.efficiency).toMatchObject({
      synthesizedDurableMutations: 1,
      profileInjectionTokenEstimate: 8 * 36,
      recomputeRatio: 0.111111,
    });

    const staled = await client.execute({ sql: `SELECT valid_to, supersession_kind, supersession_reason FROM durables WHERE id = ?`, args: ["temporary-low"] });
    expect(staled.rows[0]?.valid_to).toBeTruthy();
    expect(staled.rows[0]?.supersession_kind).toBe("stale");
    expect(staled.rows[0]?.supersession_reason).toBe("Dream prune staled a temporary durable after synthesis.");

    const activeProfile = await port.getActiveProfileSnapshot();
    expect(activeProfile?.durableIds).not.toContain("temporary-low");
    expect(activeProfile?.durableIds).toHaveLength(8);
  });

  it("records partial apply results when a later stage fails", async () => {
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
    await insertEpisode(client, "ep-1", "Session covering the move to San Francisco and a coffee preference.");

    const llm = new PipelineExtractLlm(
      [
        { type: "preference", subject: "Coffee", content: "Prefers oat milk in coffee during daily standups.", claim_key: "user/coffee_preference" },
        { type: "fact", subject: "Home base", content: "Home base is now San Francisco for the foreseeable future.", claim_key: "user/home_base" },
      ],
      0.25,
    );
    const embedding = createFailingSecondEmbedPort();

    await expect(
      runDream(
        {
          tier: "standard",
          apply: true,
          verbose: false,
          json: false,
          skipBackup: true,
        },
        {
          port,
          config: null,
          now: () => new Date("2026-04-04T15:00:00.000Z"),
          createExtractLlm: () => llm,
          embedding,
        },
      ),
    ).rejects.toThrow("Temporalize embedding failed");

    const lastRun = await port.getLastRun();
    expect(lastRun?.status).toBe("failed");

    const actions = await port.getRunActions(lastRun?.id ?? "");
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.some((action) => action.actionType === "insert_durable")).toBe(true);

    expect(lastRun?.actionsTaken).toBe(actions.length);
    expect(lastRun?.estimatedCostUsd).toBe(0.25);
    expect(lastRun?.summaryJson?.actions_taken).toBe(actions.length);
    expect(lastRun?.summaryJson?.extract?.durablesInserted).toBe(1);
    expect(lastRun?.summaryJson?.temporalize).toBeUndefined();
    expect(lastRun?.error).toBe("Temporalize embedding failed");
  });

  it("reports a low recomputeRatio for light-tier runs with known extract candidates", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);
    const knownContent = "Standups happen every weekday at 9am sharp in the team channel.";

    await insertDurable(client, {
      id: "known-1",
      subject: "Standup cadence",
      content: knownContent,
      type: "fact",
      norm_content_hash: computeNormContentHash(knownContent),
    });
    await insertEpisode(client, "ep-1", "Session covering standup cadence.");

    const llm = new PipelineExtractLlm([{ type: "fact", subject: "Standup cadence", content: knownContent }]);

    const result = await runDream(
      {
        tier: "light",
        apply: true,
        verbose: false,
        json: false,
        skipBackup: true,
      },
      {
        port,
        config: null,
        now: () => new Date("2026-06-05T12:00:00.000Z"),
        createExtractLlm: () => llm,
        embedding: createDeterministicEmbedding(),
      },
    );

    expect(result.completionSummary?.extract?.knownCandidates).toBe(1);
    expect(result.completionSummary?.extract?.durablesInserted).toBe(0);
    expect(result.completionSummary?.efficiency?.synthesizedDurableMutations).toBe(0);
    expect(result.completionSummary?.efficiency?.recomputeRatio).toBeLessThan(0.5);
  });

  it("reports higher recomputeRatio on deep tier than incremental standard runs", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    for (let index = 1; index <= 4; index += 1) {
      await insertEpisode(client, `ep-${index}`, `Session ${index} about project planning.`);
    }

    const firstRunLlm = new PipelineExtractLlm(
      [
        {
          type: "preference",
          subject: "Planning",
          content: "Prefers written plans before implementation.",
          claim_key: "user/planning_style",
        },
      ],
      0.1,
    );

    const baseline = await runDream(
      {
        tier: "standard",
        apply: true,
        verbose: false,
        json: false,
        skipBackup: true,
      },
      {
        port,
        config: null,
        now: () => new Date("2026-04-04T10:00:00.000Z"),
        createExtractLlm: () => firstRunLlm,
        embedding: createDeterministicEmbedding(),
      },
    );

    expect(baseline.completionSummary?.efficiency?.recomputeRatio).toBeCloseTo(0.25, 6);

    await insertEpisode(client, "ep-5", "Session 5 about project planning.");

    const incremental = await runDream(
      {
        tier: "standard",
        apply: false,
        verbose: false,
        json: false,
      },
      {
        port,
        config: null,
        now: () => new Date("2026-04-04T11:00:00.000Z"),
        createExtractLlm: () => new PipelineExtractLlm([]),
      },
    );

    const deep = await runDream(
      {
        tier: "deep",
        apply: true,
        verbose: false,
        json: false,
        skipBackup: true,
      },
      {
        port,
        config: null,
        now: () => new Date("2026-04-04T12:00:00.000Z"),
        createExtractLlm: () =>
          new PipelineExtractLlm(
            [
              {
                type: "preference",
                subject: "Review cadence",
                content: "Prefers Friday design reviews.",
                claim_key: "user/review_cadence",
              },
            ],
            0.1,
          ),
        embedding: createDeterministicEmbedding(),
      },
    );

    expect(incremental.completionSummary?.efficiency?.recomputeRatio).toBe(0);
    expect(deep.completionSummary?.efficiency?.recomputeRatio ?? 0).toBeGreaterThan(incremental.completionSummary?.efficiency?.recomputeRatio ?? 0);
  });

  it("records costPerSynthesizedDurableUsd when durable mutations occur", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    await insertEpisode(client, "ep-1", "Session about the user's coffee preferences.");

    const llm = new PipelineExtractLlm(
      [{ type: "preference", subject: "Coffee", content: "Prefers oat milk in coffee.", claim_key: "user/coffee_preference" }],
      0.2,
    );

    const result = await runDream(
      {
        tier: "standard",
        apply: true,
        verbose: false,
        json: false,
        skipBackup: true,
      },
      {
        port,
        config: null,
        now: () => new Date("2026-04-04T15:00:00.000Z"),
        createExtractLlm: () => llm,
        embedding: createDeterministicEmbedding(),
      },
    );

    expect(result.completionSummary?.efficiency?.synthesizedDurableMutations).toBeGreaterThan(0);
    expect(result.completionSummary?.efficiency?.costPerSynthesizedDurableUsd).toBe(0.2);
  });

  it("does not increment synthesizedDurableMutations for known extract candidates", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);
    const knownContent = "Standups happen every weekday at 9am sharp in the team channel.";

    await insertDurable(client, {
      id: "known-1",
      subject: "Standup cadence",
      content: knownContent,
      type: "fact",
      norm_content_hash: computeNormContentHash(knownContent),
    });
    await insertEpisode(client, "ep-1", "Session covering standup cadence.");

    const llm = new PipelineExtractLlm([{ type: "fact", subject: "Standup cadence", content: knownContent }]);

    const result = await runDream(
      {
        tier: "light",
        apply: true,
        verbose: false,
        json: false,
        skipBackup: true,
      },
      {
        port,
        config: null,
        now: () => new Date("2026-06-05T12:00:00.000Z"),
        createExtractLlm: () => llm,
        embedding: createDeterministicEmbedding(),
      },
    );

    expect(result.completionSummary?.extract?.knownCandidates).toBe(1);
    expect(result.completionSummary?.extract?.durablesInserted).toBe(0);
    expect(result.completionSummary?.efficiency?.synthesizedDurableMutations).toBe(0);
  });
});

describe("runDream reap stage", () => {
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    clients.length = 0;
  });

  it("reaps aged terminal working sets on standard apply runs and logs reap actions", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);
    const reapable = buildTerminalWorkingSet("ws-old", "2026-04-01T00:00:00.000Z");
    const pending = buildTerminalWorkingSet("ws-pending", "2026-04-01T00:00:00.000Z", {
      snapshot: {
        candidates: [
          {
            kind: "semantic",
            subject: "Release cadence",
            content: "Releases ship monthly.",
            provenance: { evidenceEventSequences: [2] },
            promotionStatus: "pending",
          },
        ],
      },
    });
    const workingMemory = createReapWorkingMemoryDouble([reapable, pending]);

    const result = await runDream(
      { tier: "standard", apply: true, verbose: false, json: false, skipBackup: true },
      {
        port,
        workingMemory: workingMemory.repository,
        config: null,
        now: () => new Date("2026-06-11T12:00:00.000Z"),
      },
    );

    expect(result.status).toBe("completed");
    expect(result.completionSummary?.reap).toEqual({
      terminalSetsScanned: 2,
      setsReaped: 1,
      eventsReaped: 2,
      setsSkippedPendingCandidates: 1,
      retentionDays: 30,
      dryRun: false,
    });
    expect(workingMemory.deletedIds).toEqual(["ws-old"]);
    expect(result.actionsTaken).toBe(1);
    expect(result.completionSummary?.observations).toContainEqual(expect.stringContaining("pending promotion"));

    const actions = await port.getRunActions(result.runId);
    const reapActions = actions.filter((action) => action.actionType === "reap_working_set");
    expect(reapActions).toHaveLength(1);
    expect(reapActions[0]?.details).toMatchObject({
      stage: "reap",
      working_set_id: "ws-old",
      working_set_status: "closed",
    });
  });

  it("reports reapable sets without deleting on dry runs", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);
    const workingMemory = createReapWorkingMemoryDouble([buildTerminalWorkingSet("ws-old", "2026-04-01T00:00:00.000Z")]);

    const result = await runDream(
      { tier: "standard", apply: false, verbose: false, json: false },
      {
        port,
        workingMemory: workingMemory.repository,
        config: null,
        now: () => new Date("2026-06-11T12:00:00.000Z"),
      },
    );

    expect(result.completionSummary?.reap).toMatchObject({ setsReaped: 1, eventsReaped: 0, dryRun: true });
    expect(workingMemory.deletedIds).toEqual([]);
    const actions = await port.getRunActions(result.runId);
    expect(actions.filter((action) => action.actionType === "reap_working_set")).toHaveLength(0);
  });

  it("honors the configured retention window", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);
    // Closed 10 days before the run, inside the default 30-day window but
    // outside a configured 7-day window.
    const workingMemory = createReapWorkingMemoryDouble([buildTerminalWorkingSet("ws-old", "2026-06-01T12:00:00.000Z")]);

    const result = await runDream(
      { tier: "standard", apply: true, verbose: false, json: false, skipBackup: true },
      {
        port,
        workingMemory: workingMemory.repository,
        config: { dreaming: { stages: { reap: { workingSetRetentionDays: 7 } } } },
        now: () => new Date("2026-06-11T12:00:00.000Z"),
      },
    );

    expect(result.completionSummary?.reap).toMatchObject({ retentionDays: 7, setsReaped: 1 });
    expect(workingMemory.deletedIds).toEqual(["ws-old"]);
  });

  it("records a skipped reap stage when no working-memory repository is wired", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    const result = await runDream(
      { tier: "standard", apply: false, verbose: false, json: false },
      {
        port,
        config: null,
        now: () => new Date("2026-06-11T12:00:00.000Z"),
      },
    );

    expect(result.completionSummary?.stages_skipped).toContainEqual({ stage: "reap", reason: "working_memory_unavailable" });
    expect(result.completionSummary?.reap).toBeUndefined();
  });
});

/** Builds one terminal working set closed at the given timestamp. */
function buildTerminalWorkingSet(id: string, closedAt: string, overrides: Partial<WorkingSetRecord> = {}): WorkingSetRecord {
  return {
    id,
    scopeKey: `session:${id}`,
    scopeKind: "session",
    status: "closed",
    snapshot: {},
    revision: 2,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: closedAt,
    lastActiveAt: closedAt,
    closedAt,
    ...overrides,
  };
}

/** Builds a working-memory double that serves and deletes terminal sets. */
function createReapWorkingMemoryDouble(workingSets: WorkingSetRecord[]): { repository: WorkingMemoryRepository; deletedIds: string[] } {
  const store = new Map(workingSets.map((workingSet) => [workingSet.id, workingSet]));
  const deletedIds: string[] = [];
  return {
    deletedIds,
    repository: {
      getWorkingSet: async (id) => store.get(id) ?? null,
      findCurrentWorkingSets: async () => [],
      listWorkingSets: async () => [],
      listWorkingEvents: async () => [],
      createWorkingSet: async () => ({ kind: "active_set_exists", scopeKey: "test" }),
      updateWorkingSet: async () => ({ kind: "not_found" }),
      patchWorkingSetUsage: async () => ({ kind: "not_found" }),
      patchWorkingSetUsageAndUpdate: async () => ({ kind: "not_found" }),
      recordEpisodePromotion: async () => ({ kind: "not_found" }),
      recordCandidateConsolidation: async () => ({ kind: "not_found" }),
      listReapableWorkingSets: async (input) => [...store.values()].filter((workingSet) => (workingSet.closedAt ?? workingSet.updatedAt) < input.closedBefore),
      deleteWorkingSets: async (ids) => {
        let workingSetsDeleted = 0;
        for (const id of ids) {
          if (store.delete(id)) {
            deletedIds.push(id);
            workingSetsDeleted += 1;
          }
        }
        return { workingSetsDeleted, workingEventsDeleted: workingSetsDeleted * 2 };
      },
    },
  };
}

describe("backupDatabaseFile", () => {
  it("backs up file URL database paths and sidecar files", async () => {
    const directory = await createTempDir();
    const dbPath = path.join(directory, "knowledge.db");
    await writeFile(dbPath, "main database", "utf8");
    await writeFile(`${dbPath}-wal`, "wal data", "utf8");

    const backupPath = await backupDatabaseFile(pathToFileURL(dbPath).href);

    expect(path.dirname(backupPath)).toBe(path.join(directory, "backups"));
    await expect(readFile(backupPath, "utf8")).resolves.toBe("main database");
    await expect(readFile(`${backupPath}-wal`, "utf8")).resolves.toBe("wal data");
  });
});

function createFailingSecondEmbedPort(): EmbeddingPort {
  const deterministic = createDeterministicEmbedding();
  let calls = 0;

  return {
    embed: async (texts: string[]): Promise<number[][]> => {
      calls += 1;
      if (calls === 2) {
        throw new Error("Temporalize embedding failed");
      }

      return deterministic.embed(texts);
    },
  };
}

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agenr-dream-service-"));
  tempDirs.push(directory);
  return directory;
}
