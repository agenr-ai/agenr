import type { EmbeddingPort, LlmPort } from "../ports.js";
import { composeEmbeddingText } from "../store/embedding-text.js";
import type { StoreEntryInput } from "../types.js";

const DEFAULT_SIMILARITY_THRESHOLD = 0.75;
const DEFAULT_DEDUP_CONCURRENCY = 10;

/**
 * Returns the default cosine similarity threshold used for semantic dedup clustering.
 *
 * @returns Default clustering threshold for within-batch semantic dedup.
 */
export function getDefaultDedupSimilarityThreshold(): number {
  return DEFAULT_SIMILARITY_THRESHOLD;
}

/**
 * Returns the default arbitration concurrency used for cluster-level dedup.
 *
 * @returns Default maximum number of concurrent cluster arbitrations.
 */
export function getDefaultDedupConcurrency(): number {
  return DEFAULT_DEDUP_CONCURRENCY;
}

/**
 * Runtime controls for within-batch semantic deduplication.
 */
export interface DedupOptions {
  /** Cosine similarity threshold for clustering. Default: 0.75. */
  similarityThreshold?: number;
  /** Maximum number of multi-entry clusters arbitrated concurrently. Default: 10. */
  concurrency?: number;
  /** Skip LLM arbitration and pass every extracted entry through. */
  skip?: boolean;
  /** Enables verbose debug logging at the caller level. */
  verbose?: boolean;
  /** Optional callback invoked as multi-entry cluster arbitrations finish. */
  onProgress?: (event: DedupProgressEvent) => void;
}

/**
 * Structured progress emitted as multi-entry dedup arbitrations complete.
 */
export interface DedupProgressEvent {
  /** Number of multi-entry clusters whose arbitration has completed. */
  completedClusters: number;
  /** Total number of multi-entry clusters queued for arbitration. */
  totalClusters: number;
  /** Number of entries covered by completed multi-entry cluster arbitrations. */
  completedEntries: number;
  /** Total number of entries that belong to arbitrated multi-entry clusters. */
  totalEntries: number;
}

/**
 * Debug metadata for a single arbitrated similarity cluster.
 */
export interface DedupClusterDetail {
  /** Original input indices that belong to this cluster. */
  entryIndices: number[];
  /** Subject strings for the clustered entries. */
  subjects: string[];
  /** Maximum pairwise cosine similarity observed inside the cluster. */
  maxSimilarity: number;
  /** Original input indices the LLM decided to keep. */
  kept: number[];
  /** Original input indices the LLM decided to drop. */
  dropped: number[];
  /** Whether the kept entry was rewritten with merged content. */
  merged: boolean;
  /** Original input index that received merged content, when present. */
  mergeTarget?: number;
  /** Merged content returned by the model, when present. */
  mergedContent?: string;
  /** Raw LLM response retained for debugging. */
  rawResponse?: string;
}

/**
 * Semantic deduplication result for one extracted ingest batch.
 */
export interface DedupResult {
  /** Entries that survived dedup, preserved in original input order. */
  survivors: StoreEntryInput[];
  /** Original input indices aligned with `survivors` and `embeddings`. */
  survivorIndices: number[];
  /** Precomputed embeddings aligned with `survivors`. */
  embeddings: number[][];
  /** Number of entries received by the dedup pass. */
  inputCount: number;
  /** Number of entries removed as within-batch near-duplicates. */
  removedCount: number;
  /** Number of clusters that required LLM arbitration. */
  clustersArbitrated: number;
  /** Number of singleton entries that passed straight through. */
  singletonsPassedThrough: number;
  /** Number of LLM calls made during arbitration. */
  llmCalls: number;
  /** Per-cluster arbitration details for verbose logging and debugging. */
  clusterDetails: DedupClusterDetail[];
  /** Non-fatal arbitration warnings collected during the dedup pass. */
  warnings: string[];
  /** Similarity threshold used for clustering. */
  similarityThreshold: number;
}

/** Raw dedup decision shape returned by the arbitration model. */
interface DedupDecision {
  keep: number[];
  drop: number[];
  merge_into?: number;
  merged_content?: string;
}

/** Sanitized dedup decision with validated local cluster indexes. */
interface NormalizedDedupDecision {
  keep: number[];
  drop: number[];
  mergeInto?: number;
  mergedContent?: string;
}

/** Detail plus optional warning emitted by one arbitration attempt. */
interface ArbitrationResult {
  detail: DedupClusterDetail;
  warning?: string;
}

/** Stable metadata for one multi-entry cluster that needs arbitration. */
interface ArbitrationTask {
  clusterIndex: number;
  cluster: number[];
  maxSimilarity: number;
}

/**
 * Clusters extracted entries by embedding similarity and arbitrates each
 * multi-entry cluster with a lightweight LLM dedup classifier.
 *
 * @param entries - Extracted entries from the current ingest batch.
 * @param llm - LLM port used to arbitrate semantically similar clusters.
 * @param embedding - Embedding port used to compute similarity vectors.
 * @param options - Optional clustering threshold and skip behavior.
 * @returns Surviving entries plus aligned embeddings and debug metadata.
 */
export async function dedupBatch(entries: StoreEntryInput[], llm: LlmPort, embedding: EmbeddingPort, options: DedupOptions = {}): Promise<DedupResult> {
  const similarityThreshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const concurrency = normalizeDedupConcurrency(options.concurrency);
  if (entries.length === 0) {
    return {
      survivors: [],
      survivorIndices: [],
      embeddings: [],
      inputCount: 0,
      removedCount: 0,
      clustersArbitrated: 0,
      singletonsPassedThrough: 0,
      llmCalls: 0,
      clusterDetails: [],
      warnings: [],
      similarityThreshold,
    };
  }

  const texts = entries.map((entry) => composeEmbeddingText(entry));
  const embeddings = await embedding.embed(texts);
  if (embeddings.length !== entries.length) {
    throw new Error(`Dedup embedding length mismatch: expected ${entries.length}, received ${embeddings.length}.`);
  }

  if (options.skip === true) {
    return buildPassthroughResult(entries, embeddings, similarityThreshold);
  }

  const clusters = clusterBySimilarity(embeddings, similarityThreshold);
  const survivorByIndex = new Map<number, StoreEntryInput>();
  const clusterDetails: DedupClusterDetail[] = [];
  const warnings: string[] = [];
  const arbitrationTasks: ArbitrationTask[] = [];
  let singletonsPassedThrough = 0;

  for (const [clusterIndex, cluster] of clusters.entries()) {
    if (cluster.length === 1) {
      const entryIndex = cluster[0];
      if (entryIndex !== undefined) {
        survivorByIndex.set(entryIndex, entries[entryIndex]);
        singletonsPassedThrough += 1;
      }
      continue;
    }

    arbitrationTasks.push({
      clusterIndex,
      cluster,
      maxSimilarity: calculateClusterMaxSimilarity(cluster, embeddings),
    });
  }

  const totalArbitratedEntries = arbitrationTasks.reduce((sum, task) => sum + task.cluster.length, 0);
  let completedClusters = 0;
  let completedEntries = 0;

  const arbitrationResults = await runBoundedArbitrations(
    arbitrationTasks,
    concurrency,
    async (task) => arbitrateCluster(task.clusterIndex, task.cluster, entries, llm, task.maxSimilarity),
    (task) => {
      completedClusters += 1;
      completedEntries += task.cluster.length;
      options.onProgress?.({
        completedClusters,
        totalClusters: arbitrationTasks.length,
        completedEntries,
        totalEntries: totalArbitratedEntries,
      });
    },
  );

  for (const arbitration of arbitrationResults) {
    clusterDetails.push(arbitration.detail);
    if (arbitration.warning) {
      warnings.push(arbitration.warning);
    }

    for (const keptIndex of arbitration.detail.kept) {
      const updatedEntry =
        arbitration.detail.merged === true && arbitration.detail.mergedContent && keptIndex === arbitration.detail.mergeTarget
          ? mergeClusterEntry(arbitration.detail.entryIndices, keptIndex, arbitration.detail.mergedContent, entries)
          : entries[keptIndex];
      survivorByIndex.set(keptIndex, updatedEntry);
    }
  }

  const survivorIndices: number[] = [];
  const survivors: StoreEntryInput[] = [];
  const survivorEmbeddings: number[][] = [];

  for (const [index] of entries.entries()) {
    const survivor = survivorByIndex.get(index);
    if (!survivor) {
      continue;
    }

    survivorIndices.push(index);
    survivors.push(survivor);
    survivorEmbeddings.push(embeddings[index] ?? []);
  }

  return {
    survivors,
    survivorIndices,
    embeddings: survivorEmbeddings,
    inputCount: entries.length,
    removedCount: entries.length - survivors.length,
    clustersArbitrated: clusterDetails.length,
    singletonsPassedThrough,
    llmCalls: arbitrationTasks.length,
    clusterDetails,
    warnings,
    similarityThreshold,
  };
}

/**
 * Normalizes the requested arbitration concurrency into a safe positive integer.
 *
 * @param value - Candidate configured concurrency.
 * @returns Positive concurrency limit, or the default of `10`.
 */
function normalizeDedupConcurrency(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    return DEFAULT_DEDUP_CONCURRENCY;
  }

  return value;
}

/**
 * Runs cluster arbitrations with bounded concurrency while preserving task order.
 *
 * @param tasks - Multi-entry clusters queued in original cluster order.
 * @param concurrency - Maximum number of arbitration workers.
 * @param worker - Arbitration function for one cluster task.
 * @returns Arbitration results aligned to the original task order.
 */
async function runBoundedArbitrations<TTask, TResult>(
  tasks: TTask[],
  concurrency: number,
  worker: (task: TTask, taskIndex: number) => Promise<TResult>,
  onTaskComplete?: (task: TTask, taskIndex: number) => void,
): Promise<TResult[]> {
  if (tasks.length === 0) {
    return [];
  }

  const results = new Array<TResult>(tasks.length);
  const workerCount = Math.min(concurrency, tasks.length);
  let nextTaskIndex = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const taskIndex = nextTaskIndex;
        nextTaskIndex += 1;

        if (taskIndex >= tasks.length) {
          return;
        }

        const task = tasks[taskIndex];
        if (task === undefined) {
          return;
        }

        results[taskIndex] = await worker(task, taskIndex);
        onTaskComplete?.(task, taskIndex);
      }
    }),
  );

  return results;
}

/** Runs LLM arbitration for one similarity cluster and records debug detail. */
async function arbitrateCluster(
  clusterIndex: number,
  cluster: number[],
  entries: StoreEntryInput[],
  llm: LlmPort,
  maxSimilarity: number,
): Promise<ArbitrationResult> {
  const systemPrompt = buildDedupSystemPrompt();
  const userPrompt = buildDedupUserPrompt(cluster, entries);
  let rawResponse: string | undefined;

  try {
    rawResponse = await llm.complete(systemPrompt, userPrompt);
    const parsed = parseDedupDecision(rawResponse);
    const normalized = normalizeDedupDecision(parsed, cluster.length);

    const kept = normalized.keep.map((localIndex) => cluster[localIndex]).filter(isDefined);
    const dropped = normalized.drop.map((localIndex) => cluster[localIndex]).filter(isDefined);

    return {
      detail: {
        entryIndices: [...cluster],
        subjects: cluster.map((index) => entries[index]?.subject ?? ""),
        maxSimilarity,
        kept,
        dropped,
        merged: Boolean(normalized.mergedContent),
        mergeTarget: normalized.mergeInto !== undefined ? cluster[normalized.mergeInto] : undefined,
        mergedContent: normalized.mergedContent,
        rawResponse,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      detail: {
        entryIndices: [...cluster],
        subjects: cluster.map((index) => entries[index]?.subject ?? ""),
        maxSimilarity,
        kept: [...cluster],
        dropped: [],
        merged: false,
        rawResponse,
      },
      warning: `Cluster ${clusterIndex + 1}: dedup arbitration failed, keeping all entries (${message}).`,
    };
  }
}

/** Builds a no-op dedup result when arbitration is skipped. */
function buildPassthroughResult(entries: StoreEntryInput[], embeddings: number[][], similarityThreshold: number): DedupResult {
  return {
    survivors: [...entries],
    survivorIndices: entries.map((_, index) => index),
    embeddings: embeddings.map((vector) => [...vector]),
    inputCount: entries.length,
    removedCount: 0,
    clustersArbitrated: 0,
    singletonsPassedThrough: entries.length,
    llmCalls: 0,
    clusterDetails: [],
    warnings: [],
    similarityThreshold,
  };
}

/**
 * Groups entries into similarity clusters with single-linkage union-find.
 *
 * @param embeddings - Embedding vector per input entry.
 * @param threshold - Cosine similarity threshold used to merge clusters.
 * @returns Clusters of input indices sorted by their first original index.
 */
function clusterBySimilarity(embeddings: number[][], threshold: number): number[][] {
  const parents = embeddings.map((_, index) => index);
  const ranks = embeddings.map(() => 0);

  for (let leftIndex = 0; leftIndex < embeddings.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < embeddings.length; rightIndex += 1) {
      if (cosineSimilarity(embeddings[leftIndex], embeddings[rightIndex]) >= threshold) {
        union(leftIndex, rightIndex, parents, ranks);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let index = 0; index < embeddings.length; index += 1) {
    const root = find(index, parents);
    const cluster = groups.get(root) ?? [];
    cluster.push(index);
    groups.set(root, cluster);
  }

  return [...groups.values()].map((cluster) => [...cluster].sort((left, right) => left - right)).sort((left, right) => left[0]! - right[0]!);
}

/** Computes the maximum pairwise similarity inside one cluster. */
function calculateClusterMaxSimilarity(cluster: number[], embeddings: number[][]): number {
  let maxSimilarity = 0;

  for (let leftOffset = 0; leftOffset < cluster.length; leftOffset += 1) {
    for (let rightOffset = leftOffset + 1; rightOffset < cluster.length; rightOffset += 1) {
      const leftIndex = cluster[leftOffset];
      const rightIndex = cluster[rightOffset];
      if (leftIndex === undefined || rightIndex === undefined) {
        continue;
      }

      maxSimilarity = Math.max(maxSimilarity, cosineSimilarity(embeddings[leftIndex], embeddings[rightIndex]));
    }
  }

  return maxSimilarity;
}

/** Computes cosine similarity for two embeddings of equal dimensionality. */
function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length) {
    throw new Error(`Embedding dimension mismatch: ${left.length} vs ${right.length}.`);
  }

  if (left.length === 0) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/** Finds the union-find root for an entry index with path compression. */
function find(index: number, parents: number[]): number {
  if (parents[index] === index) {
    return index;
  }

  parents[index] = find(parents[index] ?? index, parents);
  return parents[index] ?? index;
}

/** Merges two union-find sets using union by rank. */
function union(left: number, right: number, parents: number[], ranks: number[]): void {
  const leftRoot = find(left, parents);
  const rightRoot = find(right, parents);

  if (leftRoot === rightRoot) {
    return;
  }

  const leftRank = ranks[leftRoot] ?? 0;
  const rightRank = ranks[rightRoot] ?? 0;

  if (leftRank < rightRank) {
    parents[leftRoot] = rightRoot;
    return;
  }

  if (leftRank > rightRank) {
    parents[rightRoot] = leftRoot;
    return;
  }

  parents[rightRoot] = leftRoot;
  ranks[leftRoot] = leftRank + 1;
}

/** Builds the system prompt for cluster-level dedup arbitration. */
function buildDedupSystemPrompt(): string {
  return [
    "You are a memory dedup classifier.",
    "You receive a cluster of semantically similar knowledge entries and must decide which ones are genuine duplicates.",
    "Two entries are duplicates when recalling either one would cause the same agent behavior.",
    'Return JSON only with this shape: {"keep":[0],"drop":[1],"merge_into":0,"merged_content":"optional"}',
    "Rules:",
    "- Keep the most specific and grounded entry.",
    "- Different wording, framing, or type labels can still be duplicates.",
    '- If entries are related but not duplicates, keep all of them and return {"keep":[0,1,...],"drop":[]}.',
    "- If you provide merged_content, keep it at least as specific as the best entry.",
  ].join("\n");
}

/** Builds the user prompt describing one similarity cluster. */
function buildDedupUserPrompt(cluster: number[], entries: StoreEntryInput[]): string {
  const lines = [`Cluster of ${cluster.length} similar entries:`];

  for (const [localIndex, entryIndex] of cluster.entries()) {
    const entry = entries[entryIndex];
    if (!entry) {
      continue;
    }

    lines.push("");
    lines.push(`[${localIndex}] type=${entry.type} importance=${entry.importance ?? 7} subject=${JSON.stringify(entry.subject)}`);
    lines.push(`    content: ${JSON.stringify(entry.content)}`);
  }

  lines.push("");
  lines.push("Are any of these duplicates? Return JSON.");

  return lines.join("\n");
}

/** Parses a raw model response into the expected dedup decision shape. */
function parseDedupDecision(rawResponse: string): DedupDecision {
  const candidate = JSON.parse(extractJsonObject(stripCodeFence(rawResponse))) as Partial<DedupDecision>;

  return {
    keep: toIndexArray(candidate.keep),
    drop: toIndexArray(candidate.drop),
    merge_into: toOptionalIndex(candidate.merge_into),
    merged_content: typeof candidate.merged_content === "string" ? candidate.merged_content.trim() : undefined,
  };
}

/** Normalizes a raw dedup decision against the current cluster size. */
function normalizeDedupDecision(decision: DedupDecision, clusterSize: number): NormalizedDedupDecision {
  const keep = dedupeIndexes(decision.keep, clusterSize);
  if (keep.length === 0) {
    return {
      keep: buildFullIndexList(clusterSize),
      drop: [],
    };
  }

  const keepSet = new Set(keep);
  const dropSet = new Set(dedupeIndexes(decision.drop, clusterSize).filter((index) => !keepSet.has(index)));
  const normalizedKeep = buildFullIndexList(clusterSize).filter((index) => !dropSet.has(index));

  if (normalizedKeep.length === 0) {
    return {
      keep: buildFullIndexList(clusterSize),
      drop: [],
    };
  }

  const normalizedKeepSet = new Set(normalizedKeep);
  const normalizedDrop = [...dropSet].filter((index) => !normalizedKeepSet.has(index));
  const mergeInto =
    decision.merge_into !== undefined && normalizedKeepSet.has(decision.merge_into) && decision.merged_content ? decision.merge_into : undefined;

  return {
    keep: normalizedKeep,
    drop: normalizedDrop,
    mergeInto,
    mergedContent: mergeInto !== undefined ? decision.merged_content : undefined,
  };
}

/** Applies merged cluster content to the kept survivor entry. */
function mergeClusterEntry(cluster: number[], keptIndex: number, mergedContent: string, entries: StoreEntryInput[]): StoreEntryInput {
  const keptEntry = entries[keptIndex];
  if (!keptEntry) {
    throw new Error(`Cannot merge cluster entry ${keptIndex}: entry not found.`);
  }

  const mergedTags = dedupeStrings(cluster.flatMap((entryIndex) => entries[entryIndex]?.tags ?? []));
  const mergedImportance = Math.max(...cluster.map((entryIndex) => entries[entryIndex]?.importance ?? 7));

  return {
    ...keptEntry,
    content: mergedContent,
    importance: mergedImportance,
    tags: mergedTags,
  };
}

/** Removes a single outer Markdown code fence from LLM output. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]+?)\s*```$/i.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

/** Extracts the outermost JSON object substring from model output. */
function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1 || end < start) {
    throw new Error("Dedup response did not contain a JSON object.");
  }

  return text.slice(start, end + 1);
}

/** Converts an unknown value into an array of integer indexes. */
function toIndexArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => (Number.isInteger(entry) ? [entry] : []));
}

/** Converts an unknown value into an optional integer index. */
function toOptionalIndex(value: unknown): number | undefined {
  return Number.isInteger(value) ? (value as number) : undefined;
}

/** Deduplicates and bounds-checks local cluster indexes. */
function dedupeIndexes(indexes: number[], clusterSize: number): number[] {
  const seen = new Set<number>();
  const deduped: number[] = [];

  for (const index of indexes) {
    if (index < 0 || index >= clusterSize || seen.has(index)) {
      continue;
    }

    seen.add(index);
    deduped.push(index);
  }

  return deduped;
}

/** Builds a contiguous local index list for a cluster. */
function buildFullIndexList(length: number): number[] {
  return Array.from({ length }, (_, index) => index);
}

/** Removes duplicate strings while preserving first-seen order. */
function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}

/** Narrows away `undefined` values in array filters. */
function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
