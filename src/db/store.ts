import { createHash, randomUUID } from "node:crypto";
import type { Client, InValue, Row } from "@libsql/client";
import { composeEmbeddingText, embed } from "../embeddings/client.js";
import { EmbeddingCache } from "../embeddings/cache.js";
import type { ConfidenceLevel, Expiry, KnowledgeEntry, StoreResult, StoredEntry } from "../types.js";
import { createRelation } from "./relations.js";

const AUTO_SKIP_THRESHOLD = 0.98;
const SMART_DEDUP_THRESHOLD = 0.92;
const DEFAULT_SIMILAR_LIMIT = 5;

export interface StoreEntryDecision {
  entry: KnowledgeEntry;
  action: "added" | "updated" | "skipped";
  reason: string;
  similarity?: number;
  matchedEntryId?: string;
}

export interface StoreEntriesOptions {
  dryRun?: boolean;
  verbose?: boolean;
  force?: boolean;
  sourceFile?: string;
  ingestContentHash?: string;
  onDecision?: (decision: StoreEntryDecision) => void;
  embedFn?: (texts: string[], apiKey: string) => Promise<number[][]>;
}

function toNumber(value: InValue | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim()) {
    return Number(value);
  }
  return Number.NaN;
}

function toStringValue(value: InValue | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function mapBufferToVector(value: InValue | undefined): number[] {
  if (value instanceof ArrayBuffer) {
    return Array.from(new Float32Array(value));
  }

  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return Array.from(
      new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / Float32Array.BYTES_PER_ELEMENT)),
    );
  }

  return [];
}

function cosineSimilarity(a: number[], b: number[]): number {
  const size = Math.min(a.length, b.length);
  if (size === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < size; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }

  if (normA <= 0 || normB <= 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function getTagsForEntryIds(db: Client, ids: string[]): Promise<Map<string, string[]>> {
  if (ids.length === 0) {
    return new Map();
  }

  const placeholders = ids.map(() => "?").join(", ");
  const result = await db.execute({
    sql: `SELECT entry_id, tag FROM tags WHERE entry_id IN (${placeholders})`,
    args: ids,
  });

  const map = new Map<string, string[]>();
  for (const row of result.rows) {
    const entryId = toStringValue(row.entry_id);
    const tag = toStringValue(row.tag);
    if (!entryId || !tag) {
      continue;
    }
    const tags = map.get(entryId) ?? [];
    tags.push(tag);
    map.set(entryId, tags);
  }

  for (const [entryId, tags] of map.entries()) {
    map.set(entryId, Array.from(new Set(tags)));
  }

  return map;
}

function mapStoredEntry(row: Row, tags: string[]): StoredEntry {
  return {
    id: toStringValue(row.id),
    type: toStringValue(row.type) as StoredEntry["type"],
    subject: toStringValue(row.subject),
    content: toStringValue(row.content),
    confidence: toStringValue(row.confidence) as ConfidenceLevel,
    expiry: toStringValue(row.expiry) as Expiry,
    tags,
    source: {
      file: toStringValue(row.source_file),
      context: toStringValue(row.source_context),
    },
    embedding: mapBufferToVector(row.embedding),
    created_at: toStringValue(row.created_at),
    updated_at: toStringValue(row.updated_at),
    last_recalled_at: toStringValue(row.last_recalled_at) || undefined,
    recall_count: Number.isFinite(toNumber(row.recall_count)) ? toNumber(row.recall_count) : 0,
    confirmations: Number.isFinite(toNumber(row.confirmations)) ? toNumber(row.confirmations) : 0,
    contradictions: Number.isFinite(toNumber(row.contradictions)) ? toNumber(row.contradictions) : 0,
    superseded_by: toStringValue(row.superseded_by) || undefined,
  };
}

async function getTotalEntries(db: Client): Promise<number> {
  const result = await db.execute("SELECT COUNT(*) AS count FROM entries");
  const count = toNumber(result.rows[0]?.count);
  return Number.isFinite(count) ? count : 0;
}

async function hasContentHash(db: Client, contentHash: string): Promise<boolean> {
  const result = await db.execute({
    sql: "SELECT id FROM entries WHERE content_hash = ? LIMIT 1",
    args: [contentHash],
  });
  return result.rows.length > 0;
}

async function resolveEmbeddings(
  entries: KnowledgeEntry[],
  apiKey: string,
  embedFn: (texts: string[], key: string) => Promise<number[][]>,
): Promise<number[][]> {
  if (entries.length === 0) {
    return [];
  }

  const cache = new EmbeddingCache();
  const texts = entries.map((entry) => composeEmbeddingText(entry));

  const missingTexts: string[] = [];
  const missingSet = new Set<string>();
  for (const text of texts) {
    if (cache.get(text)) {
      continue;
    }
    if (!missingSet.has(text)) {
      missingSet.add(text);
      missingTexts.push(text);
    }
  }

  if (missingTexts.length > 0) {
    const missingEmbeddings = await embedFn(missingTexts, apiKey);
    if (missingEmbeddings.length !== missingTexts.length) {
      throw new Error(
        `Embedding provider returned ${missingEmbeddings.length} vectors for ${missingTexts.length} input texts.`,
      );
    }
    for (let i = 0; i < missingTexts.length; i += 1) {
      const text = missingTexts[i];
      const vector = missingEmbeddings[i];
      if (!text || !vector) {
        continue;
      }
      cache.set(text, vector);
    }
  }

  const vectors: number[][] = [];
  for (const text of texts) {
    const cached = cache.get(text);
    if (!cached) {
      throw new Error("Failed to resolve embedding for one or more entries.");
    }
    vectors.push(cached);
  }

  return vectors;
}

async function insertIngestLog(
  db: Client,
  params: {
    filePath: string;
    contentHash?: string;
    added: number;
    updated: number;
    skipped: number;
    durationMs: number;
  },
): Promise<void> {
  await db.execute({
    sql: `
      INSERT OR REPLACE INTO ingest_log (
        id,
        file_path,
        content_hash,
        ingested_at,
        entries_added,
        entries_updated,
        entries_skipped,
        duration_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      randomUUID(),
      params.filePath,
      params.contentHash ?? null,
      new Date().toISOString(),
      params.added,
      params.updated,
      params.skipped,
      params.durationMs,
    ],
  });
}

export function hashEntrySourceContent(entry: Pick<KnowledgeEntry, "content" | "source">): string {
  return createHash("sha256").update(`${entry.source.file}\n${entry.content}`).digest("hex");
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function findSimilar(
  db: Client,
  embedding: number[],
  limit = DEFAULT_SIMILAR_LIMIT,
): Promise<Array<{ entry: StoredEntry; similarity: number }>> {
  if (limit <= 0) {
    return [];
  }

  const result = await db.execute({
    sql: `
      SELECT
        e.id,
        e.type,
        e.subject,
        e.content,
        e.confidence,
        e.expiry,
        e.source_file,
        e.source_context,
        e.embedding,
        e.created_at,
        e.updated_at,
        e.last_recalled_at,
        e.recall_count,
        e.confirmations,
        e.contradictions,
        e.superseded_by
      FROM vector_top_k('idx_entries_embedding', vector32(?), ?) AS v
      JOIN entries AS e ON e.rowid = v.id
      WHERE e.embedding IS NOT NULL
    `,
    args: [JSON.stringify(embedding), limit],
  });

  const ids = result.rows.map((row) => toStringValue(row.id)).filter((id) => id.length > 0);
  const tagsByEntryId = await getTagsForEntryIds(db, ids);

  const similar = result.rows.map((row) => {
    const rowEmbedding = mapBufferToVector(row.embedding);
    const entryId = toStringValue(row.id);
    const entry = mapStoredEntry(row, tagsByEntryId.get(entryId) ?? []);
    return {
      entry,
      similarity: cosineSimilarity(embedding, rowEmbedding),
    };
  });

  similar.sort((a, b) => b.similarity - a.similarity);
  return similar;
}

export async function insertTags(db: Client, entryId: string, tags: string[]): Promise<void> {
  const uniqueTags = Array.from(
    new Set(
      tags
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
        .map((tag) => tag.toLowerCase()),
    ),
  );

  for (const tag of uniqueTags) {
    await db.execute({
      sql: "INSERT OR IGNORE INTO tags (entry_id, tag) VALUES (?, ?)",
      args: [entryId, tag],
    });
  }
}

export async function insertEntry(
  db: Client,
  entry: KnowledgeEntry,
  embedding: number[],
  contentHash: string,
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.execute({
    sql: `
      INSERT INTO entries (
        id,
        type,
        subject,
        content,
        confidence,
        expiry,
        source_file,
        source_context,
        content_hash,
        embedding,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, vector32(?), ?, ?)
    `,
    args: [
      id,
      entry.type,
      entry.subject,
      entry.content,
      entry.confidence,
      entry.expiry,
      entry.source.file,
      entry.source.context,
      contentHash,
      JSON.stringify(embedding),
      now,
      now,
    ],
  });

  await insertTags(db, id, entry.tags);
  return id;
}

export async function storeEntries(
  db: Client,
  entries: KnowledgeEntry[],
  apiKey: string,
  options: StoreEntriesOptions = {},
): Promise<StoreResult> {
  const startedAt = Date.now();
  const embedFn = options.embedFn ?? embed;
  const vectors = await resolveEmbeddings(entries, apiKey, embedFn);

  const totalBefore = await getTotalEntries(db);
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let relationsCreated = 0;

  await db.execute("BEGIN");
  try {
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const embedding = vectors[i];
      if (!entry || !embedding) {
        continue;
      }

      const contentHash = hashEntrySourceContent(entry);
      if (!options.force && (await hasContentHash(db, contentHash))) {
        skipped += 1;
        options.onDecision?.({
          entry,
          action: "skipped",
          reason: "idempotent content hash match",
        });
        continue;
      }

      let topMatch: { entry: StoredEntry; similarity: number } | undefined;
      if (!options.force) {
        const similar = await findSimilar(db, embedding, DEFAULT_SIMILAR_LIMIT);
        topMatch = similar[0];
      }

      if (topMatch && topMatch.similarity > AUTO_SKIP_THRESHOLD) {
        skipped += 1;
        options.onDecision?.({
          entry,
          action: "skipped",
          reason: "near-exact semantic duplicate",
          similarity: topMatch.similarity,
          matchedEntryId: topMatch.entry.id,
        });
        continue;
      }

      const similarity = topMatch?.similarity ?? 0;
      const sameSubject =
        topMatch && normalize(entry.subject) === normalize(topMatch.entry.subject) ? true : false;
      const sameType = topMatch && entry.type === topMatch.entry.type;

      if (
        !options.force &&
        topMatch &&
        similarity >= SMART_DEDUP_THRESHOLD &&
        similarity <= AUTO_SKIP_THRESHOLD &&
        sameSubject &&
        sameType
      ) {
        await db.execute({
          sql: `
            UPDATE entries
            SET confirmations = COALESCE(confirmations, 0) + 1,
                updated_at = ?
            WHERE id = ?
          `,
          args: [new Date().toISOString(), topMatch.entry.id],
        });
        updated += 1;
        options.onDecision?.({
          entry,
          action: "updated",
          reason: "reinforced existing entry (same subject+type)",
          similarity,
          matchedEntryId: topMatch.entry.id,
        });
        continue;
      }

      const newEntryId = await insertEntry(db, entry, embedding, contentHash);
      added += 1;

      if (
        !options.force &&
        topMatch &&
        similarity >= SMART_DEDUP_THRESHOLD &&
        similarity <= AUTO_SKIP_THRESHOLD &&
        sameSubject &&
        !sameType
      ) {
        await createRelation(db, newEntryId, topMatch.entry.id, "related");
        relationsCreated += 1;
        options.onDecision?.({
          entry,
          action: "added",
          reason: "added with related relation (same subject, different type)",
          similarity,
          matchedEntryId: topMatch.entry.id,
        });
        continue;
      }

      options.onDecision?.({
        entry,
        action: "added",
        reason: options.force ? "force mode" : "new entry",
        similarity: topMatch?.similarity,
        matchedEntryId: topMatch?.entry.id,
      });
    }

    const durationMs = Date.now() - startedAt;
    await insertIngestLog(db, {
      filePath: options.sourceFile ?? entries[0]?.source.file ?? "<unknown>",
      contentHash: options.ingestContentHash,
      added,
      updated,
      skipped,
      durationMs,
    });

    if (options.dryRun) {
      await db.execute("ROLLBACK");
      return {
        added,
        updated,
        skipped,
        relations_created: relationsCreated,
        total_entries: totalBefore + added,
        duration_ms: durationMs,
      };
    }

    await db.execute("COMMIT");

    return {
      added,
      updated,
      skipped,
      relations_created: relationsCreated,
      total_entries: await getTotalEntries(db),
      duration_ms: durationMs,
    };
  } catch (error) {
    try {
      await db.execute("ROLLBACK");
    } catch {
      // Ignore rollback failures.
    }
    throw error;
  }
}
