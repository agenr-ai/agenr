import type { EmbeddingPort } from "../../core/ports.js";
import type { BeforeTurnDeps } from "../../app/before-turn/index.js";

/**
 * Creates a before-turn query embedder when embeddings are available.
 *
 * @param embedding - Embedding port used for query vectors.
 * @param available - Whether embedding credentials resolved successfully.
 * @returns Query embedder, or `undefined` when embeddings are unavailable.
 */
export function createEmbedQuery(embedding: EmbeddingPort, available: boolean): BeforeTurnDeps["embedQuery"] {
  if (!available) {
    return undefined;
  }

  return async (text: string) => {
    const vectors = await embedding.embed([text]);
    const vector = vectors[0];
    if (!vector) {
      throw new Error("Embedding provider returned no vector for the query.");
    }

    return vector;
  };
}
