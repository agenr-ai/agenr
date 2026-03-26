import { randomUUID } from "node:crypto";

import type { DatabasePort, EmbeddingPort } from "../ports.js";
import type { Entry, StoreEntryInput, StoreResult } from "../types.js";
import { composeEmbeddingText } from "./embedding-text.js";
import { computeContentHash, computeNormContentHash } from "./hashing.js";
import { validateEntriesWithIndexes } from "./validation.js";

/**
 * Runtime switches for the store pipeline.
 */
export interface StorePipelineOptions {
  dryRun?: boolean;
  verbose?: boolean;
  /** Skip embedding computation. Useful in tests or offline execution. */
  skipEmbeddings?: boolean;
}

interface PreparedEntry {
  input: StoreEntryInput;
  inputIndex: number;
  contentHash: string;
  normContentHash: string;
}

type StoreEntryOutcome = "stored" | "skipped" | "rejected" | "dry_run";
type StoreEntryReason = "content_hash" | "norm_content_hash" | "validation" | "dry_run";

/**
 * Per-input store decision emitted by the store pipeline.
 */
export interface StoreEntryDetail {
  inputIndex: number;
  outcome: StoreEntryOutcome;
  reason?: StoreEntryReason;
}

/**
 * Store result enriched with per-input decisions.
 */
export interface StoreEntriesDetailedResult extends StoreResult {
  details: StoreEntryDetail[];
}

interface TransactionCapableDatabasePort extends DatabasePort {
  withTransaction<T>(fn: (db: DatabasePort) => Promise<T>): Promise<T>;
}

/**
 * Validates, deduplicates, embeds, and persists a batch of entries.
 *
 * @param inputs - Candidate entries to store.
 * @param db - Database port used for dedup checks and persistence.
 * @param embedding - Embedding port used for batch vector generation.
 * @param options - Optional pipeline execution flags.
 * @returns Aggregate store counts for stored, skipped, and rejected entries.
 */
export async function storeEntries(
  inputs: StoreEntryInput[],
  db: DatabasePort,
  embedding: EmbeddingPort,
  options: StorePipelineOptions = {},
): Promise<StoreResult> {
  const result = await storeEntriesDetailed(inputs, db, embedding, options);
  return {
    stored: result.stored,
    skipped: result.skipped,
    rejected: result.rejected,
  };
}

/**
 * Validates, deduplicates, embeds, and persists a batch of entries while preserving per-input decisions.
 *
 * @param inputs - Candidate entries to store.
 * @param db - Database port used for dedup checks and persistence.
 * @param embedding - Embedding port used for batch vector generation.
 * @param options - Optional pipeline execution flags.
 * @returns Aggregate store counts plus per-input outcomes.
 */
export async function storeEntriesDetailed(
  inputs: StoreEntryInput[],
  db: DatabasePort,
  embedding: EmbeddingPort,
  options: StorePipelineOptions = {},
): Promise<StoreEntriesDetailedResult> {
  if (inputs.length === 0) {
    return { stored: 0, skipped: 0, rejected: 0, details: [] };
  }

  const plan = await buildStorePlan(inputs, db);
  if (plan.pendingEntries.length === 0) {
    return {
      stored: 0,
      skipped: plan.skipped,
      rejected: plan.rejected,
      details: sortStoreDetails(plan.details),
    };
  }

  if (options.dryRun === true) {
    return {
      stored: 0,
      skipped: plan.skipped,
      rejected: plan.rejected,
      details: sortStoreDetails([
        ...plan.details,
        ...plan.pendingEntries.map((entry) => ({
          inputIndex: entry.inputIndex,
          outcome: "dry_run" as const,
          reason: "dry_run" as const,
        })),
      ]),
    };
  }

  const pendingEntries = plan.pendingEntries;
  const embeddings = options.skipEmbeddings === true ? pendingEntries.map(() => []) : await embedPendingEntries(pendingEntries, embedding);
  await persistEntries(db, pendingEntries, embeddings);
  return {
    stored: pendingEntries.length,
    skipped: plan.skipped,
    rejected: plan.rejected,
    details: sortStoreDetails([
      ...plan.details,
      ...pendingEntries.map((entry) => ({
        inputIndex: entry.inputIndex,
        outcome: "stored" as const,
      })),
    ]),
  };
}

async function embedPendingEntries(entries: PreparedEntry[], embedding: EmbeddingPort): Promise<number[][]> {
  const texts = entries.map(({ input }) => composeEmbeddingText(input));
  const vectors = await embedding.embed(texts);

  if (vectors.length !== entries.length) {
    throw new Error(`Embedding length mismatch: expected ${entries.length}, received ${vectors.length}.`);
  }

  return vectors;
}

async function persistEntries(db: DatabasePort, preparedEntries: PreparedEntry[], embeddings: number[][]): Promise<number> {
  const writeBatch = async (targetDb: DatabasePort): Promise<number> => {
    let stored = 0;

    for (const [index, preparedEntry] of preparedEntries.entries()) {
      const embedding = embeddings[index] ?? [];
      await targetDb.insertEntry(buildEntry(preparedEntry, embedding), embedding, preparedEntry.contentHash);
      stored += 1;
    }

    return stored;
  };

  if (preparedEntries.length > 1 && hasTransactionSupport(db)) {
    return db.withTransaction(writeBatch);
  }

  return writeBatch(db);
}

function buildEntry(preparedEntry: PreparedEntry, embedding: number[]): Entry {
  const timestamp = new Date().toISOString();

  return {
    id: randomUUID(),
    type: preparedEntry.input.type,
    subject: preparedEntry.input.subject,
    content: preparedEntry.input.content,
    importance: preparedEntry.input.importance ?? 7,
    expiry: preparedEntry.input.expiry ?? "temporary",
    tags: preparedEntry.input.tags ?? [],
    source_file: preparedEntry.input.source_file,
    source_context: preparedEntry.input.source_context,
    embedding,
    content_hash: preparedEntry.contentHash,
    norm_content_hash: preparedEntry.normContentHash,
    quality_score: 0.5,
    recall_count: 0,
    retired: false,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function hasTransactionSupport(db: DatabasePort): db is TransactionCapableDatabasePort {
  return typeof (db as Partial<TransactionCapableDatabasePort>).withTransaction === "function";
}

async function buildStorePlan(
  inputs: StoreEntryInput[],
  db: DatabasePort,
): Promise<{
  pendingEntries: PreparedEntry[];
  skipped: number;
  rejected: number;
  details: StoreEntryDetail[];
}> {
  const validation = validateEntriesWithIndexes(inputs);
  const details: StoreEntryDetail[] = validation.rejectedInputIndexes.map((inputIndex) => ({
    inputIndex,
    outcome: "rejected",
    reason: "validation",
  }));
  const preparedEntries = validation.valid.map(({ input, inputIndex }) => ({
    input,
    inputIndex,
    contentHash: computeContentHash(input.content, input.source_file),
    normContentHash: computeNormContentHash(input.content),
  }));

  const afterBatchContentHash = dedupePreparedEntries(preparedEntries, "contentHash", "content_hash", details);
  const existingHashes = await db.findExistingHashes(afterBatchContentHash.map((entry) => entry.contentHash));
  const afterExistingContentHash = filterExistingPreparedEntries(afterBatchContentHash, existingHashes, "contentHash", "content_hash", details);

  const afterBatchNormHash = dedupePreparedEntries(afterExistingContentHash, "normContentHash", "norm_content_hash", details);
  const existingNormHashes = await db.findExistingNormHashes(afterBatchNormHash.map((entry) => entry.normContentHash));
  const pendingEntries = filterExistingPreparedEntries(afterBatchNormHash, existingNormHashes, "normContentHash", "norm_content_hash", details);

  return {
    pendingEntries,
    skipped: details.filter((detail) => detail.outcome === "skipped").length,
    rejected: validation.rejected,
    details,
  };
}

function dedupePreparedEntries(
  entries: PreparedEntry[],
  field: "contentHash" | "normContentHash",
  reason: Exclude<StoreEntryReason, "validation" | "dry_run">,
  details: StoreEntryDetail[],
): PreparedEntry[] {
  const seen = new Set<string>();
  const deduped: PreparedEntry[] = [];

  for (const entry of entries) {
    const key = entry[field];
    if (seen.has(key)) {
      details.push({
        inputIndex: entry.inputIndex,
        outcome: "skipped",
        reason,
      });
      continue;
    }

    seen.add(key);
    deduped.push(entry);
  }

  return deduped;
}

function filterExistingPreparedEntries(
  entries: PreparedEntry[],
  existing: Set<string>,
  field: "contentHash" | "normContentHash",
  reason: Exclude<StoreEntryReason, "validation" | "dry_run">,
  details: StoreEntryDetail[],
): PreparedEntry[] {
  return entries.filter((entry) => {
    if (!existing.has(entry[field])) {
      return true;
    }

    details.push({
      inputIndex: entry.inputIndex,
      outcome: "skipped",
      reason,
    });
    return false;
  });
}

function sortStoreDetails(details: StoreEntryDetail[]): StoreEntryDetail[] {
  return [...details].sort((left, right) => left.inputIndex - right.inputIndex);
}
