import type { RecallPorts } from "../../../core/ports.js";

/**
 * Wraps real recall ports so the app layer can observe timings and counts.
 *
 * @param ports - Real recall ports used by the core recall pipeline.
 * @param observer - App-level observer that records stage metrics.
 * @returns Recall ports that preserve behavior while collecting diagnostics.
 */
export function createInstrumentedRecallPorts(
  ports: RecallPorts,
  observer: {
    recordQueryEmbedding(params: { durationMs: number; dimensions: number }): void;
    recordVectorSearch(params: { durationMs: number; count: number; limit: number }): void;
    recordLexicalSearch(params: { durationMs: number; count: number; limit: number }): void;
    recordHydrateEntries(params: { durationMs: number; count: number }): void;
    recordRecallTelemetry(params: { durationMs: number; entryCount: number }): void;
  },
): RecallPorts {
  return {
    async embed(text: string): Promise<number[]> {
      const startedAt = Date.now();

      try {
        const embedding = await ports.embed(text);
        observer.recordQueryEmbedding({
          durationMs: elapsedMs(startedAt),
          dimensions: embedding.length,
        });
        return embedding;
      } catch (error) {
        observer.recordQueryEmbedding({
          durationMs: elapsedMs(startedAt),
          dimensions: 0,
        });
        throw error;
      }
    },
    async vectorSearch(params): Promise<Awaited<ReturnType<RecallPorts["vectorSearch"]>>> {
      const startedAt = Date.now();

      try {
        const results = await ports.vectorSearch(params);
        observer.recordVectorSearch({
          durationMs: elapsedMs(startedAt),
          count: results.length,
          limit: params.limit,
        });
        return results;
      } catch (error) {
        observer.recordVectorSearch({
          durationMs: elapsedMs(startedAt),
          count: 0,
          limit: params.limit,
        });
        throw error;
      }
    },
    async ftsSearch(params): Promise<Awaited<ReturnType<RecallPorts["ftsSearch"]>>> {
      const startedAt = Date.now();

      try {
        const results = await ports.ftsSearch(params);
        observer.recordLexicalSearch({
          durationMs: elapsedMs(startedAt),
          count: results.length,
          limit: params.limit,
        });
        return results;
      } catch (error) {
        observer.recordLexicalSearch({
          durationMs: elapsedMs(startedAt),
          count: 0,
          limit: params.limit,
        });
        throw error;
      }
    },
    ...(ports.expandNeighborhood
      ? {
          async expandNeighborhood(request): Promise<Awaited<ReturnType<NonNullable<RecallPorts["expandNeighborhood"]>>>> {
            return ports.expandNeighborhood!(request);
          },
        }
      : {}),
    // Cross-encoder is an optional port: proxy it when available so the
    // core recall pipeline sees the same rerank surface as in production,
    // and the diagnostics collector can report the `crossEncoder` trace
    // branch exactly as the core emits it. Dropping the proxy here would
    // silently convert rerank-aware eval cases into rerank-disabled runs.
    ...(ports.crossEncoder
      ? {
          crossEncoder: ports.crossEncoder,
        }
      : {}),
    async hydrateEntries(ids: string[]): Promise<Awaited<ReturnType<RecallPorts["hydrateEntries"]>>> {
      const startedAt = Date.now();

      try {
        const entries = await ports.hydrateEntries(ids);
        observer.recordHydrateEntries({
          durationMs: elapsedMs(startedAt),
          count: entries.length,
        });
        return entries;
      } catch (error) {
        observer.recordHydrateEntries({
          durationMs: elapsedMs(startedAt),
          count: 0,
        });
        throw error;
      }
    },
    async recordRecallEvents(params): Promise<void> {
      const startedAt = Date.now();

      try {
        await ports.recordRecallEvents(params);
      } finally {
        observer.recordRecallTelemetry({
          durationMs: elapsedMs(startedAt),
          entryCount: params.entryIds.length,
        });
      }
    },
  };
}

/** Returns a non-negative elapsed millisecond count for one observed port call. */
function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}
