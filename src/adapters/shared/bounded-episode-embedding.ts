import type { EmbeddingPort } from "../../core/ports.js";

import { formatErrorMessage } from "./errors.js";

/** Sentinel returned when an embedding call exceeds its remaining budget. */
const EPISODE_EMBEDDING_RACE_TIMEOUT = Symbol("episode-embedding-race-timeout");

/** Minimum remaining shutdown/write budget required before attempting embedding. */
const EPISODE_EMBEDDING_MIN_HEADROOM_MS = 5_000;

/** Logger surface used by bounded episode embedding helpers. */
export type EpisodeEmbeddingLogger = Pick<Console, "info">;

/**
 * Best-effort episode-summary embedding that respects a shared write deadline.
 *
 * @param params - Embedding port, budget facts, and log context.
 * @returns Embedding vector, or undefined when unavailable, over budget, or timed out.
 */
export async function embedEpisodeSummaryWithinBudget(params: {
  summary: string;
  embedding: EmbeddingPort;
  embeddingAvailable: boolean;
  deadlineMs: number;
  minHeadroomMs?: number;
  logger: EpisodeEmbeddingLogger;
  logContext: string;
}): Promise<number[] | undefined> {
  const minHeadroomMs = params.minHeadroomMs ?? EPISODE_EMBEDDING_MIN_HEADROOM_MS;

  if (!params.embeddingAvailable) {
    params.logger.info(`${params.logContext} reason=embedding_unavailable`);
    return undefined;
  }

  const remainingBudgetMs = params.deadlineMs - Date.now();
  if (remainingBudgetMs < minHeadroomMs) {
    params.logger.info(`${params.logContext} reason=budget_tight remainingMs=${Math.max(0, remainingBudgetMs)}`);
    return undefined;
  }

  try {
    const result = await raceEmbeddingWithTimeout(params.embedding.embed([params.summary]), remainingBudgetMs);
    if (result === EPISODE_EMBEDDING_RACE_TIMEOUT) {
      params.logger.info(`${params.logContext} reason=embedding_timeout budgetMs=${remainingBudgetMs}`);
      return undefined;
    }

    const vector = result[0]?.map((value) => (Number.isFinite(value) ? value : 0));
    if (!vector || vector.length === 0) {
      params.logger.info(`${params.logContext} reason=empty_embedding`);
      return undefined;
    }

    return vector;
  } catch (error) {
    params.logger.info(`${params.logContext} reason=${formatErrorMessage(error)}`);
    return undefined;
  }
}

/**
 * Resolves an embedding request while capping it to the remaining time budget.
 *
 * @param promise - In-flight embedding call.
 * @param timeoutMs - Maximum remaining time budget.
 * @returns Embedding result or the race-timeout sentinel.
 */
export async function raceEmbeddingWithTimeout(promise: Promise<number[][]>, timeoutMs: number): Promise<number[][] | typeof EPISODE_EMBEDDING_RACE_TIMEOUT> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      resolve(EPISODE_EMBEDDING_RACE_TIMEOUT);
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
