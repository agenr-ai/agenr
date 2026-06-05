import { createClient, type Client } from "@libsql/client";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDreamPort } from "../../../../src/adapters/db/dreaming-port.js";
import { createRecallAdapter } from "../../../../src/adapters/db/recall-adapter.js";
import { initSchema } from "../../../../src/adapters/db/schema.js";
import { insertDurable } from "../../../../src/adapters/db/queries.js";
import { applyExtractedDurables, runExtractStage } from "../../../../src/app/dreaming/extract.js";
import { runTemporalizeStage } from "../../../../src/app/dreaming/temporalize.js";
import type { DreamPort } from "../../../../src/app/dreaming/ports.js";
import { recall } from "../../../../src/core/recall/search.js";
import type { RecallRankingProfile } from "../../../../src/core/recall/types.js";
import type { EmbeddingPort, LlmPort } from "../../../../src/core/ports.js";
import { computeContentHash, computeNormContentHash } from "../../../../src/core/store/hashing.js";
import type { Durable } from "../../../../src/core/types.js";
import { createDeterministicEmbedding } from "../../../helpers/dreaming-reconcile.js";

/**
 * Fixture-backed dreaming extract/temporalize scenarios.
 *
 * Each JSON fixture in this directory seeds a real durable corpus plus episode
 * evidence, then runs the production extract -> apply -> temporalize stages with
 * a deterministic mining LLM double. The scenarios are the runnable skeleton the
 * `agenr-evals` extract and temporal-correctness suites build on. They prove,
 * end to end, that implicit preferences become durables, trips supersede prior
 * location beliefs without in-place rewrites, point-in-time recall still
 * recovers a superseded belief, and distinct durables are never over-merged.
 *
 * Pipeline stages are exercised directly (rather than through the full
 * `runDream` orchestration) so the assertions isolate the M3 extract and
 * temporalize behavior from the M1 deterministic reconcile pass.
 */

const TEST_NOW = "2026-04-10T12:00:00.000Z";

/** Mined durable as returned by the fixture's deterministic extraction LLM. */
interface MinedDurableFixture {
  type?: Durable["type"];
  subject: string;
  content: string;
  claim_key?: string;
  importance?: number;
  expiry?: Durable["expiry"];
  tags?: string[];
}

/** Seeded durable row in a pipeline scenario fixture. */
interface PipelineScenarioDurable {
  id: string;
  subject: string;
  content: string;
  type?: Durable["type"];
  expiry?: Durable["expiry"];
  importance?: number;
  claim_key?: string;
  claim_key_status?: Durable["claim_key_status"];
  valid_from?: string;
  valid_to?: string;
  superseded_by?: string;
  retired?: boolean;
  created_at?: string;
}

/** Episode evidence row used as extract-stage input. */
interface PipelineScenarioEpisode {
  id: string;
  summary: string;
  startedAt?: string;
  endedAt?: string;
  project?: string;
  createdAt?: string;
}

/** Recall assertion executed against the post-pipeline corpus. */
interface PipelineScenarioRecallCheck {
  query: string;
  rankingProfile?: RecallRankingProfile;
  asOf?: string;
  limit?: number;
  threshold?: number;
  expectTopContentIncludes?: string;
  expectIncludesContentIncludes?: string[];
  expectExcludesContentIncludes?: string[];
}

/** Expectations evaluated after the pipeline stages run. */
interface PipelineScenarioExpect {
  durablesInserted?: number;
  revisionsApplied?: number;
  activeByClaimKey?: Array<{ claimKey: string; expectCount: number; contentIncludes?: string }>;
  activeContentIncludes?: string[];
  activeContentExcludes?: string[];
  superseded?: Array<{ predecessorId: string; successorContentIncludes: string; predecessorValidTo?: string }>;
  stillActiveIds?: string[];
}

/** Top-level dreaming pipeline scenario fixture shape. */
interface PipelineScenario {
  id: string;
  description: string;
  now?: string;
  contextLookupEnabled?: boolean;
  seedDurables: PipelineScenarioDurable[];
  episodes?: PipelineScenarioEpisode[];
  extraction?: { minedDurables: MinedDurableFixture[] };
  expect?: PipelineScenarioExpect;
  recall?: PipelineScenarioRecallCheck[];
}

/** Deterministic mining LLM double returning a fixed durable set per call. */
class FixtureExtractLlm implements LlmPort {
  public readonly metadata = { usage: { inputTokens: 0, outputTokens: 0, totalCost: 0 } };

  public constructor(private readonly durables: MinedDurableFixture[]) {}

  public async complete(): Promise<string> {
    throw new Error("complete() is not used by the extract stage.");
  }

  public async completeJson<T>(): Promise<T> {
    this.metadata.usage.inputTokens += 1;
    return { durables: this.durables } as T;
  }
}

const throwingEmbedding: EmbeddingPort = {
  async embed(): Promise<number[][]> {
    throw new Error("Embeddings are disabled in the dreaming pipeline harness; lexical recall only.");
  },
};

const scenariosDir = path.dirname(fileURLToPath(import.meta.url));
const scenarios = loadScenarios(scenariosDir);

const clients: Client[] = [];

describe("dreaming pipeline scenarios", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(clients.map((client) => client.close()));
    clients.length = 0;
  });

  for (const scenario of scenarios) {
    it(`${scenario.id}: ${scenario.description}`, async () => {
      const now = scenario.now ?? TEST_NOW;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(now));

      const client = await createTestClient();
      const port = createDreamPort(client);

      for (const seed of scenario.seedDurables) {
        await seedDurable(client, seed);
      }

      if (scenario.episodes && scenario.extraction) {
        await runPipeline(scenario, client, port, () => new Date(now));
      }

      if (scenario.expect) {
        await assertCorpus(client, scenario.expect);
      }

      if (scenario.recall) {
        await assertRecall(client, scenario.recall);
      }
    });
  }
});

/** Runs the extract -> apply -> temporalize stages for one scenario. */
async function runPipeline(scenario: PipelineScenario, client: Client, port: DreamPort, now: () => Date): Promise<void> {
  for (const episode of scenario.episodes ?? []) {
    await seedEpisode(client, episode);
  }

  const runId = await port.createRun({ tier: "standard", dryRun: false });
  const llm = new FixtureExtractLlm(scenario.extraction?.minedDurables ?? []);

  const extract = await runExtractStage(
    {
      now,
      maxEpisodes: 16,
      contextLookupEnabled: scenario.contextLookupEnabled ?? true,
      costCapUsd: 100,
    },
    { port, createExtractLlm: () => llm },
  );

  const embedding = createDeterministicEmbedding();
  await applyExtractedDurables({ runId, candidates: extract.candidates, now }, { port, embedding });
  await runTemporalizeStage({ runId, candidates: extract.candidates, apply: true, now }, { port, embedding });
}

/** Asserts the post-pipeline corpus state for one scenario. */
async function assertCorpus(client: Client, expectations: PipelineScenarioExpect): Promise<void> {
  const rows = await readAllDurables(client);
  const active = rows.filter((row) => !row.retired && !row.superseded_by);

  if (typeof expectations.durablesInserted === "number") {
    const inserted = rows.filter((row) => row.claim_key_source === "dreaming_extract");
    expect(inserted).toHaveLength(expectations.durablesInserted);
  }

  if (typeof expectations.revisionsApplied === "number") {
    const successors = rows.filter((row) => row.claim_key_source === "dreaming_temporalize");
    expect(successors).toHaveLength(expectations.revisionsApplied);
  }

  for (const check of expectations.activeByClaimKey ?? []) {
    const matches = active.filter((row) => row.claim_key === check.claimKey);
    expect(matches).toHaveLength(check.expectCount);
    if (check.contentIncludes) {
      expect(matches.some((row) => row.content.includes(check.contentIncludes!))).toBe(true);
    }
  }

  for (const fragment of expectations.activeContentIncludes ?? []) {
    expect(active.some((row) => row.content.includes(fragment))).toBe(true);
  }

  for (const fragment of expectations.activeContentExcludes ?? []) {
    expect(active.some((row) => row.content.includes(fragment))).toBe(false);
  }

  for (const id of expectations.stillActiveIds ?? []) {
    expect(active.some((row) => row.id === id)).toBe(true);
  }

  for (const supersession of expectations.superseded ?? []) {
    const predecessor = rows.find((row) => row.id === supersession.predecessorId);
    expect(predecessor, `predecessor ${supersession.predecessorId} must exist`).toBeDefined();
    expect(predecessor?.superseded_by, `predecessor ${supersession.predecessorId} must be superseded`).toBeTruthy();

    const successor = rows.find((row) => row.id === predecessor?.superseded_by);
    expect(successor?.content.includes(supersession.successorContentIncludes)).toBe(true);

    if (supersession.predecessorValidTo) {
      expect(predecessor?.valid_to).toBe(supersession.predecessorValidTo);
    } else {
      expect(predecessor?.valid_to).toBeTruthy();
    }
  }
}

/** Runs and asserts every recall check for one scenario. */
async function assertRecall(client: Client, checks: PipelineScenarioRecallCheck[]): Promise<void> {
  const adapter = createRecallAdapter(client, throwingEmbedding);

  for (const check of checks) {
    const results = await recall(
      {
        text: check.query,
        limit: check.limit ?? 5,
        threshold: check.threshold ?? 0,
        ...(check.rankingProfile ? { rankingProfile: check.rankingProfile } : {}),
        ...(check.asOf ? { asOf: check.asOf } : {}),
      },
      adapter,
    );
    const contents = results.map((result) => result.entry.content);

    if (check.expectTopContentIncludes) {
      expect(contents[0], `top result for "${check.query}" should include "${check.expectTopContentIncludes}"`).toContain(check.expectTopContentIncludes);
    }

    for (const fragment of check.expectIncludesContentIncludes ?? []) {
      expect(
        contents.some((content) => content.includes(fragment)),
        `recall "${check.query}" should surface "${fragment}"`,
      ).toBe(true);
    }

    for (const fragment of check.expectExcludesContentIncludes ?? []) {
      expect(
        contents.some((content) => content.includes(fragment)),
        `recall "${check.query}" should not surface "${fragment}"`,
      ).toBe(false);
    }
  }
}

/** Loads and parses every scenario JSON fixture in the directory. */
function loadScenarios(directory: string): PipelineScenario[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(path.join(directory, file), "utf8")) as PipelineScenario);
}

/** Creates a fresh in-memory database with the production schema applied. */
async function createTestClient(): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  await initSchema(client);
  return client;
}

/** Seeds one durable row using the production insert path so FTS stays in sync. */
async function seedDurable(client: Client, seed: PipelineScenarioDurable): Promise<void> {
  const createdAt = seed.created_at ?? "2026-01-01T00:00:00.000Z";
  const contentHash = computeContentHash(seed.content);
  const durable: Durable = {
    id: seed.id,
    type: seed.type ?? "fact",
    subject: seed.subject,
    content: seed.content,
    importance: seed.importance ?? 6,
    expiry: seed.expiry ?? "permanent",
    tags: [],
    quality_score: 0.5,
    recall_count: 0,
    content_hash: contentHash,
    norm_content_hash: computeNormContentHash(seed.content),
    superseded_by: seed.superseded_by,
    valid_from: seed.valid_from,
    valid_to: seed.valid_to,
    claim_key: seed.claim_key,
    claim_key_status: seed.claim_key_status,
    retired: seed.retired ?? false,
    created_at: createdAt,
    updated_at: createdAt,
  };

  await insertDurable(client, durable, [], contentHash);
}

/** Seeds one episode evidence row for the extract stage. */
async function seedEpisode(client: Client, episode: PipelineScenarioEpisode): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO episodes (id, source, source_id, started_at, ended_at, summary, project, retired, created_at, updated_at)
      VALUES (?, 'openclaw', ?, ?, ?, ?, ?, 0, ?, ?)
    `,
    args: [
      episode.id,
      `session-${episode.id}`,
      episode.startedAt ?? "2026-04-05T10:00:00.000Z",
      episode.endedAt ?? "2026-04-05T11:00:00.000Z",
      episode.summary,
      episode.project ?? null,
      episode.createdAt ?? "2026-04-05T11:00:00.000Z",
      episode.createdAt ?? "2026-04-05T11:00:00.000Z",
    ],
  });
}

/** Raw durable row fields needed by the corpus assertions. */
interface RawDurableRow {
  id: string;
  content: string;
  claim_key: string | null;
  claim_key_source: string | null;
  superseded_by: string | null;
  valid_to: string | null;
  retired: boolean;
}

/** Reads every durable row, including superseded and retired lineage. */
async function readAllDurables(client: Client): Promise<RawDurableRow[]> {
  const result = await client.execute("SELECT id, content, claim_key, claim_key_source, superseded_by, valid_to, retired FROM durables");
  return result.rows.map((row) => ({
    id: String(row.id),
    content: String(row.content),
    claim_key: row.claim_key === null ? null : String(row.claim_key),
    claim_key_source: row.claim_key_source === null ? null : String(row.claim_key_source),
    superseded_by: row.superseded_by === null ? null : String(row.superseded_by),
    valid_to: row.valid_to === null ? null : String(row.valid_to),
    retired: Number(row.retired) === 1,
  }));
}
