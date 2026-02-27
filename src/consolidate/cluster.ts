import type { Context, Tool } from "@mariozechner/pi-ai";
import type { Client, InValue } from "@libsql/client";
import { Type, type Static } from "@sinclair/typebox";
import { findSimilar } from "../db/store.js";
import { runSimpleStream } from "../llm/stream.js";
import { UnionFind, cosineSim, type ActiveEmbeddedEntry, validateCluster } from "./util.js";
import type { KnowledgePlatform, LlmClient } from "../types.js";

const DEFAULT_SIMILARITY_THRESHOLD = 0.82;
const DEFAULT_LOOSE_SIMILARITY_THRESHOLD = 0.65;
const CROSS_TYPE_SUBJECT_THRESHOLD = 0.89;
const DEFAULT_MIN_CLUSTER = 2;
const DEFAULT_MAX_CLUSTER_SIZE = 12;
const DEFAULT_IDEMPOTENCY_DAYS = 7;
const DEFAULT_NEIGHBOR_LIMIT = 20;
const MAX_ACTIVE_EMBEDDED_ENTRIES = 20_000;
const MILLISECONDS_PER_DAY = 1000 * 60 * 60 * 24;
const LLM_DEDUP_TOOL_NAME = "dedup_check";

const LLM_DEDUP_TOOL_SCHEMA = Type.Object({
  same: Type.Boolean(),
  reason: Type.String(),
});

type LlmDedupToolArgs = Static<typeof LLM_DEDUP_TOOL_SCHEMA>;

const LLM_DEDUP_TOOL: Tool<typeof LLM_DEDUP_TOOL_SCHEMA> = {
  name: LLM_DEDUP_TOOL_NAME,
  description: "Decide whether two knowledge entries express the same knowledge.",
  parameters: LLM_DEDUP_TOOL_SCHEMA,
};

export interface ClusterOptions {
  simThreshold?: number;
  looseThreshold?: number;
  minCluster?: number;
  maxClusterSize?: number;
  typeFilter?: string;
  idempotencyDays?: number;
  neighborLimit?: number;
  platform?: KnowledgePlatform;
  project?: string | null;
  llmClient?: LlmClient;
  verbose?: boolean;
  onLog?: (message: string) => void;
  onStats?: (stats: ClusterBuildStats) => void;
}

export interface Cluster {
  entries: ActiveEmbeddedEntry[];
}

export interface ClusterBuildStats {
  llmDedupCalls: number;
  llmDedupMatches: number;
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

function normalizeSubject(value: string): string {
  return value.trim().toLowerCase();
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function buildLlmDedupContext(entryA: ActiveEmbeddedEntry, entryB: ActiveEmbeddedEntry): Context {
  const systemPrompt = [
    "You are a deduplication assistant for knowledge entries.",
    "Decide if two entries express the same knowledge in different wording.",
    "Return your answer by calling dedup_check.",
  ].join("\n");

  const userPrompt = [
    "Are these two knowledge entries expressing the same fact or genuinely distinct?",
    `Entry A: ${entryA.content}`,
    `Entry B: ${entryB.content}`,
    'Set "same" to true only when both entries represent the same knowledge.',
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
    tools: [LLM_DEDUP_TOOL],
  };
}

function extractLlmDedupFromToolCall(
  message: { content: Array<{ type: string; name?: string; arguments?: unknown }> },
): { same: boolean; reason: string } | null {
  for (const block of message.content) {
    if (block.type !== "toolCall" || block.name !== LLM_DEDUP_TOOL_NAME) {
      continue;
    }

    const args = block.arguments as Partial<LlmDedupToolArgs> | undefined;
    if (!args || typeof args.same !== "boolean") {
      continue;
    }

    return {
      same: args.same,
      reason: typeof args.reason === "string" ? args.reason : "",
    };
  }

  return null;
}

export async function llmDedupCheck(
  llmClient: LlmClient,
  entryA: ActiveEmbeddedEntry,
  entryB: ActiveEmbeddedEntry,
): Promise<boolean> {
  try {
    const response = await runSimpleStream({
      model: llmClient.resolvedModel.model,
      context: buildLlmDedupContext(entryA, entryB),
      options: {
        apiKey: llmClient.credentials.apiKey,
      },
      verbose: false,
    });

    if (response.stopReason === "error" || response.errorMessage) {
      return false;
    }

    const parsed = extractLlmDedupFromToolCall(response);
    return parsed?.same === true;
  } catch {
    return false;
  }
}

function parseDaysSince(value: string, now: Date): number {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return Number.POSITIVE_INFINITY;
  }
  return (now.getTime() - parsed.getTime()) / MILLISECONDS_PER_DAY;
}

function mapActiveEmbeddedEntry(row: Record<string, InValue | undefined>): ActiveEmbeddedEntry | null {
  const id = toStringValue(row.id);
  const embedding = mapBufferToVector(row.embedding);

  if (!id || embedding.length === 0) {
    return null;
  }

  const projectRaw = toStringValue(row.project);
  const project = projectRaw.trim().length > 0 ? projectRaw.trim().toLowerCase() : null;
  const tagsRaw = toStringValue(row.tags_csv);
  const tags = tagsRaw.length > 0 ? tagsRaw.split("|").map((tag) => tag.trim()).filter(Boolean) : [];

  return {
    id,
    type: toStringValue(row.type),
    subject: toStringValue(row.subject),
    content: toStringValue(row.content),
    tags,
    project,
    importance: Number.isFinite(toNumber(row.importance)) ? toNumber(row.importance) : 5,
    embedding,
    confirmations: Number.isFinite(toNumber(row.confirmations)) ? toNumber(row.confirmations) : 0,
    recallCount: Number.isFinite(toNumber(row.recall_count)) ? toNumber(row.recall_count) : 0,
    createdAt: toStringValue(row.created_at),
    mergedFrom: Number.isFinite(toNumber(row.merged_from)) ? toNumber(row.merged_from) : 0,
    consolidatedAt: toStringValue(row.consolidated_at) || undefined,
  };
}

function shouldSkipByIdempotency(entry: ActiveEmbeddedEntry, idempotencyDays: number, now: Date): boolean {
  if ((entry.mergedFrom ?? 0) <= 0) {
    return false;
  }
  if (!entry.consolidatedAt) {
    return false;
  }
  const ageInDays = parseDaysSince(entry.consolidatedAt, now);
  return Number.isFinite(ageInDays) && ageInDays >= 0 && ageInDays < idempotencyDays;
}

export async function buildClusters(db: Client, options: ClusterOptions = {}): Promise<Cluster[]> {
  const simThreshold = options.simThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const looseThreshold = options.looseThreshold ?? DEFAULT_LOOSE_SIMILARITY_THRESHOLD;
  const minCluster = options.minCluster ?? DEFAULT_MIN_CLUSTER;
  const maxClusterSize = options.maxClusterSize ?? DEFAULT_MAX_CLUSTER_SIZE;
  const idempotencyDays = options.idempotencyDays ?? DEFAULT_IDEMPOTENCY_DAYS;
  const neighborLimit = Math.max(2, options.neighborLimit ?? DEFAULT_NEIGHBOR_LIMIT);
  const typeFilter = options.typeFilter?.trim();
  const platform = options.platform;
  const project = options.project;
  const llmClient = options.llmClient;
  const onLog = options.onLog ?? (() => undefined);
  const onStats = options.onStats ?? (() => undefined);

  const args: unknown[] = [];
  if (platform) {
    args.push(platform);
  }
  const projectCondition = project !== undefined ? (project === null ? "AND project IS NULL" : "AND project = ?") : "";
  if (project !== undefined && project !== null) {
    args.push(project);
  }

  const result = await db.execute({
    sql: `
    SELECT
      e.id,
      e.type,
      e.subject,
      e.content,
      e.project,
      e.importance,
      e.embedding,
      e.confirmations,
      e.recall_count,
      e.created_at,
      e.merged_from,
      e.consolidated_at,
      (
        SELECT GROUP_CONCAT(t.tag, '|')
        FROM tags t
        WHERE t.entry_id = e.id
      ) AS tags_csv
    FROM entries e
    WHERE superseded_by IS NULL
      AND retired = 0
      AND embedding IS NOT NULL
      ${platform ? "AND e.platform = ?" : ""}
      ${projectCondition}
    `,
    args,
  });

  const now = new Date();
  const candidates = result.rows
    .map((row) => mapActiveEmbeddedEntry(row))
    .filter((entry): entry is ActiveEmbeddedEntry => Boolean(entry))
    .filter((entry) => (typeFilter ? entry.type === typeFilter : true))
    .filter((entry) => !shouldSkipByIdempotency(entry, idempotencyDays, now));

  if (candidates.length > MAX_ACTIVE_EMBEDDED_ENTRIES) {
    onLog(
      `[cluster] Warning: ${candidates.length} active embedded entries exceed ${MAX_ACTIVE_EMBEDDED_ENTRIES}. Consolidation may be slow.`,
    );
  }

  if (candidates.length < minCluster) {
    return [];
  }

  const entryById = new Map(candidates.map((entry) => [entry.id, entry]));
  const unionFind = new UnionFind();
  const visitedPairs = new Set<string>();
  const looseUnionPairs = new Set<string>();
  let llmDedupCalls = 0;
  let llmDedupMatches = 0;
  for (const entry of candidates) {
    unionFind.add(entry.id);
  }

  for (const entry of candidates) {
    const fetchLimit = typeFilter ? neighborLimit * 3 : neighborLimit;
    const neighbors = await findSimilar(db, entry.embedding, fetchLimit);
    for (const neighbor of neighbors) {
      const candidate = entryById.get(neighbor.entry.id);
      if (!candidate || candidate.id === entry.id) {
        continue;
      }

      const key = pairKey(entry.id, candidate.id);
      if (visitedPairs.has(key)) {
        continue;
      }
      visitedPairs.add(key);

      const similarity = cosineSim(entry.embedding, candidate.embedding);
      const sameType = entry.type === candidate.type;
      const sameSubject = normalizeSubject(entry.subject) === normalizeSubject(candidate.subject);

      if ((sameType && similarity >= simThreshold) || (sameSubject && similarity >= CROSS_TYPE_SUBJECT_THRESHOLD)) {
        unionFind.union(entry.id, candidate.id);
        continue;
      }

      const inLooseBand = similarity >= looseThreshold && similarity < simThreshold;
      if (!inLooseBand) {
        continue;
      }

      if (sameSubject) {
        looseUnionPairs.add(key);
        unionFind.union(entry.id, candidate.id);
        continue;
      }

      if (!llmClient) {
        continue;
      }

      llmDedupCalls += 1;
      const isSame = await llmDedupCheck(llmClient, entry, candidate);
      if (isSame) {
        llmDedupMatches += 1;
        looseUnionPairs.add(key);
        unionFind.union(entry.id, candidate.id);
      }
    }
  }

  const groups = new Map<string, ActiveEmbeddedEntry[]>();
  for (const entry of candidates) {
    const root = unionFind.find(entry.id);
    const group = groups.get(root) ?? [];
    group.push(entry);
    groups.set(root, group);
  }

  const tightDiameterFloor = Math.max(0, simThreshold - 0.02);
  const looseDiameterFloor = Math.max(0, Math.min(simThreshold, looseThreshold) - 0.02);
  const clusters: Cluster[] = [];

  for (const group of groups.values()) {
    if (group.length < minCluster) {
      continue;
    }

    let usedLooseUnion = false;
    for (let i = 0; i < group.length && !usedLooseUnion; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const key = pairKey(group[i].id, group[j].id);
        if (looseUnionPairs.has(key)) {
          usedLooseUnion = true;
          break;
        }
      }
    }

    const diameterFloor = usedLooseUnion ? looseDiameterFloor : tightDiameterFloor;
    const validated = validateCluster(group, maxClusterSize, diameterFloor);
    if (validated.length < minCluster) {
      continue;
    }

    clusters.push({ entries: validated });
  }

  if (options.verbose) {
    onLog(
      `[cluster] candidates=${candidates.length} clusters=${clusters.length} minCluster=${minCluster} simThreshold=${simThreshold.toFixed(2)} looseThreshold=${looseThreshold.toFixed(2)} neighborLimit=${neighborLimit} llmDedupCalls=${llmDedupCalls} llmDedupMatches=${llmDedupMatches}`,
    );
  }

  onStats({
    llmDedupCalls,
    llmDedupMatches,
  });

  return clusters;
}
