import type { EpisodeIngestPorts } from "../ports.js";
import type { BackfillEpisodeEmbeddingsOptions, EpisodeEmbeddingBackfillResult } from "../types.js";
import { embedEpisodeSummaryWithPort, estimateInputTokens } from "./shared.js";

/**
 * Backfills embeddings for active episodes that are currently missing them.
 *
 * @param ports - Episode database plus an embedding provider.
 * @param options - Concurrency and progress-reporting settings.
 * @returns Aggregate embedding-backfill outcome.
 */
export async function backfillEpisodeEmbeddings(ports: EpisodeIngestPorts, options: BackfillEpisodeEmbeddingsOptions): Promise<EpisodeEmbeddingBackfillResult> {
  const embedding = ports.embedding;
  if (!embedding) {
    throw new Error("Episode embedding backfill requires an embedding provider.");
  }

  if (!Number.isFinite(options.concurrency) || Math.trunc(options.concurrency) <= 0) {
    throw new Error(`Episode embedding backfill concurrency must be a positive integer. Received: ${options.concurrency}.`);
  }

  const pendingEpisodes = await ports.episodes.listEpisodesWithoutEmbeddings();
  if (pendingEpisodes.length === 0) {
    return {
      totalMissing: 0,
      attempted: 0,
      embedded: 0,
      failed: 0,
      estimatedInputTokens: 0,
    };
  }

  const estimatedInputTokens = pendingEpisodes.reduce((total, episode) => total + estimateInputTokens(episode.summary), 0);
  const workerCount = Math.min(Math.trunc(options.concurrency), pendingEpisodes.length);
  let nextIndex = 0;
  let completed = 0;
  let embeddedCount = 0;
  let failedCount = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        if (currentIndex >= pendingEpisodes.length) {
          return;
        }

        const episode = pendingEpisodes[currentIndex];
        if (!episode) {
          return;
        }

        let status: "embedded" | "failed" = "failed";

        try {
          const vector = await embedEpisodeSummaryWithPort(episode.summary, embedding);
          if (vector) {
            await ports.episodes.updateEpisodeEmbedding(episode.id, vector);
            embeddedCount += 1;
            status = "embedded";
          } else {
            failedCount += 1;
          }
        } catch {
          failedCount += 1;
        }

        completed += 1;
        options.onProgress?.(completed, pendingEpisodes.length, episode, status);
      }
    }),
  );

  return {
    totalMissing: pendingEpisodes.length,
    attempted: pendingEpisodes.length,
    embedded: embeddedCount,
    failed: failedCount,
    estimatedInputTokens,
  };
}
