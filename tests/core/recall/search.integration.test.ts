import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { createRecallAdapter } from "../../../src/adapters/db/recall-adapter.js";
import type { EmbeddingPort } from "../../../src/core/ports.js";
import { composeEmbeddingText } from "../../../src/core/store/embedding-text.js";
import type { Durable } from "../../../src/core/types.js";
import { closeTestDatabases, removeTestPath } from "../../helpers/temp-paths.js";
import { recall } from "../../../src/core/recall/search.js";
import { createNoopRecallTraceSink, type RecallExecutionTraceSummary } from "../../../src/core/recall/trace.js";

const TEST_NOW = new Date("2026-03-26T12:00:00.000Z");

const openDatabases: SqlDatabase[] = [];
const tempDatabasePaths: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_NOW);
});

afterEach(async () => {
  vi.useRealTimers();

  await closeTestDatabases(openDatabases);

  while (tempDatabasePaths.length > 0) {
    await removeTestPath(tempDatabasePaths.pop() ?? "");
  }
});

describe("recall integration", () => {
  it("returns scored results with full breakdown metadata", async () => {
    const fixture = await createRecallFixture();

    const results = await recall(
      {
        text: "hybrid retrieval recall pipeline",
        limit: 5,
      },
      fixture.adapter,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({
      entry: expect.objectContaining({
        subject: expect.any(String),
      }),
      score: expect.any(Number),
      scores: {
        relevance: expect.any(Number),
        vector: expect.any(Number),
        lexical: expect.any(Number),
        recency: expect.any(Number),
        importance: expect.any(Number),
      },
    });
    expect(results.some((result) => result.entry.subject === "agenr architecture")).toBe(true);
  });

  it("keeps recall behavior unchanged when tracing is disabled or no-op", async () => {
    const baselineFixture = await createRecallFixture();
    const tracedFixture = await createRecallFixture();
    const noOpFixture = await createRecallFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const summaries: RecallExecutionTraceSummary[] = [];

    const baseline = await recall(
      {
        text: "hybrid retrieval recall pipeline",
        limit: 5,
      },
      baselineFixture.adapter,
    );
    const traced = await recall(
      {
        text: "hybrid retrieval recall pipeline",
        limit: 5,
      },
      tracedFixture.adapter,
      {
        trace: {
          reportSummary(summary): void {
            summaries.push(summary);
          },
        },
      },
    );
    const noOp = await recall(
      {
        text: "hybrid retrieval recall pipeline",
        limit: 5,
      },
      noOpFixture.adapter,
      {
        trace: createNoopRecallTraceSink(),
      },
    );

    expect(projectRecallResults(traced)).toEqual(projectRecallResults(baseline));
    expect(projectRecallResults(noOp)).toEqual(projectRecallResults(baseline));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      filtering: {
        types: [],
        tags: [],
      },
      ranking: {
        limit: 5,
        threshold: 0,
        budget: null,
      },
      candidateCounts: {
        merged: expect.any(Number),
        thresholdQualified: expect.any(Number),
        budgetAccepted: expect.any(Number),
        finalRanked: expect.any(Number),
        returned: expect.any(Number),
      },
      timings: {
        mergeCandidatesMs: expect.any(Number),
        scoreCandidatesMs: expect.any(Number),
        thresholdMs: expect.any(Number),
        budgetMs: expect.any(Number),
        shapeResultsMs: expect.any(Number),
      },
    });
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("respects the requested result limit", async () => {
    const fixture = await createRecallFixture();

    const results = await recall(
      {
        text: "retrieval scoring workflow output cleanup",
        limit: 2,
      },
      fixture.adapter,
    );

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("applies the type filter", async () => {
    const fixture = await createRecallFixture();

    const results = await recall(
      {
        text: "retrieval architecture workflow",
        types: ["fact"],
        limit: 10,
      },
      fixture.adapter,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.entry.type === "fact")).toBe(true);
  });

  it("applies the tag filter", async () => {
    const fixture = await createRecallFixture();

    const results = await recall(
      {
        text: "workflow branching commit merge",
        tags: ["codex"],
        limit: 10,
      },
      fixture.adapter,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.entry.tags.includes("codex"))).toBe(true);
  });

  it("matches literal tag values instead of wildcard-like patterns", async () => {
    const fixture = await createRecallFixture();

    const results = await recall(
      {
        text: "literal wildcard-like tag",
        tags: ["ops_100%"],
        limit: 10,
      },
      fixture.adapter,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.entry.subject).toBe("literal special tag");
    expect(results[0]?.entry.tags).toEqual(["ops_100%"]);
  });

  it("applies the since filter", async () => {
    const fixture = await createRecallFixture();

    const results = await recall(
      {
        text: "architecture output workflow",
        since: "30d",
        limit: 10,
      },
      fixture.adapter,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => new Date(result.entry.created_at) >= daysAgo(30))).toBe(true);
  });

  it("applies the until filter", async () => {
    const fixture = await createRecallFixture();

    const results = await recall(
      {
        text: "scoring embedding cleanup",
        until: "30d",
        limit: 10,
      },
      fixture.adapter,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => new Date(result.entry.created_at) <= daysAgo(30))).toBe(true);
  });

  it("supports natural-language explicit around values", async () => {
    const fixture = await createRecallFixture();

    const [first] = await recall(
      {
        text: "temporal anchor matching entry",
        around: "yesterday",
        aroundRadius: 1,
        limit: 5,
      },
      fixture.adapter,
    );

    expect(first?.entry.created_at).toBe(daysAgo(1).toISOString());
  });

  it("returns empty when every result falls below the threshold", async () => {
    const fixture = await createRecallFixture();

    const results = await recall(
      {
        text: "unrelated threshold query",
        threshold: 0.99,
        limit: 10,
      },
      fixture.adapter,
    );

    expect(results).toEqual([]);
  });

  it("still returns one qualifying result when the budget is very small", async () => {
    const fixture = await createRecallFixture();

    const results = await recall(
      {
        text: "hybrid retrieval recall pipeline",
        budget: 10,
        limit: 10,
      },
      fixture.adapter,
    );

    expect(results).toHaveLength(1);
  });

  it("never returns stale entries", async () => {
    const fixture = await createRecallFixture();

    const results = await recall(
      {
        text: "retired hidden memory",
        limit: 10,
      },
      fixture.adapter,
    );

    expect(results.map((result) => result.entry.id)).not.toContain(fixture.seed.staleId);
  });

  it("never returns superseded entries", async () => {
    const fixture = await createRecallFixture();

    const results = await recall(
      {
        text: "superseded secret note",
        limit: 10,
      },
      fixture.adapter,
    );

    expect(results.map((result) => result.entry.id)).not.toContain(fixture.seed.supersededId);
  });

  it("returns empty for an empty query", async () => {
    const fixture = await createRecallFixture();

    await expect(
      recall(
        {
          text: "   ",
          limit: 10,
        },
        fixture.adapter,
      ),
    ).resolves.toEqual([]);
  });

  it("returns empty cleanly for an empty database", async () => {
    const fixture = await createRecallFixture({ seed: false });

    const results = await recall(
      {
        text: "anything at all",
        limit: 10,
      },
      fixture.adapter,
    );

    expect(results).toEqual([]);
  });

  it("returns normalized numeric score breakdowns", async () => {
    const fixture = await createRecallFixture();

    const [result] = await recall(
      {
        text: "exact subject match",
        limit: 5,
      },
      fixture.adapter,
    );

    if (!result) {
      throw new Error("Expected at least one recall result.");
    }

    for (const value of Object.values(result.scores)) {
      expect(typeof value).toBe("number");
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("sorts results by descending score", async () => {
    const fixture = await createRecallFixture();

    const results = await recall(
      {
        text: "retrieval scoring workflow output cleanup",
        limit: 10,
      },
      fixture.adapter,
    );

    const scores = results.map((result) => result.score);
    // The final shortlist is ordered by descending score, except that the
    // grounding-aware tie-break in sortAcceptedCandidates may promote a more
    // directly grounded answer ahead of neighbors whose scores are within
    // GROUNDING_SORT_MAX_SCORE_GAP (0.03) of it. Assert descending order up to
    // that documented tolerance so a genuine sort regression still fails.
    const GROUNDING_TIE_TOLERANCE = 0.03;
    for (let index = 1; index < scores.length; index += 1) {
      expect(scores[index]!).toBeLessThanOrEqual(scores[index - 1]! + GROUNDING_TIE_TOLERANCE);
    }
  });
});

describe("recall concurrency", () => {
  it("handles parallel recalls without database busy errors", async () => {
    const fixture = await createRecallFixture({ fileBacked: true });
    const queries = ["hybrid retrieval", "weighted scoring", "json output preferences", "embedding model selection", "workflow branching"];

    const results = await Promise.all(queries.map((text) => recall({ text, limit: 5 }, fixture.adapter)));

    expect(results).toHaveLength(queries.length);
    expect(results.every((result) => Array.isArray(result))).toBe(true);
  });

  it("completes a recall while a store transaction is in progress", async () => {
    const fixture = await createRecallFixture({ fileBacked: true });
    const writeStarted = deferred<void>();
    const finishWrite = deferred<void>();

    const storePromise = fixture.database.withTransaction(async (tx) => {
      const entry = buildEntry({
        subject: "concurrent write",
        content: "Concurrent writes should not break recalls.",
        created_at: TEST_NOW.toISOString(),
      });
      const embedding = hashToVector(composeEmbeddingText(entry), 1024);
      await tx.insertDurable(entry, embedding, hashText(`concurrent:${entry.id}`));
      writeStarted.resolve();
      await finishWrite.promise;
    });

    await writeStarted.promise;

    const recallPromise = recall(
      {
        text: "hybrid retrieval recall pipeline",
        limit: 5,
      },
      fixture.adapter,
    );

    finishWrite.resolve();

    const [results] = await Promise.all([recallPromise, storePromise.then(() => undefined)]);

    expect(results.length).toBeGreaterThan(0);
  });
});

/**
 * Creates a real recall fixture backed by libSQL and the production recall adapter.
 *
 * @param options - Fixture controls for seeding and backing store selection.
 * @returns Database, adapter, and seeded entry metadata for the test.
 */
async function createRecallFixture(options: { seed?: boolean; fileBacked?: boolean } = {}): Promise<{
  database: SqlDatabase;
  adapter: ReturnType<typeof createRecallAdapter>;
  seed: SeedMetadata;
}> {
  const databasePath = options.fileBacked === true ? createTempDatabasePath() : ":memory:";
  const database = await createDatabase(databasePath);
  openDatabases.push(database);

  const adapter = createRecallAdapter(database, createMockEmbeddingPort());
  const seed = options.seed === false ? emptySeedMetadata() : await seedEntries(database);

  return {
    database,
    adapter,
    seed,
  };
}

/**
 * Seeds the integration database with a representative mix of active and inactive entries.
 *
 * @param database - Real libSQL database adapter.
 * @returns Identifiers of notable seeded entries used by assertions.
 */
async function seedEntries(database: SqlDatabase): Promise<SeedMetadata> {
  const replacementEntry = buildEntry({
    subject: "new workflow",
    content: "Replacement workflow entry remains active after superseding older guidance.",
    type: "decision",
    importance: 6,
    expiry: "permanent",
    tags: ["workflow"],
    created_at: daysAgo(10).toISOString(),
  });

  await insertSeedEntry(database, replacementEntry);

  const entries = [
    buildEntry({
      subject: "agenr architecture",
      content: "The recall pipeline uses hybrid retrieval with vector search and lexical fallback.",
      type: "fact",
      importance: 9,
      expiry: "permanent",
      created_at: daysAgo(1).toISOString(),
    }),
    buildEntry({
      subject: "scoring formula",
      content: "Use weighted scoring with relevance, recency, and importance in the recall pipeline.",
      type: "decision",
      importance: 7,
      expiry: "permanent",
      created_at: daysAgo(180).toISOString(),
    }),
    buildEntry({
      subject: "output format",
      content: "Prefer JSON output with stable field ordering for CLI integrations.",
      type: "preference",
      importance: 5,
      expiry: "temporary",
      created_at: daysAgo(3).toISOString(),
    }),
    buildEntry({
      subject: "embedding quality",
      content: "Embedding model selection matters more than aggressive reranking for useful recall.",
      type: "lesson",
      importance: 8,
      expiry: "core",
      created_at: daysAgo(365).toISOString(),
    }),
    buildEntry({
      subject: "deprecated skip embeddings path",
      content: "The deprecated skip embeddings code remains in the codebase until the recall v1 cleanup pass removes it.",
      type: "fact",
      importance: 6,
      expiry: "temporary",
      created_at: daysAgo(60).toISOString(),
    }),
    buildEntry({
      subject: "retired note",
      content: "Retired hidden memory should never be recalled.",
      type: "milestone",
      importance: 4,
      expiry: "temporary",
      valid_to: daysAgo(1).toISOString(),
      supersession_kind: "stale",
      supersession_reason: "obsolete",
      created_at: daysAgo(2).toISOString(),
    }),
    buildEntry({
      subject: "old workflow",
      content: "Superseded secret note should never be recalled.",
      type: "decision",
      importance: 6,
      expiry: "permanent",
      superseded_by: replacementEntry.id,
      created_at: daysAgo(90).toISOString(),
    }),
    buildEntry({
      subject: "codex workflow",
      content: "Codex workflow prefers branching from master and committing before merge.",
      type: "decision",
      importance: 7,
      expiry: "permanent",
      tags: ["codex", "workflow"],
      created_at: daysAgo(5).toISOString(),
    }),
    buildEntry({
      subject: "temporal anchor entry",
      content: "Temporal anchor matching entry for explicit around date queries.",
      type: "milestone",
      importance: 6,
      expiry: "permanent",
      created_at: daysAgo(1).toISOString(),
    }),
    buildEntry({
      subject: "temporal anchor entry",
      content: "Temporal anchor matching entry for explicit around date queries.",
      type: "milestone",
      importance: 6,
      expiry: "permanent",
      created_at: daysAgo(240).toISOString(),
    }),
    buildEntry({
      subject: "literal special tag",
      content: "Exact tag filtering should match only the literal wildcard-like tag.",
      type: "fact",
      importance: 6,
      expiry: "permanent",
      tags: ["ops_100%"],
      created_at: daysAgo(12).toISOString(),
    }),
    buildEntry({
      subject: "wildcard decoy tag",
      content: "Exact tag filtering should not match similar wildcard-like tags.",
      type: "fact",
      importance: 6,
      expiry: "permanent",
      tags: ["opsA100x"],
      created_at: daysAgo(12).toISOString(),
    }),
    buildEntry({
      subject: "pipeline merge",
      content: "Hybrid retrieval merges vector and lexical candidates before scoring.",
      type: "fact",
      importance: 6,
      expiry: "permanent",
      created_at: daysAgo(20).toISOString(),
    }),
    buildEntry({
      subject: "exact subject match",
      content: "Exact subject matches should receive a lexical bonus in recall scoring.",
      type: "decision",
      importance: 8,
      expiry: "permanent",
      created_at: daysAgo(15).toISOString(),
    }),
  ];

  for (const entry of entries) {
    await insertSeedEntry(database, entry);
  }

  return {
    staleId: entries[5]!.id,
    supersededId: entries[6]!.id,
  };
}

/**
 * Inserts one seeded entry with a deterministic embedding and stable content hash.
 *
 * @param database - Real libSQL database adapter.
 * @param entry - Seed entry to persist.
 * @returns Promise that resolves after the insert finishes.
 */
async function insertSeedEntry(database: SqlDatabase, entry: Durable): Promise<void> {
  const embedding = hashToVector(composeEmbeddingText(entry), 1024);
  await database.insertDurable(entry, embedding, hashText(`${entry.id}:${entry.subject}`));
}

/**
 * Creates the mock embedding port used by recall queries in integration tests.
 *
 * @returns Deterministic embedding provider.
 */
function createMockEmbeddingPort(): EmbeddingPort {
  return {
    embed: async (texts: string[]): Promise<number[][]> => texts.map((text) => hashToVector(text, 1024)),
  };
}

/**
 * Builds a canonical seeded entry with sensible defaults.
 *
 * @param overrides - Field overrides for the seed entry.
 * @returns Fully populated entry object.
 */
function buildEntry(overrides: Partial<Durable>): Durable {
  const createdAt = overrides.created_at ?? TEST_NOW.toISOString();
  const updatedAt = overrides.updated_at ?? createdAt;

  return {
    id: overrides.id ?? randomUUID(),
    type: overrides.type ?? "fact",
    subject: overrides.subject ?? "subject",
    content: overrides.content ?? "content",
    importance: overrides.importance ?? 7,
    expiry: overrides.expiry ?? "permanent",
    tags: overrides.tags ?? [],
    source_file: overrides.source_file,
    source_context: overrides.source_context,
    embedding: overrides.embedding,
    content_hash: overrides.content_hash,
    norm_content_hash: overrides.norm_content_hash,
    quality_score: overrides.quality_score ?? 0.5,
    recall_count: overrides.recall_count ?? 0,
    last_recalled_at: overrides.last_recalled_at,
    superseded_by: overrides.superseded_by,
    valid_from: overrides.valid_from,
    valid_to: overrides.valid_to,
    supersession_kind: overrides.supersession_kind,
    supersession_reason: overrides.supersession_reason,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

/** Returns the test clock shifted backward by the requested number of days. */
function daysAgo(days: number): Date {
  return new Date(TEST_NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

/** Creates a stable SHA-256 hash string for seeded content. */
function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Converts input text into a deterministic normalized vector.
 *
 * @param text - Source text to hash into vector space.
 * @param dimensions - Output vector length.
 * @returns Unit-normalized numeric embedding.
 */
function hashToVector(text: string, dimensions: number): number[] {
  const vector: number[] = [];
  let counter = 0;

  while (vector.length < dimensions) {
    const block = createHash("sha256").update(text).update(String(counter)).digest();

    for (let offset = 0; offset + 4 <= block.length && vector.length < dimensions; offset += 4) {
      const value = block.readInt32LE(offset) / 0x7fffffff;
      vector.push(value);
    }

    counter += 1;
  }

  const magnitude = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  if (magnitude === 0) {
    return Array.from({ length: dimensions }, (_, index) => (index === 0 ? 1 : 0));
  }

  return vector.map((value) => value / magnitude);
}

/** Creates a temp database path for file-backed concurrency tests. */
function createTempDatabasePath(): string {
  const databasePath = path.join(os.tmpdir(), `agenr-recall-${randomUUID()}.sqlite`);
  tempDatabasePaths.push(databasePath);
  return databasePath;
}

/** Creates a simple deferred promise helper for concurrency tests. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

/** Empty seed metadata used by tests that intentionally skip fixture seeding. */
function emptySeedMetadata(): SeedMetadata {
  return {
    staleId: "",
    supersededId: "",
  };
}

/** Projects recall results onto stable fields so repeated isolated fixtures can be compared. */
function projectRecallResults(results: Awaited<ReturnType<typeof recall>>): Array<{
  subject: string;
  content: string;
  type: Durable["type"];
  importance: number;
  expiry: Durable["expiry"];
  tags: string[];
  created_at: string;
  score: number;
  scores: Awaited<ReturnType<typeof recall>>[number]["scores"];
}> {
  return results.map((result) => ({
    subject: result.entry.subject,
    content: result.entry.content,
    type: result.entry.type,
    importance: result.entry.importance,
    expiry: result.entry.expiry,
    tags: result.entry.tags,
    created_at: result.entry.created_at,
    score: result.score,
    scores: result.scores,
  }));
}

/**
 * IDs of seeded entries that specific tests need to reference.
 */
interface SeedMetadata {
  staleId: string;
  supersededId: string;
}
