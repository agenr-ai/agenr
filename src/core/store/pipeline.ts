import { randomUUID } from "node:crypto";

import type { DatabasePort, EmbeddingPort } from "../ports.js";
import type { Entry, StoreEntryInput, StoreResult } from "../types.js";
import { composeEmbeddingText } from "./embedding-text.js";
import { computeContentHash, computeNormContentHash } from "./hashing.js";
import { validateEntries } from "./validation.js";

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
  contentHash: string;
  normContentHash: string;
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
  if (inputs.length === 0) {
    return { stored: 0, skipped: 0, rejected: 0 };
  }

  const validation = validateEntries(inputs);
  if (validation.valid.length === 0) {
    return { stored: 0, skipped: 0, rejected: validation.rejected };
  }

  const preparedEntries = validation.valid.map((input) => ({
    input,
    contentHash: computeContentHash(input.content, input.source_file),
    normContentHash: computeNormContentHash(input.content),
  }));

  const existingHashes = await db.findExistingHashes(preparedEntries.map((entry) => entry.contentHash));
  const pendingEntries = preparedEntries.filter((entry) => !existingHashes.has(entry.contentHash));
  const skipped = preparedEntries.length - pendingEntries.length;

  if (pendingEntries.length === 0 || options.dryRun === true) {
    return {
      stored: 0,
      skipped,
      rejected: validation.rejected,
    };
  }

  const embeddings = options.skipEmbeddings === true ? pendingEntries.map(() => []) : await embedPendingEntries(pendingEntries, embedding);

  const stored = await persistEntries(db, pendingEntries, embeddings);
  return {
    stored,
    skipped,
    rejected: validation.rejected,
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
