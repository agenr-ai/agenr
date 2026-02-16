import { createHash, randomUUID } from "node:crypto";
import type { Context, Tool } from "@mariozechner/pi-ai";
import type { Client, InValue, Row } from "@libsql/client";
import { Type, type Static } from "@sinclair/typebox";
import { warnIfLocked } from "../consolidate/lock.js";
import { composeEmbeddingText, embed } from "../embeddings/client.js";
import { EmbeddingCache } from "../embeddings/cache.js";
import { runSimpleStream } from "../llm/stream.js";
import type { Expiry, KnowledgeEntry, LlmClient, RelationType, StoreResult, StoredEntry } from "../types.js";
import { createRelation } from "./relations.js";

const AUTO_SKIP_THRESHOLD = 0.98;
const SMART_DEDUP_THRESHOLD = 0.92;
const DEFAULT_DEDUP_THRESHOLD = 0.8;
const DEFAULT_SIMILAR_LIMIT = 5;

const ONLINE_DEDUP_ACTIONS = ["ADD", "UPDATE", "SKIP", "SUPERSEDE"] as const;
export type OnlineDedupAction = (typeof ONLINE_DEDUP_ACTIONS)[number];

const ONLINE_DEDUP_TOOL_SCHEMA = Type.Object({
  action: Type.Union(ONLINE_DEDUP_ACTIONS.map((value) => Type.Literal(value))),
  target_id: Type.Union([Type.String(), Type.Null()]),
  merged_content: Type.Union([Type.String(), Type.Null()]),
  reasoning: Type.String(),
});

type OnlineDedupToolArgs = Static<typeof ONLINE_DEDUP_TOOL_SCHEMA>;

const ONLINE_DEDUP_TOOL: Tool<typeof ONLINE_DEDUP_TOOL_SCHEMA> = {
  name: "online_dedup_decision",
  description: "Decide whether to ADD, UPDATE, SKIP, or SUPERSEDE for incoming knowledge.",
  parameters: ONLINE_DEDUP_TOOL_SCHEMA,
};

export interface OnlineDedupDecision {
  action: OnlineDedupAction;
  target_id: string | null;
  merged_content: string | null;
  reasoning: string;
}

export interface StoreEntryDecision {
  entry: KnowledgeEntry;
  action: "added" | "updated" | "skipped" | "superseded";
  reason: string;
  similarity?: number;
  matchedEntryId?: string;
  newEntryId?: string;
  matchedEntry?: StoredEntry;
  sameSubject?: boolean;
  llm_action?: OnlineDedupAction;
  llm_reasoning?: string;
  relation_type?: RelationType;
}

export interface StoreEntriesOptions {
  dryRun?: boolean;
  verbose?: boolean;
  force?: boolean;
  sourceFile?: string;
  ingestContentHash?: string;
  skipIngestLog?: boolean;
  onDecision?: (decision: StoreEntryDecision) => void;
  embedFn?: (texts: string[], apiKey: string) => Promise<number[][]>;
  onlineDedup?: boolean;
  skipLlmDedup?: boolean;
  dedupThreshold?: number;
  llmClient?: LlmClient;
  onlineDedupFn?: (
    client: LlmClient,
    newEntry: KnowledgeEntry,
    candidates: Array<{ entry: StoredEntry; similarity: number }>,
  ) => Promise<OnlineDedupDecision>;
}

interface PlannedMutation {
  kind: "none" | "add" | "add_related" | "reinforce" | "skip" | "update" | "supersede";
  contentHash?: string;
  embedding?: number[];
  matchedEntry?: StoredEntry;
  similarity?: number;
  llmDecision?: OnlineDedupDecision;
  mergedContent?: string;
}

interface ProcessedEntry {
  decision: StoreEntryDecision;
  mutation: PlannedMutation;
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

function normalizeCreatedAt(value: string | undefined): string | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed.toISOString();
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

function isOnlineDedupAction(value: unknown): value is OnlineDedupAction {
  return typeof value === "string" && ONLINE_DEDUP_ACTIONS.includes(value as OnlineDedupAction);
}

async function incrementConfirmations(db: Client, entryId: string, newContentHash?: string): Promise<void> {
  const now = new Date().toISOString();
  if (newContentHash) {
    await db.execute({
      sql: `
        UPDATE entries
        SET confirmations = COALESCE(confirmations, 0) + 1,
            content_hash = ?,
            updated_at = ?
        WHERE id = ?
      `,
      args: [newContentHash, now, entryId],
    });
    return;
  }

  await db.execute({
    sql: `
      UPDATE entries
      SET confirmations = COALESCE(confirmations, 0) + 1,
          updated_at = ?
      WHERE id = ?
    `,
    args: [now, entryId],
  });
}

async function markSuperseded(db: Client, entryId: string, supersededBy: string): Promise<void> {
  await db.execute({
    sql: `
      UPDATE entries
      SET superseded_by = ?,
          updated_at = ?
      WHERE id = ?
    `,
    args: [supersededBy, new Date().toISOString(), entryId],
  });
}

async function updateEntryForMerge(
  db: Client,
  entryId: string,
  mergedContent: string,
  embedding: number[],
  contentHash: string,
): Promise<void> {
  await db.execute({
    sql: `
      UPDATE entries
      SET content = ?,
          content_hash = ?,
          embedding = vector32(?),
          confirmations = COALESCE(confirmations, 0) + 1,
          updated_at = ?
      WHERE id = ?
    `,
    args: [mergedContent, contentHash, JSON.stringify(embedding), new Date().toISOString(), entryId],
  });
}

function buildOnlineDedupContext(
  newEntry: KnowledgeEntry,
  candidates: Array<{ entry: StoredEntry; similarity: number }>,
): Context {
  const similarLines = candidates
    .map((candidate, index) => {
      const entry = candidate.entry;
      return [
        `Candidate ${index + 1}:`,
        `- id: ${entry.id}`,
        `- similarity: ${candidate.similarity.toFixed(4)}`,
        `- type: ${entry.type}`,
        `- subject: ${entry.subject}`,
        `- content: ${entry.content}`,
        `- created_at: ${entry.created_at}`,
      ].join("\n");
    })
    .join("\n\n");

  const systemPrompt = [
    "You perform online knowledge deduplication.",
    "Given one new entry and similar existing entries, return exactly one action:",
    "- ADD: new knowledge not already captured.",
    "- UPDATE: merge new detail into one existing entry.",
    "- SKIP: already captured by existing knowledge.",
    "- SUPERSEDE: new entry makes one existing entry obsolete/incorrect.",
    "When uncertain between ADD and SKIP, prefer SKIP.",
    "Use temporal context: newer concrete info may justify UPDATE or SUPERSEDE.",
    "Rules:",
    "- For ADD, set target_id=null and merged_content=null.",
    "- For UPDATE, set target_id to one existing id and provide merged_content.",
    "- For SKIP, set target_id to one existing id and merged_content=null.",
    "- For SUPERSEDE, set target_id to one existing id and merged_content=null.",
    "Call online_dedup_decision with your final decision.",
  ].join("\n");

  const userPrompt = [
    "NEW entry:",
    `- type: ${newEntry.type}`,
    `- subject: ${newEntry.subject}`,
    `- content: ${newEntry.content}`,
    `- importance: ${newEntry.importance}`,
    `- tags: ${newEntry.tags.join(", ") || "(none)"}`,
    "",
    "SIMILAR existing entries:",
    similarLines,
    "",
    "Return only via online_dedup_decision.",
  ].join("\n");

  return {
    systemPrompt,
    messages: [
      {
        role: "user",
        content: userPrompt,
        timestamp: Date.now(),
      },
    ],
    tools: [ONLINE_DEDUP_TOOL],
  };
}

function extractOnlineDedupFromToolCall(
  message: { content: Array<{ type: string; name?: string; arguments?: unknown }> },
): OnlineDedupDecision | null {
  for (const block of message.content) {
    if (block.type !== "toolCall" || block.name !== "online_dedup_decision") {
      continue;
    }

    const args = block.arguments as Partial<OnlineDedupToolArgs> | undefined;
    if (!args || !isOnlineDedupAction(args.action)) {
      return null;
    }

    const targetId = typeof args.target_id === "string" && args.target_id.trim().length > 0 ? args.target_id.trim() : null;
    const mergedContent =
      typeof args.merged_content === "string" && args.merged_content.trim().length > 0
        ? args.merged_content.trim()
        : null;

    const reasoning = typeof args.reasoning === "string" ? args.reasoning.trim() : "";

    return {
      action: args.action,
      target_id: targetId,
      merged_content: mergedContent,
      reasoning,
    };
  }

  return null;
}

export async function classifyOnlineDedup(
  client: LlmClient,
  newEntry: KnowledgeEntry,
  candidates: Array<{ entry: StoredEntry; similarity: number }>,
): Promise<OnlineDedupDecision> {
  try {
    const response = await runSimpleStream({
      model: client.resolvedModel.model,
      context: buildOnlineDedupContext(newEntry, candidates),
      options: {
        apiKey: client.credentials.apiKey,
      },
      verbose: false,
    });

    if (response.stopReason === "error" || response.errorMessage) {
      return {
        action: "ADD",
        target_id: null,
        merged_content: null,
        reasoning: "LLM error during online dedup; defaulting to ADD.",
      };
    }

    const parsed = extractOnlineDedupFromToolCall(response);
    if (!parsed) {
      return {
        action: "ADD",
        target_id: null,
        merged_content: null,
        reasoning: "Missing or invalid tool call; defaulting to ADD.",
      };
    }

    return parsed;
  } catch {
    return {
      action: "ADD",
      target_id: null,
      merged_content: null,
      reasoning: "LLM exception during online dedup; defaulting to ADD.",
    };
  }
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
  const importanceRaw = toNumber(row.importance);
  const importance = Number.isFinite(importanceRaw) ? Math.min(10, Math.max(1, Math.round(importanceRaw))) : 5;
  return {
    id: toStringValue(row.id),
    type: toStringValue(row.type) as StoredEntry["type"],
    subject: toStringValue(row.subject),
    content: toStringValue(row.content),
    importance,
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

async function getStoredEntryById(db: Client, id: string): Promise<StoredEntry | null> {
  const result = await db.execute({
    sql: `
      SELECT
        id,
        type,
        subject,
        content,
        importance,
        expiry,
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
      WHERE id = ?
      LIMIT 1
    `,
    args: [id],
  });

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const tagsById = await getTagsForEntryIds(db, [id]);
  return mapStoredEntry(row, tagsById.get(id) ?? []);
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

async function resolveEmbeddingForText(
  text: string,
  apiKey: string,
  embedFn: (texts: string[], key: string) => Promise<number[][]>,
  cache: EmbeddingCache,
): Promise<number[]> {
  const cached = cache.get(text);
  if (cached) {
    return cached;
  }

  const vectors = await embedFn([text], apiKey);
  if (vectors.length !== 1 || !vectors[0]) {
    throw new Error("Embedding provider failed to return exactly one vector.");
  }

  cache.set(text, vectors[0]);
  return vectors[0];
}

async function insertIngestLog(
  db: Client,
  params: {
    filePath: string;
    contentHash?: string;
    added: number;
    updated: number;
    skipped: number;
    superseded: number;
    llmDedupCalls: number;
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
        entries_superseded,
        dedup_llm_calls,
        duration_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      randomUUID(),
      params.filePath,
      params.contentHash ?? null,
      new Date().toISOString(),
      params.added,
      params.updated,
      params.skipped,
      params.superseded,
      params.llmDedupCalls,
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
        e.importance,
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
      CROSS JOIN entries AS e ON e.rowid = v.id
      WHERE e.embedding IS NOT NULL
        AND e.superseded_by IS NULL
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
  const createdAt = normalizeCreatedAt(entry.created_at) ?? now;
  await db.execute({
    sql: `
      INSERT INTO entries (
        id,
        type,
        subject,
        content,
        importance,
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
      entry.importance,
      entry.expiry,
      entry.source.file,
      entry.source.context,
      contentHash,
      JSON.stringify(embedding),
      createdAt,
      now,
    ],
  });

  await insertTags(db, id, entry.tags);
  return id;
}

function resolveSameSubject(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

function buildFallbackAddDecision(reasoning: string): OnlineDedupDecision {
  return {
    action: "ADD",
    target_id: null,
    merged_content: null,
    reasoning,
  };
}

function validateThreshold(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("dedupThreshold must be between 0.0 and 1.0.");
  }
  return value;
}

async function planEntryAction(
  db: Client,
  entry: KnowledgeEntry,
  embedding: number[],
  contentHash: string,
  options: {
    force: boolean;
    llmDedupEnabled: boolean;
    dedupThreshold: number;
    llmClient?: LlmClient;
    onlineDedupFn?: (
      client: LlmClient,
      newEntry: KnowledgeEntry,
      candidates: Array<{ entry: StoredEntry; similarity: number }>,
    ) => Promise<OnlineDedupDecision>;
    onLlmCall?: () => void;
  },
): Promise<ProcessedEntry> {
  if (options.force) {
    return {
      decision: {
        entry,
        action: "added",
        reason: "force mode",
      },
      mutation: {
        kind: "add",
        embedding,
        contentHash,
      },
    };
  }

  const similar = await findSimilar(db, embedding, DEFAULT_SIMILAR_LIMIT);
  const topMatch = similar[0];
  const similarity = topMatch?.similarity ?? 0;
  const sameSubject = topMatch ? resolveSameSubject(entry.subject, topMatch.entry.subject) : false;
  const sameType = topMatch ? entry.type === topMatch.entry.type : false;

  if (topMatch && similarity >= AUTO_SKIP_THRESHOLD && sameType) {
    return {
      decision: {
        entry,
        action: "skipped",
        reason: "near-exact semantic duplicate",
        similarity,
        matchedEntryId: topMatch.entry.id,
        matchedEntry: topMatch.entry,
        sameSubject,
      },
      mutation: { kind: "none" },
    };
  }

  if (topMatch && similarity >= SMART_DEDUP_THRESHOLD && sameSubject && sameType) {
    return {
      decision: {
        entry,
        action: "updated",
        reason: "reinforced existing entry (same subject+type)",
        similarity,
        matchedEntryId: topMatch.entry.id,
        matchedEntry: topMatch.entry,
        sameSubject,
      },
      mutation: {
        kind: "reinforce",
        contentHash,
        matchedEntry: topMatch.entry,
        similarity,
      },
    };
  }

  if (topMatch && similarity >= SMART_DEDUP_THRESHOLD && similarity < AUTO_SKIP_THRESHOLD && sameSubject && !sameType) {
    return {
      decision: {
        entry,
        action: "added",
        reason: "added related entry (same subject+high similarity across types)",
        similarity,
        matchedEntryId: topMatch.entry.id,
        matchedEntry: topMatch.entry,
        sameSubject,
      },
      mutation: {
        kind: "add_related",
        embedding,
        contentHash,
        matchedEntry: topMatch.entry,
        similarity,
      },
    };
  }

  if (!options.llmDedupEnabled) {
    return {
      decision: {
        entry,
        action: "added",
        reason: "new entry",
        similarity,
        matchedEntryId: topMatch?.entry.id,
        matchedEntry: topMatch?.entry,
        sameSubject,
      },
      mutation: {
        kind: "add",
        embedding,
        contentHash,
        matchedEntry: topMatch?.entry,
        similarity,
      },
    };
  }

  const dedupCandidates = similar.filter((candidate) => candidate.similarity >= options.dedupThreshold);
  if (dedupCandidates.length === 0) {
    return {
      decision: {
        entry,
        action: "added",
        reason: "no similar entries above online dedup threshold",
        similarity,
        matchedEntryId: topMatch?.entry.id,
        matchedEntry: topMatch?.entry,
        sameSubject,
      },
      mutation: {
        kind: "add",
        embedding,
        contentHash,
        matchedEntry: topMatch?.entry,
        similarity,
      },
    };
  }

  const decisionFn = options.onlineDedupFn ?? classifyOnlineDedup;
  options.onLlmCall?.();
  let llmDecision = await decisionFn(options.llmClient as LlmClient, entry, dedupCandidates);

  if (!isOnlineDedupAction(llmDecision.action)) {
    llmDecision = buildFallbackAddDecision("Invalid LLM action; defaulting to ADD.");
  }

  const candidatesById = new Map(dedupCandidates.map((candidate) => [candidate.entry.id, candidate]));
  const fallbackTop = dedupCandidates[0];

  if (llmDecision.action === "ADD") {
    return {
      decision: {
        entry,
        action: "added",
        reason: "online dedup decided ADD",
        similarity: fallbackTop?.similarity,
        matchedEntryId: undefined,
        matchedEntry: undefined,
        llm_action: llmDecision.action,
        llm_reasoning: llmDecision.reasoning,
      },
      mutation: {
        kind: "add",
        embedding,
        contentHash,
        llmDecision,
      },
    };
  }

  const candidate = llmDecision.target_id ? candidatesById.get(llmDecision.target_id) : undefined;
  if (!candidate) {
    const fallback = buildFallbackAddDecision("LLM target_id missing/invalid; defaulting to ADD.");
    return {
      decision: {
        entry,
        action: "added",
        reason: fallback.reasoning,
        similarity: fallbackTop?.similarity,
        llm_action: fallback.action,
        llm_reasoning: fallback.reasoning,
      },
      mutation: {
        kind: "add",
        embedding,
        contentHash,
        llmDecision: fallback,
      },
    };
  }

  if (llmDecision.action === "UPDATE") {
    if (!llmDecision.merged_content) {
      const fallback = buildFallbackAddDecision("LLM UPDATE missing merged_content; defaulting to ADD.");
      return {
        decision: {
          entry,
          action: "added",
          reason: fallback.reasoning,
          similarity: candidate.similarity,
          matchedEntryId: candidate.entry.id,
          matchedEntry: candidate.entry,
          sameSubject: resolveSameSubject(entry.subject, candidate.entry.subject),
          llm_action: fallback.action,
          llm_reasoning: fallback.reasoning,
        },
        mutation: {
          kind: "add",
          embedding,
          contentHash,
          llmDecision: fallback,
        },
      };
    }

    return {
      decision: {
        entry,
        action: "updated",
        reason: "online dedup decided UPDATE",
        similarity: candidate.similarity,
        matchedEntryId: candidate.entry.id,
        matchedEntry: candidate.entry,
        sameSubject: resolveSameSubject(entry.subject, candidate.entry.subject),
        llm_action: llmDecision.action,
        llm_reasoning: llmDecision.reasoning,
      },
      mutation: {
        kind: "update",
        matchedEntry: candidate.entry,
        similarity: candidate.similarity,
        mergedContent: llmDecision.merged_content,
        llmDecision,
      },
    };
  }

  if (llmDecision.action === "SKIP") {
    return {
      decision: {
        entry,
        action: "skipped",
        reason: "online dedup decided SKIP",
        similarity: candidate.similarity,
        matchedEntryId: candidate.entry.id,
        matchedEntry: candidate.entry,
        sameSubject: resolveSameSubject(entry.subject, candidate.entry.subject),
        llm_action: llmDecision.action,
        llm_reasoning: llmDecision.reasoning,
      },
      mutation: {
        kind: "skip",
        matchedEntry: candidate.entry,
        similarity: candidate.similarity,
        contentHash,
        llmDecision,
      },
    };
  }

  return {
    decision: {
      entry,
      action: "superseded",
      reason: "online dedup decided SUPERSEDE",
      similarity: candidate.similarity,
      matchedEntryId: candidate.entry.id,
      matchedEntry: candidate.entry,
      sameSubject: resolveSameSubject(entry.subject, candidate.entry.subject),
      llm_action: llmDecision.action,
      llm_reasoning: llmDecision.reasoning,
    },
    mutation: {
      kind: "supersede",
      matchedEntry: candidate.entry,
      similarity: candidate.similarity,
      embedding,
      contentHash,
      llmDecision,
    },
  };
}

async function applyEntryMutation(
  db: Client,
  processed: ProcessedEntry,
  embedFn: (texts: string[], key: string) => Promise<number[][]>,
  apiKey: string,
  cache: EmbeddingCache,
): Promise<StoreEntryDecision> {
  const mutation = processed.mutation;
  const decision = processed.decision;

  if (mutation.kind === "none") {
    return decision;
  }

  if (mutation.kind === "add") {
    const embedding = mutation.embedding;
    const contentHash = mutation.contentHash;
    if (!embedding || !contentHash) {
      throw new Error("Invalid add mutation state.");
    }

    const newEntryId = await insertEntry(db, decision.entry, embedding, contentHash);
    return {
      ...decision,
      newEntryId,
    };
  }

  if (mutation.kind === "add_related") {
    const embedding = mutation.embedding;
    const contentHash = mutation.contentHash;
    const matchedEntry = mutation.matchedEntry;
    if (!embedding || !contentHash || !matchedEntry) {
      throw new Error("Invalid add_related mutation state.");
    }

    const newEntryId = await insertEntry(db, decision.entry, embedding, contentHash);
    await createRelation(db, newEntryId, matchedEntry.id, "related");
    return {
      ...decision,
      newEntryId,
      relation_type: "related",
    };
  }

  if (mutation.kind === "reinforce") {
    if (!mutation.matchedEntry) {
      throw new Error("Invalid reinforce mutation state.");
    }
    await incrementConfirmations(db, mutation.matchedEntry.id, mutation.contentHash);
    return decision;
  }

  if (mutation.kind === "skip") {
    if (!mutation.matchedEntry) {
      throw new Error("Invalid skip mutation state.");
    }
    await incrementConfirmations(db, mutation.matchedEntry.id, mutation.contentHash);
    return decision;
  }

  if (mutation.kind === "update") {
    if (!mutation.matchedEntry || !mutation.mergedContent) {
      throw new Error("Invalid update mutation state.");
    }

    const currentTarget = await getStoredEntryById(db, mutation.matchedEntry.id);
    if (!currentTarget) {
      const fallbackEmbedding = await resolveEmbeddingForText(
        composeEmbeddingText(decision.entry),
        apiKey,
        embedFn,
        cache,
      );
      const fallbackHash = hashEntrySourceContent(decision.entry);
      const newEntryId = await insertEntry(db, decision.entry, fallbackEmbedding, fallbackHash);
      return {
        ...decision,
        action: "added",
        reason: "online dedup UPDATE target missing; inserted new entry",
        newEntryId,
      };
    }

    const mergedEntry: KnowledgeEntry = {
      type: currentTarget.type,
      subject: currentTarget.subject,
      content: mutation.mergedContent,
      importance: currentTarget.importance,
      expiry: currentTarget.expiry,
      tags: currentTarget.tags,
      source: currentTarget.source,
    };
    const mergedText = composeEmbeddingText(mergedEntry);
    const mergedEmbedding = await resolveEmbeddingForText(mergedText, apiKey, embedFn, cache);
    const mergedHash = hashEntrySourceContent(mergedEntry);

    await updateEntryForMerge(db, currentTarget.id, mutation.mergedContent, mergedEmbedding, mergedHash);
    return decision;
  }

  if (!mutation.matchedEntry || !mutation.embedding || !mutation.contentHash) {
    throw new Error("Invalid supersede mutation state.");
  }

  const currentTarget = await getStoredEntryById(db, mutation.matchedEntry.id);
  if (!currentTarget) {
    const newEntryId = await insertEntry(db, decision.entry, mutation.embedding, mutation.contentHash);
    return {
      ...decision,
      action: "added",
      reason: "online dedup SUPERSEDE target missing; inserted new entry",
      newEntryId,
    };
  }

  const newEntryId = await insertEntry(db, decision.entry, mutation.embedding, mutation.contentHash);
  await markSuperseded(db, currentTarget.id, newEntryId);
  await createRelation(db, newEntryId, currentTarget.id, "supersedes");

  return {
    ...decision,
    newEntryId,
    relation_type: "supersedes",
  };
}

async function runPerEntryTransaction(
  db: Client,
  dryRun: boolean,
  fn: () => Promise<void>,
): Promise<void> {
  await db.execute("BEGIN IMMEDIATE");
  try {
    await fn();
    if (dryRun) {
      await db.execute("ROLLBACK");
      return;
    }
    await db.execute("COMMIT");
  } catch (error) {
    try {
      await db.execute("ROLLBACK");
    } catch {
      // Ignore rollback failures.
    }
    throw error;
  }
}

export async function storeEntries(
  db: Client,
  entries: KnowledgeEntry[],
  apiKey: string,
  options: StoreEntriesOptions = {},
): Promise<StoreResult> {
  warnIfLocked();

  const dedupThreshold = validateThreshold(options.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD);
  const onlineDedup = options.onlineDedup === true && options.force !== true;
  const llmDedupEnabled = onlineDedup && options.skipLlmDedup !== true;
  if (llmDedupEnabled && entries.length > 0 && !options.llmClient) {
    throw new Error("storeEntries requires llmClient when LLM online dedup is enabled.");
  }

  const startedAt = Date.now();
  const embedFn = options.embedFn ?? embed;
  const totalBefore = await getTotalEntries(db);
  const cache = new EmbeddingCache();

  let added = 0;
  let updated = 0;
  let skipped = 0;
  let superseded = 0;
  let relationsCreated = 0;
  let llmDedupCalls = 0;

  const processOne = async (entry: KnowledgeEntry): Promise<void> => {
    const contentHash = hashEntrySourceContent(entry);

    if (!options.force && (await hasContentHash(db, contentHash))) {
      skipped += 1;
      options.onDecision?.({
        entry,
        action: "skipped",
        reason: "idempotent content hash match",
      });
      return;
    }

    const embedding = await resolveEmbeddingForText(composeEmbeddingText(entry), apiKey, embedFn, cache);
    const processed = await planEntryAction(db, entry, embedding, contentHash, {
      force: options.force === true,
      llmDedupEnabled,
      dedupThreshold,
      llmClient: options.llmClient,
      onlineDedupFn: options.onlineDedupFn,
      onLlmCall: () => {
        llmDedupCalls += 1;
      },
    });

    const applyAndCount = async (): Promise<StoreEntryDecision> => {
      const applied = await applyEntryMutation(db, processed, embedFn, apiKey, cache);

      if (applied.action === "added") {
        added += 1;
      } else if (applied.action === "updated") {
        updated += 1;
      } else if (applied.action === "skipped") {
        skipped += 1;
      } else if (applied.action === "superseded") {
        superseded += 1;
      }

      if (applied.relation_type) {
        relationsCreated += 1;
      }

      return applied;
    };

    const decision =
      onlineDedup
        ? await (async () => {
            let appliedDecision: StoreEntryDecision | undefined;
            await runPerEntryTransaction(db, options.dryRun === true, async () => {
              appliedDecision = await applyAndCount();
            });
            if (!appliedDecision) {
              throw new Error("Failed to apply per-entry transaction decision.");
            }
            return appliedDecision;
          })()
        : await applyAndCount();

    options.onDecision?.(decision);
  };

  if (!onlineDedup) {
    await db.execute("BEGIN");
    try {
      for (const entry of entries) {
        await processOne(entry);
      }

      const durationMs = Date.now() - startedAt;
      if (options.dryRun) {
        await db.execute("ROLLBACK");
        return {
          added,
          updated,
          skipped,
          superseded,
          llm_dedup_calls: llmDedupCalls,
          relations_created: relationsCreated,
          total_entries: totalBefore + added + superseded,
          duration_ms: durationMs,
        };
      }

      if (!options.skipIngestLog) {
        await insertIngestLog(db, {
          filePath: options.sourceFile ?? entries[0]?.source.file ?? "<unknown>",
          contentHash: options.ingestContentHash,
          added,
          updated,
          skipped,
          superseded,
          llmDedupCalls,
          durationMs,
        });
      }

      await db.execute("COMMIT");

      return {
        added,
        updated,
        skipped,
        superseded,
        llm_dedup_calls: llmDedupCalls,
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

  for (const entry of entries) {
    await processOne(entry);
  }

  const durationMs = Date.now() - startedAt;
  if (!options.dryRun && !options.skipIngestLog) {
    await insertIngestLog(db, {
      filePath: options.sourceFile ?? entries[0]?.source.file ?? "<unknown>",
      contentHash: options.ingestContentHash,
      added,
      updated,
      skipped,
      superseded,
      llmDedupCalls,
      durationMs,
    });
  }

  return {
    added,
    updated,
    skipped,
    superseded,
    llm_dedup_calls: llmDedupCalls,
    relations_created: relationsCreated,
    total_entries: options.dryRun ? totalBefore + added + superseded : await getTotalEntries(db),
    duration_ms: durationMs,
  };
}
