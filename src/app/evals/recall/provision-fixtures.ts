import { createHash } from "node:crypto";

import type { EmbeddingPort } from "../../../core/ports.js";
import { composeEmbeddingText } from "../../../core/store/embedding-text.js";
import type { Entry, Expiry } from "../../../core/types.js";
import type { RecallEvalFixtureEntry, RecallEvalProvisionedEntrySummary } from "./contracts.js";
import type { RecallEvalFixtureStore } from "./ports.js";

const DEFAULT_IMPORTANCE = 6;
const DEFAULT_EXPIRY: Expiry = "permanent";
const DEFAULT_QUALITY_SCORE = 0.5;

/**
 * Summary of exact fixture provisioning into isolated recall eval storage.
 */
export interface RecallEvalProvisioningResult {
  /** Number of fixture entries written into the isolated database. */
  provisionedCount: number;
  /** Number of fixture entries that supplied explicit IDs. */
  providedIdCount: number;
  /** Number of fixture entries that received generated IDs. */
  generatedIdCount: number;
  /** Number of retired fixture entries seeded into storage. */
  retiredCount: number;
  /** Number of fixture entries that reference a successor entry. */
  supersededCount: number;
  /** Number of fixture entries that defaulted `created_at` during seeding. */
  createdAtDefaultedCount: number;
  /** Number of fixture entries that defaulted `updated_at` during seeding. */
  updatedAtDefaultedCount: number;
  /** Seeded-state summary captured before recall telemetry can mutate rows. */
  seededEntries: RecallEvalProvisionedEntrySummary[];
}

/** Prepared direct-seed fixture ready for isolated database insertion. */
interface PreparedFixture {
  fixtureIndex: number;
  entry: Entry;
  contentHash: string;
  embeddingText: string;
}

/** Prepared fixture batch plus exact seeded-state diagnostics. */
interface PreparedFixtureBatch {
  insertionOrder: PreparedFixture[];
  providedIdCount: number;
  generatedIdCount: number;
  retiredCount: number;
  supersededCount: number;
  createdAtDefaultedCount: number;
  updatedAtDefaultedCount: number;
  seededEntries: RecallEvalProvisionedEntrySummary[];
}

/**
 * Provisions the eval memory pool directly into isolated storage.
 *
 * This path intentionally bypasses the normal store pipeline so fixture IDs,
 * timestamps, retirement flags, and supersession metadata remain exact when
 * the request provides them.
 *
 * @param params - Case-local fixture data plus isolated database dependencies.
 * @returns Provisioning summary for the isolated case sandbox.
 */
export async function provisionRecallEvalFixtures(params: {
  caseId: string;
  memoryPool: RecallEvalFixtureEntry[];
  store: RecallEvalFixtureStore;
  embedding: EmbeddingPort;
  provisionedAt: string;
}): Promise<RecallEvalProvisioningResult> {
  const preparedBatch = prepareFixtures(params.caseId, params.memoryPool, params.provisionedAt);
  if (preparedBatch.insertionOrder.length === 0) {
    return {
      provisionedCount: 0,
      providedIdCount: 0,
      generatedIdCount: 0,
      retiredCount: 0,
      supersededCount: 0,
      createdAtDefaultedCount: 0,
      updatedAtDefaultedCount: 0,
      seededEntries: [],
    };
  }

  const embeddings = await params.embedding.embed(preparedBatch.insertionOrder.map((fixture) => fixture.embeddingText));
  if (embeddings.length !== preparedBatch.insertionOrder.length) {
    throw new Error(`Fixture embedding count mismatch: expected ${preparedBatch.insertionOrder.length}, received ${embeddings.length}.`);
  }

  await params.store.withTransaction(async (store) => {
    for (const [index, fixture] of preparedBatch.insertionOrder.entries()) {
      await store.insertEntry(fixture.entry, embeddings[index] ?? [], fixture.contentHash);
    }
  });

  return {
    provisionedCount: preparedBatch.insertionOrder.length,
    providedIdCount: preparedBatch.providedIdCount,
    generatedIdCount: preparedBatch.generatedIdCount,
    retiredCount: preparedBatch.retiredCount,
    supersededCount: preparedBatch.supersededCount,
    createdAtDefaultedCount: preparedBatch.createdAtDefaultedCount,
    updatedAtDefaultedCount: preparedBatch.updatedAtDefaultedCount,
    seededEntries: preparedBatch.seededEntries,
  };
}

/** Prepares validated fixture entries for exact insertion order and storage defaults. */
function prepareFixtures(caseId: string, fixtures: RecallEvalFixtureEntry[], provisionedAt: string): PreparedFixtureBatch {
  const resolvedIds = fixtures.map((fixture, index) => fixture.id ?? createFixtureId(caseId, index, fixture));
  const duplicateIds = findDuplicateIds(resolvedIds);
  if (duplicateIds.length > 0) {
    throw new Error(`Fixture IDs must be unique. Duplicate IDs: ${duplicateIds.join(", ")}.`);
  }

  const knownIds = new Set(resolvedIds);
  const prepared = fixtures.map((fixture, index) => {
    const supersededBy = fixture.superseded_by;
    if (supersededBy && !knownIds.has(supersededBy)) {
      throw new Error(`memoryPool[${index}].superseded_by references unknown fixture id "${supersededBy}".`);
    }

    const entry = buildEntry(fixture, resolvedIds[index] ?? "", provisionedAt);
    return {
      fixtureIndex: index,
      entry,
      contentHash: hashText(`${entry.type}\n${entry.subject}\n${entry.content}`),
      embeddingText: composeEmbeddingText(entry),
    };
  });

  return {
    insertionOrder: topologicallySortFixtures(prepared),
    providedIdCount: fixtures.filter((fixture) => fixture.id !== undefined).length,
    generatedIdCount: fixtures.filter((fixture) => fixture.id === undefined).length,
    retiredCount: prepared.filter((fixture) => fixture.entry.retired).length,
    supersededCount: prepared.filter((fixture) => fixture.entry.superseded_by !== undefined).length,
    createdAtDefaultedCount: fixtures.filter((fixture) => fixture.created_at === undefined).length,
    updatedAtDefaultedCount: fixtures.filter((fixture) => fixture.updated_at === undefined).length,
    seededEntries: prepared.map((fixture) => summarizePreparedFixture(fixture.entry)),
  };
}

/** Builds the canonical entry row used for direct isolated fixture seeding. */
function buildEntry(fixture: RecallEvalFixtureEntry, id: string, provisionedAt: string): Entry {
  const createdAt = fixture.created_at ?? provisionedAt;
  const updatedAt = fixture.updated_at ?? createdAt;

  return {
    id,
    type: fixture.type,
    subject: fixture.subject,
    content: fixture.content,
    importance: fixture.importance ?? DEFAULT_IMPORTANCE,
    expiry: fixture.expiry ?? DEFAULT_EXPIRY,
    tags: fixture.tags ?? [],
    source_file: fixture.source_file,
    source_context: fixture.source_context,
    quality_score: DEFAULT_QUALITY_SCORE,
    recall_count: 0,
    superseded_by: fixture.superseded_by,
    retired: fixture.retired ?? false,
    retired_at: fixture.retired_at,
    retired_reason: fixture.retired_reason,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

/** Captures the exact seeded state that existed before recall telemetry mutations. */
function summarizePreparedFixture(entry: Entry): RecallEvalProvisionedEntrySummary {
  return {
    id: entry.id,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    retired: entry.retired,
    superseded_by: entry.superseded_by,
  };
}

/** Creates a deterministic fallback fixture ID for repeatable eval runs. */
function createFixtureId(caseId: string, index: number, fixture: RecallEvalFixtureEntry): string {
  const digest = createHash("sha256")
    .update(caseId)
    .update(":")
    .update(String(index))
    .update(":")
    .update(fixture.type)
    .update(":")
    .update(fixture.subject)
    .update(":")
    .update(fixture.content)
    .digest("hex");

  return `eval-${digest.slice(0, 24)}`;
}

/** Finds duplicate identifiers while preserving deterministic output ordering. */
function findDuplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (const id of ids) {
    if (seen.has(id)) {
      if (!duplicates.includes(id)) {
        duplicates.push(id);
      }
      continue;
    }

    seen.add(id);
  }

  return duplicates;
}

/** Orders fixtures so superseding entries exist before superseded entries are inserted. */
function topologicallySortFixtures(fixtures: PreparedFixture[]): PreparedFixture[] {
  const indegree = new Map(fixtures.map((fixture) => [fixture.entry.id, 0]));
  const dependents = new Map<string, PreparedFixture[]>();

  for (const fixture of fixtures) {
    const successorId = fixture.entry.superseded_by;
    if (!successorId) {
      continue;
    }

    indegree.set(fixture.entry.id, (indegree.get(fixture.entry.id) ?? 0) + 1);
    const successorDependents = dependents.get(successorId) ?? [];
    successorDependents.push(fixture);
    dependents.set(successorId, successorDependents);
  }

  const ready = fixtures.filter((fixture) => (indegree.get(fixture.entry.id) ?? 0) === 0).sort((left, right) => left.fixtureIndex - right.fixtureIndex);
  const sorted: PreparedFixture[] = [];

  while (ready.length > 0) {
    const current = ready.shift();
    if (!current) {
      break;
    }

    sorted.push(current);

    const currentDependents = (dependents.get(current.entry.id) ?? []).sort((left, right) => left.fixtureIndex - right.fixtureIndex);
    for (const dependent of currentDependents) {
      const remaining = (indegree.get(dependent.entry.id) ?? 0) - 1;
      indegree.set(dependent.entry.id, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort((left, right) => left.fixtureIndex - right.fixtureIndex);
      }
    }
  }

  if (sorted.length !== fixtures.length) {
    const unresolved = fixtures.filter((fixture) => !sorted.includes(fixture)).map((fixture) => fixture.entry.id);
    throw new Error(`Fixture supersession metadata contains a cycle: ${unresolved.join(", ")}.`);
  }

  return sorted;
}

/** Creates a deterministic hash string for direct fixture seeding metadata. */
function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
