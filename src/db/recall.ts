import type { Client, InValue, Row } from "@libsql/client";
import { embed } from "../embeddings/client.js";
import type { KnowledgePlatform, RecallQuery, RecallResult, Scope, StoredEntry } from "../types.js";

const DEFAULT_VECTOR_CANDIDATE_LIMIT = 50;
const DEFAULT_SESSION_CANDIDATE_LIMIT = 500;
const DEFAULT_LIMIT = 10;
const MILLISECONDS_PER_DAY = 1000 * 60 * 60 * 24;

interface CandidateRow {
  entry: StoredEntry;
  vectorSim: number;
}

export interface RecallOptions {
  embedFn?: (texts: string[], apiKey: string) => Promise<number[][]>;
  now?: Date;
  vectorCandidateLimit?: number;
  sessionCandidateLimit?: number;
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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) {
    return [];
  }
  return Array.from(
    new Set(
      tags
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0),
    ),
  );
}

function mapStoredEntry(row: Row, tags: string[]): StoredEntry {
  const scopeRaw = toStringValue(row.scope);
  const scope = scopeRaw || "private";
  const importanceRaw = toNumber(row.importance);
  const importance = Number.isFinite(importanceRaw) ? Math.min(10, Math.max(1, Math.round(importanceRaw))) : 5;
  const platformRaw = toStringValue((row as Row & { platform?: unknown }).platform);
  const platform = platformRaw.trim().length > 0 ? platformRaw : undefined;

  return {
    id: toStringValue(row.id),
    type: toStringValue(row.type) as StoredEntry["type"],
    subject: toStringValue(row.subject),
    content: toStringValue(row.content),
    importance,
    expiry: toStringValue(row.expiry) as StoredEntry["expiry"],
    scope: scope as StoredEntry["scope"],
    ...(platform ? { platform: platform as KnowledgePlatform } : {}),
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

async function getTagsForEntryIds(db: Client, ids: string[]): Promise<Map<string, string[]>> {
  if (ids.length === 0) {
    return new Map();
  }

  const placeholders = ids.map(() => "?").join(", ");
  const result = await db.execute({
    sql: `SELECT entry_id, tag FROM tags WHERE entry_id IN (${placeholders})`,
    args: ids,
  });

  const tagsById = new Map<string, string[]>();
  for (const row of result.rows) {
    const entryId = toStringValue(row.entry_id);
    const tag = toStringValue(row.tag);
    if (!entryId || !tag) {
      continue;
    }

    const tags = tagsById.get(entryId) ?? [];
    tags.push(tag.toLowerCase());
    tagsById.set(entryId, tags);
  }

  for (const [entryId, tags] of tagsById.entries()) {
    tagsById.set(entryId, Array.from(new Set(tags)));
  }

  return tagsById;
}

function normalizeImportance(value: number): number {
  if (!Number.isFinite(value)) {
    return 5;
  }
  return Math.min(10, Math.max(1, Math.round(value)));
}

function resolveScopeSet(scope: Scope | undefined): Set<Scope> {
  if (scope === "public") {
    return new Set<Scope>(["public"]);
  }
  if (scope === "personal") {
    return new Set<Scope>(["personal", "public"]);
  }
  return new Set<Scope>(["private", "personal", "public"]);
}

function parseSince(since: string | undefined, now: Date): Date | undefined {
  if (!since) {
    return undefined;
  }

  const trimmed = since.trim();
  if (!trimmed) {
    return undefined;
  }

  const durationMatch = trimmed.match(/^(\d+)\s*([hdy])$/i);
  if (durationMatch) {
    const amount = Number(durationMatch[1]);
    const unit = durationMatch[2]?.toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0 || !unit) {
      return undefined;
    }

    let multiplier = 0;
    if (unit === "h") {
      multiplier = 1000 * 60 * 60;
    } else if (unit === "d") {
      multiplier = MILLISECONDS_PER_DAY;
    } else if (unit === "y") {
      multiplier = MILLISECONDS_PER_DAY * 365;
    }

    if (multiplier <= 0) {
      return undefined;
    }

    return new Date(now.getTime() - amount * multiplier);
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed;
}

function entryCreatedAfter(entry: StoredEntry, cutoff: Date | undefined): boolean {
  if (!cutoff) {
    return true;
  }
  const created = new Date(entry.created_at);
  if (Number.isNaN(created.getTime())) {
    return false;
  }
  return created.getTime() >= cutoff.getTime();
}

function passesFilters(
  entry: StoredEntry,
  query: RecallQuery,
  cutoff: Date | undefined,
  allowedScopes: Set<Scope>,
  normalizedTags: string[],
): boolean {
  if (entry.superseded_by) {
    return false;
  }

  if (query.types && query.types.length > 0 && !query.types.includes(entry.type)) {
    return false;
  }

  if (query.expiry && entry.expiry !== query.expiry) {
    return false;
  }

  if (query.minImportance !== undefined && normalizeImportance(entry.importance) < normalizeImportance(query.minImportance)) {
    return false;
  }

  if (!entryCreatedAfter(entry, cutoff)) {
    return false;
  }

  const entryScope = (entry.scope ?? "private") as Scope;
  if (!allowedScopes.has(entryScope)) {
    return false;
  }

  if (normalizedTags.length > 0) {
    const tagSet = new Set(entry.tags.map((tag) => tag.toLowerCase()));
    const hasAnyTag = normalizedTags.some((tag) => tagSet.has(tag));
    if (!hasAnyTag) {
      return false;
    }
  }

  return true;
}

function parseDaysBetween(now: Date, pastIso: string | undefined): number {
  if (!pastIso) {
    return 0;
  }
  const parsed = new Date(pastIso);
  if (Number.isNaN(parsed.getTime())) {
    return 0;
  }
  const delta = (now.getTime() - parsed.getTime()) / MILLISECONDS_PER_DAY;
  if (!Number.isFinite(delta)) {
    return 0;
  }
  return Math.max(delta, 0);
}

export function todoStaleness(updatedAt: string, now: Date): number {
  const days = parseDaysBetween(now, updatedAt);
  if (days <= 3) return 1.0;
  if (days <= 7) return 0.6;
  if (days <= 14) return 0.3;
  return 0.1;
}

function getScoreComponents(entry: StoredEntry, now: Date): { daysOld: number; rec: number; imp: number; recall: number } {
  const daysOld = parseDaysBetween(now, entry.created_at);
  const daysSinceRecall = entry.last_recalled_at ? parseDaysBetween(now, entry.last_recalled_at) : daysOld;
  const rec = recency(daysOld, entry.expiry);
  const imp = importanceScore(entry.importance);
  const recall = recallStrength(entry.recall_count, daysSinceRecall, entry.expiry);
  return { daysOld, rec, imp, recall };
}

export function recency(daysOld: number, tier: string): number {
  const FACTOR = 19 / 81;
  const DECAY = -0.5;
  const halfLife: Record<string, number> = {
    core: Number.POSITIVE_INFINITY,
    permanent: 365,
    temporary: 30,
  };

  const hl = halfLife[tier] ?? 30;
  if (hl === Number.POSITIVE_INFINITY) {
    return 1.0;
  }
  return Math.pow(1 + (FACTOR * Math.max(daysOld, 0)) / hl, DECAY);
}

export function importanceScore(importance: number): number {
  const normalized = normalizeImportance(importance);
  return 0.55 + ((normalized - 1) / 9) * 0.45;
}

export function recallStrength(recallCount: number, daysSinceRecall: number, tier: string): number {
  if (tier === "core") {
    return 1.0;
  }
  if (recallCount <= 0) {
    return 0;
  }
  return Math.min(Math.pow(recallCount, 0.7) / 5, 1.0) * recency(daysSinceRecall, tier);
}

export function scoreEntry(entry: StoredEntry, vectorSim: number, ftsMatch: boolean, now: Date): number {
  const daysOld = parseDaysBetween(now, entry.created_at);
  const daysSinceRecall = entry.last_recalled_at ? parseDaysBetween(now, entry.last_recalled_at) : daysOld;

  const sim = Math.pow(clamp01(vectorSim), 0.7);
  const rec = recency(daysOld, entry.expiry);
  const imp = importanceScore(entry.importance);
  const recall = recallStrength(entry.recall_count, daysSinceRecall, entry.expiry);
  const fts = ftsMatch ? 0.15 : 0;

  const memoryStrength = Math.max(imp, recall);
  const contradictionPenalty = entry.contradictions >= 2 ? 0.8 : 1.0;
  return sim * (0.3 + 0.7 * rec) * memoryStrength * contradictionPenalty + fts;
}

export function shapeRecallText(text: string, context: string | undefined): string {
  const trimmedText = text.trim();
  if (!trimmedText) {
    return "";
  }

  const contextTrimmed = context?.trim() ?? "";
  if (!contextTrimmed.startsWith("topic:")) {
    return trimmedText;
  }

  if (/^\[topic:\s*.+\]/i.test(trimmedText)) {
    return trimmedText;
  }

  const topic = contextTrimmed.slice("topic:".length).trim();
  if (!topic) {
    return trimmedText;
  }

  return `[topic: ${topic}] ${trimmedText}`;
}

async function fetchVectorCandidates(
  db: Client,
  queryEmbedding: number[],
  limit: number,
  platform?: KnowledgePlatform,
): Promise<CandidateRow[]> {
  const args: unknown[] = [JSON.stringify(queryEmbedding), limit];
  if (platform) {
    args.push(platform);
  }

  const result = await db.execute({
    sql: `
      SELECT
        e.id,
        e.type,
        e.subject,
        e.content,
        e.importance,
        e.expiry,
        e.scope,
        e.platform,
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
      CROSS JOIN entries AS e ON e.rowid = v.id
      WHERE e.embedding IS NOT NULL
        AND e.superseded_by IS NULL
        ${platform ? "AND e.platform = ?" : ""}
    `,
    args,
  });

  const ids = result.rows.map((row) => toStringValue(row.id)).filter((id) => id.length > 0);
  const tagsByEntryId = await getTagsForEntryIds(db, ids);

  return result.rows.map((row) => {
    const entryId = toStringValue(row.id);
    const entry = mapStoredEntry(row, tagsByEntryId.get(entryId) ?? []);
    const rowEmbedding = mapBufferToVector(row.embedding);
    return {
      entry,
      vectorSim: clamp01(cosineSimilarity(queryEmbedding, rowEmbedding)),
    };
  });
}

async function fetchSessionCandidates(db: Client, limit: number, platform?: KnowledgePlatform): Promise<CandidateRow[]> {
  const args: unknown[] = [limit];
  if (platform) {
    args.unshift(platform);
  }

  const result = await db.execute({
    sql: `
      SELECT
        id,
        type,
        subject,
        content,
        importance,
        expiry,
        scope,
        platform,
        source_file,
        source_context,
        embedding,
        created_at,
        updated_at,
        last_recalled_at,
        recall_count,
        confirmations,
        contradictions,
        superseded_by
      FROM entries
      WHERE superseded_by IS NULL
        ${platform ? "AND platform = ?" : ""}
      ORDER BY updated_at DESC
      LIMIT ?
    `,
    args,
  });

  const ids = result.rows.map((row) => toStringValue(row.id)).filter((id) => id.length > 0);
  const tagsByEntryId = await getTagsForEntryIds(db, ids);

  return result.rows.map((row) => {
    const entryId = toStringValue(row.id);
    return {
      entry: mapStoredEntry(row, tagsByEntryId.get(entryId) ?? []),
      vectorSim: 0,
    };
  });
}

async function runFts(db: Client, text: string, platform?: KnowledgePlatform): Promise<Set<string>> {
  if (!text.trim()) {
    return new Set();
  }

  try {
    const args: unknown[] = [text];
    if (platform) {
      args.push(platform);
    }

    const result = await db.execute({
      sql: `
        SELECT e.id
        FROM entries_fts
        JOIN entries AS e ON e.rowid = entries_fts.rowid
        WHERE entries_fts MATCH ?
          AND e.superseded_by IS NULL
          ${platform ? "AND e.platform = ?" : ""}
        LIMIT 250
      `,
      args,
    });

    return new Set(result.rows.map((row) => toStringValue(row.id)).filter((id) => id.length > 0));
  } catch {
    return new Set();
  }
}

export async function updateRecallMetadata(db: Client, ids: string[], now: Date): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  const placeholders = ids.map(() => "?").join(", ");
  await db.execute({
    sql: `
      UPDATE entries
      SET recall_count = COALESCE(recall_count, 0) + 1,
          last_recalled_at = ?
      WHERE id IN (${placeholders})
    `,
    args: [now.toISOString(), ...ids],
  });
}

function scoreSessionEntry(entry: StoredEntry, now: Date): { score: number; scores: RecallResult["scores"] } {
  const components = getScoreComponents(entry, now);
  const memoryStrength = Math.max(components.imp, components.recall);
  const baseScore = (0.3 + 0.7 * components.rec) * memoryStrength;
  const score = entry.type === "todo" ? baseScore * todoStaleness(entry.updated_at, now) : baseScore;
  return {
    score,
    scores: {
      vector: 1,
      recency: components.rec,
      importance: components.imp,
      recall: components.recall,
      fts: 0,
    },
  };
}

export async function recall(
  db: Client,
  query: RecallQuery,
  apiKey: string,
  options: RecallOptions = {},
): Promise<RecallResult[]> {
  const now = options.now ?? new Date();
  const text = query.text?.trim() ?? "";
  const context = query.context?.trim() ?? "default";
  const platform = query.platform;

  if (!text && context !== "session-start") {
    throw new Error("Query text is required unless --context session-start is used.");
  }

  if (!text && query.noBoost) {
    throw new Error("--no-boost requires query text.");
  }

  const normalizedTags = normalizeTags(query.tags);
  const cutoff = parseSince(query.since, now);
  const allowedScopes = resolveScopeSet(query.scope);

  let candidates: CandidateRow[];
  let effectiveText = text;

  if (text) {
    effectiveText = shapeRecallText(text, query.context);
    const embedFn = options.embedFn ?? embed;
    const embeddings = await embedFn([effectiveText], apiKey);
    const queryEmbedding = embeddings[0];
    if (!queryEmbedding) {
      throw new Error("Embedding provider returned no vector for recall query.");
    }
    candidates = await fetchVectorCandidates(
      db,
      queryEmbedding,
      options.vectorCandidateLimit ?? DEFAULT_VECTOR_CANDIDATE_LIMIT,
      platform,
    );
  } else {
    candidates = await fetchSessionCandidates(db, options.sessionCandidateLimit ?? DEFAULT_SESSION_CANDIDATE_LIMIT, platform);
  }

  const filtered = candidates.filter((candidate) =>
    passesFilters(candidate.entry, query, cutoff, allowedScopes, normalizedTags),
  );

  if (filtered.length === 0) {
    return [];
  }

  const ftsMatches = text && !query.noBoost ? await runFts(db, effectiveText, platform) : new Set<string>();

  const scored: RecallResult[] = filtered.map((candidate) => {
    const ftsMatch = ftsMatches.has(candidate.entry.id);

    if (!text) {
      const sessionScore = scoreSessionEntry(candidate.entry, now);
      return {
        entry: candidate.entry,
        score: sessionScore.score,
        scores: sessionScore.scores,
      };
    }

    if (query.noBoost) {
      const rawVector = clamp01(candidate.vectorSim);
      return {
        entry: candidate.entry,
        score: rawVector,
        scores: {
          vector: rawVector,
          recency: 0,
          importance: 0,
          recall: 0,
          fts: 0,
        },
      };
    }

    const components = getScoreComponents(candidate.entry, now);
    return {
      entry: candidate.entry,
      score: scoreEntry(candidate.entry, candidate.vectorSim, ftsMatch, now),
      scores: {
        vector: clamp01(candidate.vectorSim),
        recency: components.rec,
        importance: components.imp,
        recall: components.recall,
        fts: ftsMatch ? 0.15 : 0,
      },
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const limit = Number.isFinite(query.limit) && (query.limit ?? 0) > 0 ? Math.floor(query.limit as number) : DEFAULT_LIMIT;
  const results = scored.slice(0, limit);

  if (!query.noUpdate) {
    const ids = results.map((result) => result.entry.id);
    await updateRecallMetadata(db, ids, now);
    const nowIso = now.toISOString();
    for (const result of results) {
      result.entry.recall_count += 1;
      result.entry.last_recalled_at = nowIso;
    }
  }

  return results;
}
