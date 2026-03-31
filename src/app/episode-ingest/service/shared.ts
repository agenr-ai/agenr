import { buildEpisodeSummaryPrompt, EPISODE_SUMMARY_SYSTEM_PROMPT } from "../../../core/episode/summary-prompt.js";
import type { EpisodeIngestPorts, EpisodeIngestUsageStats } from "../ports.js";

const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Estimates Stage 1 prompt input tokens using a coarse character-based heuristic.
 *
 * @param renderedTranscript - Rendered transcript prompt text.
 * @returns Approximate input-token count.
 */
export function estimateInputTokens(renderedTranscript: string): number {
  return Math.max(1, Math.ceil(renderedTranscript.length / CHARS_PER_TOKEN_ESTIMATE));
}

/**
 * Estimates the full episode-summary prompt input tokens for one transcript.
 *
 * @param renderedTranscript - Rendered transcript prompt text.
 * @returns Approximate input-token count for the complete request.
 */
export function estimateEpisodeSummaryInputTokens(renderedTranscript: string): number {
  return estimateInputTokens(EPISODE_SUMMARY_SYSTEM_PROMPT) + estimateInputTokens(buildEpisodeSummaryPrompt(renderedTranscript));
}

/**
 * Best-effort episode summary embedding helper.
 *
 * @param summary - Episode summary text to embed.
 * @param ports - Embedding strategy and optional default embedding provider.
 * @returns Embedding vector when available and successful.
 */
export async function embedEpisodeSummary(summary: string, ports: Pick<EpisodeIngestPorts, "embedSummary" | "embedding">): Promise<number[] | undefined> {
  if (ports.embedSummary) {
    try {
      return normalizeEmbeddingVector(await ports.embedSummary(summary));
    } catch {
      return undefined;
    }
  }

  return embedEpisodeSummaryWithPort(summary, ports.embedding);
}

/**
 * Best-effort episode summary embedding using the default embedding port.
 *
 * @param summary - Episode summary text to embed.
 * @param embeddingPort - Optional embedding provider.
 * @returns Embedding vector when available and successful.
 */
export async function embedEpisodeSummaryWithPort(summary: string, embeddingPort: EpisodeIngestPorts["embedding"]): Promise<number[] | undefined> {
  if (!embeddingPort) {
    return undefined;
  }

  try {
    const vectors = await embeddingPort.embed([summary]);
    return normalizeEmbeddingVector(vectors[0]);
  } catch {
    return undefined;
  }
}

/**
 * Parses one candidate end timestamp into a valid Date when possible.
 *
 * @param endedAt - Candidate end timestamp.
 * @returns Parsed Date, or undefined when invalid.
 */
export function parseCandidateEndedAt(endedAt: string | undefined): Date | undefined {
  if (!endedAt) {
    return undefined;
  }

  const parsed = new Date(endedAt);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Creates a serialized async executor that never lets failures poison the queue.
 *
 * @returns Function that runs asynchronous tasks one at a time.
 */
export function createSerializedExecutor(): <T>(task: () => Promise<T>) => Promise<T> {
  let pending = Promise.resolve();

  return async <T>(task: () => Promise<T>): Promise<T> => {
    const current = pending.then(task, task);
    pending = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };
}

/**
 * Creates an empty usage snapshot.
 *
 * @returns Zeroed usage totals.
 */
export function createEmptyUsageStats(): EpisodeIngestUsageStats {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  };
}

/**
 * Clones one usage snapshot so callers cannot mutate the source client state.
 *
 * @param usage - Usage stats to clone.
 * @returns Detached usage snapshot.
 */
export function cloneUsageStats(usage: EpisodeIngestUsageStats): EpisodeIngestUsageStats {
  return {
    calls: usage.calls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.totalTokens,
    totalCost: usage.totalCost,
  };
}

/**
 * Adds one usage snapshot into an aggregate total.
 *
 * @param total - Aggregate usage accumulator.
 * @param usage - Usage stats to add.
 * @returns Updated aggregate usage totals.
 */
export function addUsageStats(total: EpisodeIngestUsageStats, usage: EpisodeIngestUsageStats): EpisodeIngestUsageStats {
  total.calls += usage.calls;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadTokens += usage.cacheReadTokens;
  total.cacheWriteTokens += usage.cacheWriteTokens;
  total.totalTokens += usage.totalTokens;
  total.totalCost += usage.totalCost;
  return total;
}

/**
 * Normalizes an optional string into a trimmed value.
 *
 * @param value - Optional string value.
 * @returns Trimmed string, or undefined when absent.
 */
export function trimOptionalString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Formats an unknown execution error into a stable result string.
 *
 * @param error - Unknown thrown value.
 * @returns Human-readable error message.
 */
export function formatExecutionError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }

  return String(error);
}

/**
 * Orders candidates by newest finished session first.
 *
 * @param left - Left candidate.
 * @param right - Right candidate.
 * @returns Stable descending sort order.
 */
export function compareCandidatesByEndedAt(left: { endedAt?: string; filePath: string }, right: { endedAt?: string; filePath: string }): number {
  const leftTime = left.endedAt ? new Date(left.endedAt).getTime() : Number.NEGATIVE_INFINITY;
  const rightTime = right.endedAt ? new Date(right.endedAt).getTime() : Number.NEGATIVE_INFINITY;

  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }

  return left.filePath.localeCompare(right.filePath);
}

/**
 * Normalizes one embedding vector into finite numeric values.
 *
 * @param vector - Candidate embedding vector.
 * @returns Stable embedding vector, or `undefined` when invalid.
 */
function normalizeEmbeddingVector(vector: number[] | undefined): number[] | undefined {
  const normalized = vector?.map((value) => (Number.isFinite(value) ? value : 0));
  return normalized && normalized.length > 0 ? normalized : undefined;
}
