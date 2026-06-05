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
import type { EmbeddingPort, LlmPort } from "../../../src/core/ports.js";
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

async function insertEpisode(client: Client, id: string, summary: string): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO episodes (id, source, source_id, started_at, ended_at, summary, retired, created_at, updated_at)
      VALUES (?, 'openclaw', ?, '2026-04-04T10:00:00.000Z', '2026-04-04T11:00:00.000Z', ?, 0, '2026-04-04T11:00:00.000Z', '2026-04-04T11:00:00.000Z')
    `,
    args: [id, `session-${id}`, summary],
  });
}

function createDreamPortDouble(overrides: Partial<DreamPort> = {}): DreamPort {
  const port: DreamPort = {
    getDailyCost: vi.fn(async () => 0),
    createRun: vi.fn(async () => "run-1"),
    completeRun: vi.fn(async () => undefined),
    logRunAction: vi.fn(async () => undefined),
    getLastRun: vi.fn(async () => null),
    getRunHistory: vi.fn(async () => []),
    getRunActions: vi.fn(async () => []),
    getRunProposals: vi.fn(async () => []),
    getProposal: vi.fn(async () => null),
    reviewProposal: vi.fn(async () => false),
    listProposalBacklog: vi.fn(async () => []),
    getHealthStats: vi.fn(async () => ({
      total: 0,
      byType: {},
      claimKeyLifecycle: { trusted: 0, tentative: 0, unresolved: 0, legacy: 0, noKey: 0 },
      proposalBacklogCount: 0,
      eligibleProposalBacklogCount: 0,
      oldestOpenProposalCreatedAt: null,
      recency: { last7: 0, last30: 0, d30To90: 0, d90Plus: 0 },
      recall: { never: 0, oneToFive: 0, fivePlus: 0 },
      quality: { high: 0, medium: 0, low: 0, average: 0 },
    })),
    listReconcileDurables: vi.fn(async () => []),
    listEpisodeEvidenceSince: vi.fn(async () => []),
    findActiveDurablesByClaimKey: vi.fn(async () => []),
    findExistingNormContentHashes: vi.fn(async () => new Set<string>()),
    insertDurable: vi.fn(async () => "durable-1"),
    supersedeDurable: vi.fn(async () => true),
    getDurable: vi.fn(async () => null),
    updateDurable: vi.fn(async () => false),
    logRunProposal: vi.fn(async () => undefined),
    countEpisodesSince: vi.fn(async () => 0),
    countIngestFilesSince: vi.fn(async () => 0),
    countDurablesCreatedSince: vi.fn(async () => 0),
    updateDreamState: vi.fn(async () => undefined),
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
  });
});

describe("runDream", () => {
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    clients.length = 0;
  });

  it("rejects runs when the daily dreaming cost cap is already exhausted", async () => {
    const port = createDreamPortDouble({
      getDailyCost: vi.fn(async () => 2.5),
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
          config: { dreaming: { dailyCostCap: 2.5 } },
        },
      ),
    ).rejects.toThrow("Daily dreaming cost cap reached");
  });

  it("records an empty reconcile summary when the working set is empty", async () => {
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
          durables_skipped: [],
          reconcile: expect.objectContaining({
            before: expect.objectContaining({ totalDurables: 0, activeDurables: 0 }),
          }),
        }),
      }),
    );
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
});

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
