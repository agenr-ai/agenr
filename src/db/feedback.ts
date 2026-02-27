import type { Client, InValue } from "@libsql/client";
import { embed, resolveEmbeddingApiKey } from "../embeddings/client.js";
import type { AgenrConfig } from "../types.js";
import type { PluginLogger } from "../openclaw-plugin/types.js";
import { toStringValue } from "../utils/entry-utils.js";

const RESPONSE_MIN_CHARS = 50;
const RESPONSE_MAX_CHARS = 8000;
const SIGNAL_USED = 1.0;
const SIGNAL_UNCLEAR = 0.4;
const SIGNAL_CORRECTED = 0.0;
const RESPONSE_USED_THRESHOLD = 0.5;
const CORRECTION_THRESHOLD = 0.6;

interface QualityUpdate {
  id: string;
  signal: number;
}

interface EmbeddedEntry {
  id: string;
  embedding: number[];
}

export interface RecallFeedbackResult {
  usedIds: string[];
  correctedIds: string[];
  updatedIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
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

function extractTextFromContent(content: unknown, separator: string): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text") {
      continue;
    }
    const text = block.text;
    if (typeof text !== "string") {
      continue;
    }
    const trimmed = text.trim();
    if (trimmed) {
      parts.push(trimmed);
    }
  }
  return parts.join(separator).trim();
}

function collectAssistantText(messages: unknown[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }
    const text = extractTextFromContent(message.content, "\n");
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

function extractStoreContentsFromInput(input: unknown): string[] {
  if (!isRecord(input)) {
    return [];
  }

  const out: string[] = [];
  const directContent = input.content;
  if (typeof directContent === "string" && directContent.trim()) {
    out.push(directContent.trim());
  }

  const entries = input.entries;
  if (Array.isArray(entries)) {
    for (const item of entries) {
      if (!isRecord(item)) {
        continue;
      }
      const content = item.content;
      if (typeof content === "string" && content.trim()) {
        out.push(content.trim());
      }
    }
  }

  return out;
}

function parseFunctionArguments(rawArgs: unknown): Record<string, unknown> | null {
  if (isRecord(rawArgs)) {
    return rawArgs;
  }
  if (typeof rawArgs !== "string" || !rawArgs.trim()) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(rawArgs);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function collectAgenrStoreContents(messages: unknown[]): string[] {
  const contents: string[] = [];

  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }

    const contentBlocks = message.content;
    if (Array.isArray(contentBlocks)) {
      for (const block of contentBlocks) {
        if (!isRecord(block) || block.type !== "tool_use" || block.name !== "agenr_store") {
          continue;
        }
        contents.push(...extractStoreContentsFromInput(block.input));
      }
    }

    const toolCalls = message.tool_calls;
    if (!Array.isArray(toolCalls)) {
      continue;
    }
    for (const toolCall of toolCalls) {
      if (!isRecord(toolCall)) {
        continue;
      }

      if (typeof toolCall.name === "string" && toolCall.name === "agenr_store") {
        const namedArgs = parseFunctionArguments(toolCall.arguments);
        if (namedArgs) {
          contents.push(...extractStoreContentsFromInput(namedArgs));
        } else {
          contents.push(...extractStoreContentsFromInput(toolCall.input));
        }
        continue;
      }

      const fn = toolCall.function;
      if (!isRecord(fn) || fn.name !== "agenr_store") {
        continue;
      }
      const args = parseFunctionArguments(fn.arguments);
      if (args) {
        contents.push(...extractStoreContentsFromInput(args));
      }
    }
  }

  return Array.from(new Set(contents));
}

async function fetchEmbeddedEntries(db: Client, ids: Set<string>): Promise<EmbeddedEntry[]> {
  const idList = Array.from(ids).filter((id) => id.trim().length > 0);
  if (idList.length === 0) {
    return [];
  }

  const placeholders = idList.map(() => "?").join(", ");
  const result = await db.execute({
    sql: `
      SELECT id, embedding
      FROM entries
      WHERE id IN (${placeholders})
        AND embedding IS NOT NULL
    `,
    args: idList,
  });

  const embeddedEntries: EmbeddedEntry[] = [];
  for (const row of result.rows) {
    const id = toStringValue(row.id);
    const embedding = mapBufferToVector(row.embedding);
    if (!id || embedding.length === 0) {
      continue;
    }
    embeddedEntries.push({ id, embedding });
  }
  return embeddedEntries;
}

export async function updateQualityScores(
  db: Client,
  updates: Array<{ id: string; signal: number }>,
): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  const normalizedUpdates = new Map<string, number>();
  for (const update of updates) {
    const id = update.id.trim();
    if (!id) {
      continue;
    }
    normalizedUpdates.set(id, clamp01(update.signal));
  }
  if (normalizedUpdates.size === 0) {
    return;
  }

  const sql = `
    UPDATE entries
    SET quality_score = MIN(
      1.0,
      MAX(
        0.8 * COALESCE(quality_score, 0.5) + 0.2 * ?,
        CASE WHEN type IN ('fact', 'preference') THEN 0.35 ELSE 0.1 END
      )
    )
    WHERE id = ?
  `;

  await db.execute("BEGIN");
  try {
    for (const [id, signal] of normalizedUpdates.entries()) {
      await db.execute({ sql, args: [signal, id] });
    }
    await db.execute("COMMIT");
  } catch (error) {
    try {
      await db.execute("ROLLBACK");
    } catch {
      // Ignore rollback failures to preserve original error.
    }
    throw error;
  }
}

export async function computeRecallFeedback(
  db: Client,
  sessionKey: string,
  messages: unknown[],
  recalledEntryIds: Set<string>,
  config: AgenrConfig,
  logger: PluginLogger,
): Promise<RecallFeedbackResult> {
  const emptyResult: RecallFeedbackResult = {
    usedIds: [],
    correctedIds: [],
    updatedIds: [],
  };

  if (recalledEntryIds.size === 0) {
    return emptyResult;
  }

  const assistantText = collectAssistantText(messages);
  if (assistantText.length < RESPONSE_MIN_CHARS) {
    return emptyResult;
  }

  const responseCorpus = assistantText.slice(0, RESPONSE_MAX_CHARS);

  let apiKey: string;
  try {
    apiKey = resolveEmbeddingApiKey(config, process.env);
  } catch (error) {
    logger.warn(
      `[agenr] before_reset: feedback skipped for session=${sessionKey} - ${error instanceof Error ? error.message : String(error)}`,
    );
    return emptyResult;
  }

  let responseEmbedding: number[] | null = null;
  try {
    const vectors = await embed([responseCorpus], apiKey);
    responseEmbedding = vectors[0] ?? null;
  } catch (error) {
    logger.warn(
      `[agenr] before_reset: feedback embedding failed for session=${sessionKey}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return emptyResult;
  }

  if (!responseEmbedding || responseEmbedding.length === 0) {
    return emptyResult;
  }

  const recalledEntries = await fetchEmbeddedEntries(db, recalledEntryIds);
  if (recalledEntries.length === 0) {
    return emptyResult;
  }

  const storeContents = collectAgenrStoreContents(messages);
  let correctionEmbeddings: number[][] = [];
  if (storeContents.length > 0) {
    try {
      correctionEmbeddings = await embed(storeContents, apiKey);
    } catch (error) {
      logger.warn(
        `[agenr] before_reset: correction embedding failed for session=${sessionKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
      correctionEmbeddings = [];
    }
  }

  const correctedIds = new Set<string>();
  if (correctionEmbeddings.length > 0) {
    for (const entry of recalledEntries) {
      for (const correctionEmbedding of correctionEmbeddings) {
        if (cosineSimilarity(entry.embedding, correctionEmbedding) >= CORRECTION_THRESHOLD) {
          correctedIds.add(entry.id);
          break;
        }
      }
    }
  }

  const updates: QualityUpdate[] = recalledEntries.map((entry) => {
    if (correctedIds.has(entry.id)) {
      return { id: entry.id, signal: SIGNAL_CORRECTED };
    }
    const sim = cosineSimilarity(entry.embedding, responseEmbedding ?? []);
    return {
      id: entry.id,
      signal: sim >= RESPONSE_USED_THRESHOLD ? SIGNAL_USED : SIGNAL_UNCLEAR,
    };
  });

  if (updates.length > 0) {
    await updateQualityScores(db, updates);
  }

  return {
    usedIds: updates.filter((update) => update.signal === SIGNAL_USED).map((update) => update.id),
    correctedIds: Array.from(correctedIds),
    updatedIds: updates.map((update) => update.id),
  };
}

export const __testing = {
  collectAgenrStoreContents,
  cosineSimilarity,
};
