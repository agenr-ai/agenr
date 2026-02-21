import type { Client, InValue, Row } from "@libsql/client";
import { mapRawStoredEntry } from "./stored-entry.js";
import { embed } from "../embeddings/client.js";
import { buildProjectFilter, parseProjectList } from "../project.js";
import { parseDaysBetween, toNumber, toStringValue } from "../utils/entry-utils.js";
import { parseSince } from "../utils/time.js";
import { DEFAULT_SESSION_CANDIDATE_LIMIT } from "./session-start.js";
import type { KnowledgePlatform, RecallQuery, RecallResult, Scope, StoredEntry } from "../types.js";

const DEFAULT_VECTOR_CANDIDATE_LIMIT = 50;
const DEFAULT_LIMIT = 10;

export interface CandidateRow {
  entry: StoredEntry;
  vectorSim: number;
}

export interface RecallOptions {
  embedFn?: (texts: string[], apiKey: string) => Promise<number[][]>;
  now?: Date;
  vectorCandidateLimit?: number;
  sessionCandidateLimit?: number;
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

export function mapStoredEntry(row: Row, tags: string[]): StoredEntry {
  return mapRawStoredEntry(row as Record<string, unknown>, {
    tags,
    embedding: mapBufferToVector(row.embedding),
  });
}

export async function getTagsForEntryIds(db: Client, ids: string[]): Promise<Map<string, string[]>> {
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
  isSessionStart: boolean,
): boolean {
  if (entry.superseded_by) {
    return false;
  }

  if (entry.retired) {
    return false;
  }

  if (isSessionStart && entry.suppressed_contexts?.includes("session-start")) {
    return false;
  }

  if (query.types && query.types.length > 0 && !query.types.includes(entry.type)) {
    return false;
  }

  if (query.expiry) {
    if (Array.isArray(query.expiry)) {
      if (!query.expiry.includes(entry.expiry)) {
        return false;
      }
    } else if (entry.expiry !== query.expiry) {
      return false;
    }
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

export function freshnessBoost(entry: StoredEntry, now: Date): number {
  if (entry.importance < 6) return 1.0;
  const hoursOld = parseDaysBetween(now, entry.created_at) * 24;
  if (hoursOld < 1) return 1.5;
  if (hoursOld < 6) return 1.25;
  if (hoursOld < 24) return 1.1;
  return 1.0;
}

export function todoStaleness(entry: StoredEntry, now: Date): number {
  const days = parseDaysBetween(now, entry.updated_at);
  // Exponential decay: half-life 7 days, with a floor to avoid starving old but still-relevant todos.
  const raw = Math.pow(0.5, days / 7);
  const floor = entry.importance >= 8 ? 0.40 : 0.10;
  return Math.max(raw, floor);
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

export function computeSpacingFactor(
  intervals: number[],
  recallCount?: number,
  createdAt?: string,
  lastRecalledAt?: string,
): number {
  // Work on a copy - do not mutate the input array.
  const timestamps = [...intervals];

  // Legacy imputation: synthesize uniform intervals from lifetime span when
  // recall_intervals was not recorded (pre-v0.6.4 entries).
  // This prevents older important memories from being permanently buried.
  if (
    timestamps.length === 0 &&
    recallCount !== undefined &&
    recallCount > 0 &&
    createdAt &&
    lastRecalledAt
  ) {
    const createdMs = Date.parse(createdAt);
    const lastMs = Date.parse(lastRecalledAt);
    if (Number.isFinite(createdMs) && Number.isFinite(lastMs) && lastMs > createdMs) {
      const gapMs = (lastMs - createdMs) / recallCount;
      timestamps.push(Math.round(createdMs / 1000));
      for (let i = 1; i <= recallCount; i += 1) {
        timestamps.push(Math.round((createdMs + gapMs * i) / 1000));
      }
    }
  }

  if (timestamps.length < 2) {
    // Not enough data points to measure a spacing interval.
    return 1.0;
  }

  // Sort ascending to handle out-of-order timestamps (clock skew, migration artifacts).
  const sorted = [...timestamps].sort((a, b) => a - b);

  // Find the longest single gap between consecutive recalls.
  let maxGapDays = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1] ?? 0;
    const curr = sorted[i] ?? 0;
    const gapDays = Math.max(0, (curr - prev) / 86400);
    if (gapDays > maxGapDays) {
      maxGapDays = gapDays;
    }
  }

  // Shift by +1 so a 1-day gap produces a bonus (log1p(2) ~= 1.099).
  // Floor at 1.0 so same-day cramming is neutral, not penalized.
  return Math.max(1.0, Math.log1p(maxGapDays + 1));
}

export function scoreEntryWithBreakdown(
  entry: StoredEntry,
  vectorSim: number,
  ftsMatch: boolean,
  now: Date,
): { score: number; scores: RecallResult["scores"] } {
  const daysOld = parseDaysBetween(now, entry.created_at);
  const daysSinceRecall = entry.last_recalled_at
    ? parseDaysBetween(now, entry.last_recalled_at)
    : daysOld;

  const rawVector = clamp01(vectorSim);
  const sim = Math.pow(rawVector, 0.7);
  const rec = recency(daysOld, entry.expiry);
  const imp = importanceScore(entry.importance);
  const recallBase = recallStrength(entry.recall_count, daysSinceRecall, entry.expiry);

  const spacingFactor = computeSpacingFactor(
    entry.recall_intervals ?? [],
    entry.recall_count,
    entry.created_at,
    entry.last_recalled_at,
  );

  const fts = ftsMatch ? 0.15 : 0;

  const fresh = freshnessBoost(entry, now);
  const spacedRecallBase = Math.min(recallBase * spacingFactor, 1.0);
  const memoryStrength = Math.min(Math.max(imp, spacedRecallBase) * fresh, 1.0);
  const todoPenalty = entry.type === "todo" ? todoStaleness(entry, now) : 1.0;
  const contradictionPenalty = entry.contradictions >= 2 ? 0.8 : 1.0;
  const score = sim * (0.3 + 0.7 * rec) * memoryStrength * todoPenalty * contradictionPenalty + fts;
  return {
    score,
    scores: {
      vector: rawVector,
      recency: rec,
      importance: imp,
      recall: recallBase,
      freshness: fresh,
      todoPenalty,
      fts,
      spacing: spacingFactor,
    },
  };
}

export function scoreEntry(entry: StoredEntry, vectorSim: number, ftsMatch: boolean, now: Date): number {
  return scoreEntryWithBreakdown(entry, vectorSim, ftsMatch, now).score;
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
  project?: string | string[],
  excludeProject?: string | string[],
  projectStrict?: boolean,
): Promise<CandidateRow[]> {
  const normalizedProject = parseProjectList(project);
  const normalizedExclude = parseProjectList(excludeProject);
  const projectSql = buildProjectFilter({
    column: "e.project",
    strict: Boolean(projectStrict && normalizedProject.length > 0),
    project: normalizedProject.length > 0 ? normalizedProject : undefined,
    excludeProject: normalizedExclude.length > 0 ? normalizedExclude : undefined,
  });

  // args order: JSON.stringify(queryEmbedding) (vector32(?)), limit, ...projectSql.args, platform (if present)
  const args: unknown[] = [JSON.stringify(queryEmbedding), limit, ...projectSql.args];
  if (platform) {
    args.push(platform);
  }

  const result = await db.execute({
    sql: `
      SELECT
        e.id,
        e.type,
        e.subject,
        e.canonical_key,
        e.content,
        e.importance,
        e.expiry,
        e.scope,
        e.platform,
        e.project,
        e.source_file,
        e.source_context,
        e.embedding,
        e.created_at,
        e.updated_at,
        e.last_recalled_at,
        e.recall_count,
        e.recall_intervals,
        e.confirmations,
        e.contradictions,
        e.superseded_by,
        e.retired,
        e.retired_at,
        e.retired_reason,
        e.suppressed_contexts
      FROM vector_top_k('idx_entries_embedding', vector32(?), ?) AS v
      CROSS JOIN entries AS e ON e.rowid = v.id
      WHERE e.embedding IS NOT NULL
        AND e.superseded_by IS NULL
        AND e.retired = 0
        ${projectSql.clause}
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

export async function fetchRelatedEntries(
  db: Client,
  queryEmbedding: number[],
  limit: number,
): Promise<CandidateRow[]> {
  return fetchVectorCandidates(db, queryEmbedding, limit);
}

async function fetchSessionCandidates(
  db: Client,
  limit: number,
  context: string,
  platform?: KnowledgePlatform,
  project?: string | string[],
  excludeProject?: string | string[],
  projectStrict?: boolean,
): Promise<CandidateRow[]> {
  const normalizedProject = parseProjectList(project);
  const normalizedExclude = parseProjectList(excludeProject);
  const projectSql = buildProjectFilter({
    column: "project",
    strict: Boolean(projectStrict && normalizedProject.length > 0),
    project: normalizedProject.length > 0 ? normalizedProject : undefined,
    excludeProject: normalizedExclude.length > 0 ? normalizedExclude : undefined,
  });

  const args: unknown[] = [...projectSql.args];
  if (platform) {
    args.push(platform);
  }
  args.push(limit);

  const result = await db.execute({
    sql: `
      SELECT
        id,
        type,
        subject,
        canonical_key,
        content,
        importance,
        expiry,
        scope,
        platform,
        project,
        source_file,
        source_context,
        embedding,
        created_at,
        updated_at,
        last_recalled_at,
        recall_count,
        recall_intervals,
        confirmations,
        contradictions,
        superseded_by,
        retired,
        retired_at,
        retired_reason,
        suppressed_contexts
      FROM entries
      WHERE superseded_by IS NULL
        AND retired = 0
        ${context === "session-start" ? "AND (suppressed_contexts IS NULL OR suppressed_contexts NOT LIKE '%\"session-start\"%')" : ""}
        ${projectSql.clause}
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

async function runFts(
  db: Client,
  text: string,
  platform?: KnowledgePlatform,
  project?: string | string[],
  excludeProject?: string | string[],
  projectStrict?: boolean,
): Promise<Set<string>> {
  if (!text.trim()) {
    return new Set();
  }

  try {
    const normalizedProject = parseProjectList(project);
    const normalizedExclude = parseProjectList(excludeProject);
    const projectSql = buildProjectFilter({
      column: "e.project",
      strict: Boolean(projectStrict && normalizedProject.length > 0),
      project: normalizedProject.length > 0 ? normalizedProject : undefined,
      excludeProject: normalizedExclude.length > 0 ? normalizedExclude : undefined,
    });

    const args: unknown[] = [text, ...projectSql.args];
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
          AND e.retired = 0
          ${projectSql.clause}
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
  // TODO: cap recall_intervals to the 100 most recent entries to bound storage
  // growth. computeSpacingFactor only needs maxGapDays, not the full history.
  // Consider storing max_gap_days as a separate field instead.
  // See: https://github.com/agenr-ai/agenr/issues/39
  const epochSecs = Math.floor(now.getTime() / 1000);
  await db.execute({
    sql: `
      UPDATE entries
      SET recall_count = COALESCE(recall_count, 0) + 1,
          last_recalled_at = ?,
          recall_intervals = json_insert(COALESCE(recall_intervals, '[]'), '$[#]', ?)
      WHERE id IN (${placeholders})
    `,
    args: [now.toISOString(), epochSecs, ...ids],
  });
}

function scoreSessionEntry(entry: StoredEntry, now: Date): { score: number; scores: RecallResult["scores"] } {
  return scoreEntryWithBreakdown(entry, 1.0, false, now);
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
  const project = query.project;
  const excludeProject = query.excludeProject;
  const projectStrict = query.projectStrict === true;
  const isSessionStart = context === "session-start";

  if (!text && context !== "session-start") {
    throw new Error("Query text is required unless --context session-start is used.");
  }

  if (!text && query.noBoost) {
    throw new Error("--no-boost requires query text.");
  }

  const normalizedTags = normalizeTags(query.tags);
  let cutoff: Date | undefined;
  try {
    cutoff = parseSince(query.since, now);
  } catch {
    cutoff = undefined;
  }
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
      project,
      excludeProject,
      projectStrict,
    );
  } else {
    candidates = await fetchSessionCandidates(
      db,
      options.sessionCandidateLimit ?? DEFAULT_SESSION_CANDIDATE_LIMIT,
      context,
      platform,
      project,
      excludeProject,
      projectStrict,
    );
  }

  const filtered = candidates.filter((candidate) =>
    passesFilters(candidate.entry, query, cutoff, allowedScopes, normalizedTags, isSessionStart),
  );

  if (filtered.length === 0) {
    return [];
  }

  const ftsMatches =
    text && !query.noBoost
      ? await runFts(db, effectiveText, platform, project, excludeProject, projectStrict)
      : new Set<string>();

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
          freshness: 1,
          todoPenalty: 1,
          fts: 0,
          spacing: 1.0,
        },
      };
    }

    const detailed = scoreEntryWithBreakdown(candidate.entry, candidate.vectorSim, ftsMatch, now);
    return {
      entry: candidate.entry,
      score: detailed.score,
      scores: detailed.scores,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const limit = Number.isFinite(query.limit) && (query.limit ?? 0) > 0 ? Math.floor(query.limit as number) : DEFAULT_LIMIT;
  const results = scored.slice(0, limit);

  if (!query.noUpdate) {
    const ids = results.map((result) => result.entry.id);
    await updateRecallMetadata(db, ids, now);
    const nowIso = now.toISOString();
    const epochSecs = Math.floor(now.getTime() / 1000);
    for (const result of results) {
      result.entry.recall_count += 1;
      result.entry.last_recalled_at = nowIso;
      result.entry.recall_intervals = [
        ...(result.entry.recall_intervals ?? []),
        epochSecs,
      ];
    }
  }

  return results;
}
