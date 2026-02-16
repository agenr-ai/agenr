import type { Context, Tool } from "@mariozechner/pi-ai";
import type { Client } from "@libsql/client";
import { Type, type Static } from "@sinclair/typebox";
import { createRelation } from "../db/relations.js";
import { hashEntrySourceContent, insertEntry } from "../db/store.js";
import { composeEmbeddingText, embed } from "../embeddings/client.js";
import { runSimpleStream } from "../llm/stream.js";
import { KNOWLEDGE_TYPES, type Expiry, type KnowledgeEntry, type KnowledgeType, type LlmClient } from "../types.js";
import type { Cluster } from "./cluster.js";
import { addToReviewQueue, verifyMerge } from "./verify.js";

const KNOWLEDGE_TYPE_SET = new Set<string>(KNOWLEDGE_TYPES);
const EXPIRY_SET = new Set<Expiry>(["core", "permanent", "temporary"]);

const MAX_TOTAL_TOKENS = 4096;
const RESERVED_OVERHEAD_TOKENS = 1024;
const PAYLOAD_TOKEN_BUDGET = MAX_TOTAL_TOKENS - RESERVED_OVERHEAD_TOKENS;
const PAYLOAD_CHAR_BUDGET = PAYLOAD_TOKEN_BUDGET * 4;

const MERGE_RESULT_SCHEMA = Type.Object({
  content: Type.String(),
  subject: Type.String(),
  type: Type.Union(KNOWLEDGE_TYPES.map((value) => Type.Literal(value))),
  importance: Type.Integer({ minimum: 1, maximum: 10 }),
  expiry: Type.Union([
    Type.Literal("core"),
    Type.Literal("permanent"),
    Type.Literal("temporary"),
  ]),
  tags: Type.Array(Type.String()),
  notes: Type.String(),
});

type MergeToolArgs = Static<typeof MERGE_RESULT_SCHEMA>;

const MERGE_TOOL: Tool<typeof MERGE_RESULT_SCHEMA> = {
  name: "merge_entries",
  description: "Produce one canonical merged entry from a cluster.",
  parameters: MERGE_RESULT_SCHEMA,
};

export interface MergeResult {
  content: string;
  subject: string;
  type: KnowledgeType;
  importance: number;
  expiry: Expiry;
  tags: string[];
  notes: string;
}

export interface MergeOutcome {
  mergedEntryId: string;
  sourceIds: string[];
  flagged: boolean;
  flagReason?: string;
}

function normalizeTags(tags: string[]): string[] {
  return Array.from(
    new Set(
      tags
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0),
    ),
  );
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function truncateContent(value: string, maxChars?: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!maxChars || normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(0, maxChars);
}

function formatClusterEntries(cluster: Cluster, contentLimit?: number): string {
  const sortedEntries = [...cluster.entries].sort((a, b) => {
    const createdA = Date.parse(a.createdAt);
    const createdB = Date.parse(b.createdAt);
    const safeA = Number.isFinite(createdA) ? createdA : Number.POSITIVE_INFINITY;
    const safeB = Number.isFinite(createdB) ? createdB : Number.POSITIVE_INFINITY;
    if (safeA !== safeB) {
      return safeA - safeB;
    }
    return a.id.localeCompare(b.id);
  });

  return sortedEntries
    .map((entry, index) => {
      const content = truncateContent(entry.content, contentLimit);
      return [
        `Entry ${index + 1}:`,
        `- id: ${entry.id}`,
        `- type: ${entry.type}`,
        `- subject: ${entry.subject}`,
        `- importance: ${entry.importance ?? 5}`,
        `- confirmations: ${entry.confirmations}`,
        `- created_at: ${entry.createdAt}`,
        `- content: ${content}`,
      ].join("\n");
    })
    .join("\n\n");
}

function buildMergeContext(cluster: Cluster): Context {
  const systemPrompt = [
    "You are a knowledge consolidation engine.",
    "Merge the provided related entries into one canonical entry.",
    "Only include information explicitly stated in the source entries. Do not infer or add details not present.",
    "Prefer preserving temporal changes in the merged narrative.",
    "Call merge_entries with your final merged result.",
  ].join("\n");

  let contentLimit: number | undefined;
  let payload = formatClusterEntries(cluster, contentLimit);

  if (estimateTokens(payload.length) > PAYLOAD_TOKEN_BUDGET) {
    contentLimit = 800;
    payload = formatClusterEntries(cluster, contentLimit);
  }

  if (estimateTokens(payload.length) > PAYLOAD_TOKEN_BUDGET) {
    contentLimit = 400;
    payload = formatClusterEntries(cluster, contentLimit);
  }

  if (estimateTokens(payload.length) > PAYLOAD_TOKEN_BUDGET) {
    payload = payload.slice(0, PAYLOAD_CHAR_BUDGET);
  }

  const userPrompt = [
    `Merge the following ${cluster.entries.length} entries into a single canonical entry.`,
    "",
    payload,
    "",
    "Return your answer by calling merge_entries.",
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
    tools: [MERGE_TOOL],
  };
}

export function extractMergeResultFromToolCall(
  message: {
    content: Array<{ type: string; name?: string; arguments?: unknown }>;
  },
  options: {
    verbose?: boolean;
    onLog?: (message: string) => void;
  } = {},
): MergeResult | null {
  const verbose = options.verbose ?? false;
  const onLog = options.onLog ?? (() => undefined);

  for (const block of message.content) {
    if (block.type !== "toolCall" || block.name !== "merge_entries") {
      continue;
    }

    const args = block.arguments as Partial<MergeToolArgs> | undefined;
    if (!args) {
      return null;
    }

    const content = typeof args.content === "string" ? args.content.trim() : "";
    const subject = typeof args.subject === "string" ? args.subject.trim() : "";
    const type =
      typeof args.type === "string" && KNOWLEDGE_TYPE_SET.has(args.type)
        ? (args.type as KnowledgeType)
        : "fact";
    if (verbose && typeof args.type === "string" && args.type.trim() && !KNOWLEDGE_TYPE_SET.has(args.type)) {
      onLog(`[merge] LLM returned invalid type "${args.type}", falling back to "fact"`);
    }

    const importanceRaw = typeof args.importance === "number" ? args.importance : Number(args.importance);
    const importance =
      Number.isInteger(importanceRaw) && importanceRaw >= 1 && importanceRaw <= 10 ? importanceRaw : 5;
    if (verbose && Number.isFinite(importanceRaw) && importanceRaw !== importance) {
      onLog(`[merge] LLM returned out-of-range importance "${String(args.importance)}", falling back to 5`);
    }

    const expiry =
      typeof args.expiry === "string" && EXPIRY_SET.has(args.expiry as Expiry) ? (args.expiry as Expiry) : "permanent";
    if (verbose && typeof args.expiry === "string" && args.expiry.trim() && !EXPIRY_SET.has(args.expiry as Expiry)) {
      onLog(`[merge] LLM returned invalid expiry "${args.expiry}", falling back to "permanent"`);
    }

    const tags = Array.isArray(args.tags)
      ? normalizeTags(args.tags.filter((item): item is string => typeof item === "string"))
      : [];
    const notes = typeof args.notes === "string" ? args.notes : "";

    if (!content || !subject) {
      return null;
    }

    return {
      content,
      subject,
      type,
      importance,
      expiry,
      tags,
      notes,
    };
  }

  return null;
}

function chooseDominantType(cluster: Cluster): KnowledgeType {
  const scores = new Map<KnowledgeType, { count: number; support: number }>();

  for (const entry of cluster.entries) {
    if (!KNOWLEDGE_TYPE_SET.has(entry.type)) {
      continue;
    }
    const key = entry.type as KnowledgeType;
    const current = scores.get(key) ?? { count: 0, support: 0 };
    current.count += 1;
    current.support += entry.confirmations;
    scores.set(key, current);
  }

  const sorted = Array.from(scores.entries()).sort((a, b) => {
    if (b[1].count !== a[1].count) {
      return b[1].count - a[1].count;
    }
    return b[1].support - a[1].support;
  });

  return sorted[0]?.[0] ?? "fact";
}

export async function mergeCluster(
  db: Client,
  cluster: Cluster,
  llmClient: LlmClient,
  apiKey: string,
  options: {
    dryRun?: boolean;
    verbose?: boolean;
    onLog?: (message: string) => void;
  } = {},
): Promise<MergeOutcome> {
  const sourceIds = cluster.entries.map((entry) => entry.id);
  const onLog = options.onLog ?? (() => undefined);

  if (cluster.entries.length < 2) {
    return {
      mergedEntryId: "",
      sourceIds,
      flagged: true,
      flagReason: "cluster too small",
    };
  }

  let mergeResult: MergeResult | null = null;
  try {
    const response = await runSimpleStream({
      model: llmClient.resolvedModel.model,
      context: buildMergeContext(cluster),
      options: {
        apiKey: llmClient.credentials.apiKey,
      },
      verbose: false,
    });

    if (response.stopReason !== "error" && !response.errorMessage) {
      mergeResult = extractMergeResultFromToolCall(response, { verbose: options.verbose, onLog });
    }
  } catch {
    mergeResult = null;
  }

  if (!mergeResult) {
    return {
      mergedEntryId: "",
      sourceIds,
      flagged: true,
      flagReason: "merge tool call missing or invalid",
    };
  }

  const dominantType = chooseDominantType(cluster);
  if (mergeResult.type !== dominantType) {
    mergeResult.type = dominantType;
  }

  const mergedEntry: KnowledgeEntry = {
    type: mergeResult.type,
    subject: mergeResult.subject,
    content: mergeResult.content,
    importance: mergeResult.importance,
    expiry: mergeResult.expiry,
    tags: mergeResult.tags,
    source: {
      file: "agenr",
      context: "consolidate-merge",
    },
  };

  const [mergedEmbedding] = await embed([composeEmbeddingText(mergedEntry)], apiKey);
  const sourceEmbeddings = cluster.entries.map((entry) => entry.embedding);
  const verifyResult = await verifyMerge(mergeResult.content, mergedEmbedding, sourceEmbeddings);

  if (verifyResult.status === "flag") {
    const reason = verifyResult.reason ?? "verification failed";

    if (!options.dryRun) {
      await addToReviewQueue({
        mergedContent: mergeResult.content,
        mergedSubject: mergeResult.subject,
        mergedType: mergeResult.type,
        sourceIds,
        sourceContents: cluster.entries.map((entry) => entry.content),
        flagReason: reason,
        flaggedAt: new Date().toISOString(),
      });
    }

    return {
      mergedEntryId: "",
      sourceIds,
      flagged: true,
      flagReason: reason,
    };
  }

  if (options.dryRun) {
    return {
      mergedEntryId: "DRY_RUN",
      sourceIds,
      flagged: false,
    };
  }

  const totalConfirmations = cluster.entries.reduce((sum, entry) => sum + entry.confirmations, 0);
  const totalRecallCount = cluster.entries.reduce((sum, entry) => sum + entry.recallCount, 0);

  await db.execute("BEGIN IMMEDIATE");
  try {
    const mergedEntryId = await insertEntry(db, mergedEntry, mergedEmbedding, hashEntrySourceContent(mergedEntry));

    await db.execute({
      sql: `
        UPDATE entries
        SET merged_from = ?,
            consolidated_at = datetime('now'),
            confirmations = ?,
            recall_count = ?
        WHERE id = ?
      `,
      args: [cluster.entries.length, totalConfirmations, totalRecallCount, mergedEntryId],
    });

    for (const source of cluster.entries) {
      await db.execute({
        sql: `
          INSERT INTO entry_sources (
            merged_entry_id,
            source_entry_id,
            original_confirmations,
            original_recall_count,
            original_created_at
          )
          VALUES (?, ?, ?, ?, ?)
        `,
        args: [mergedEntryId, source.id, source.confirmations, source.recallCount, source.createdAt],
      });

      await db.execute({
        sql: "UPDATE entries SET superseded_by = ? WHERE id = ?",
        args: [mergedEntryId, source.id],
      });

      await createRelation(db, mergedEntryId, source.id, "supersedes");
    }

    await db.execute("COMMIT");

    if (options.verbose) {
      onLog(`[merge] merged=${mergedEntryId} sources=${sourceIds.join(",")}`);
    }

    return {
      mergedEntryId,
      sourceIds,
      flagged: false,
    };
  } catch (error) {
    try {
      await db.execute("ROLLBACK");
    } catch {
      // Ignore rollback errors; rethrow root cause.
    }
    throw error;
  }
}
