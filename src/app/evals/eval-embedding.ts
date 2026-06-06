import { createEmbeddingClient, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../../adapters/embeddings.js";
import { readConfig } from "../../config.js";
import type { EmbeddingPort } from "../../core/ports.js";

/** Resolved embedding support for one isolated eval case. */
export interface EvalEmbeddingSupport {
  /** Whether a real embedding port is available. */
  available: boolean;
  /** Failure reason when embeddings are unavailable. */
  error?: string;
  /** Real embedding port when configured successfully. */
  port?: EmbeddingPort;
}

/** Lazily resolves and caches eval embedding support for one case runner. */
export interface EvalEmbeddingResolver {
  /** Returns cached embedding support, constructing it on first use. */
  getSupport(): EvalEmbeddingSupport;
  /** Returns a real embedding port or throws the cached unavailability reason. */
  requirePort(): EmbeddingPort;
  /** Returns a real embedding port or a lazy failing port with the cached reason. */
  portOrUnavailable(): EmbeddingPort;
}

/** Creates a per-runner lazy embedding resolver. */
export function createEvalEmbeddingResolver(): EvalEmbeddingResolver {
  let sharedEmbeddingPort: EmbeddingPort | undefined;
  let sharedEmbeddingError: string | undefined;

  const getSupport = (): EvalEmbeddingSupport => {
    if (sharedEmbeddingPort) {
      return {
        available: true,
        port: sharedEmbeddingPort,
      };
    }

    if (sharedEmbeddingError) {
      return {
        available: false,
        error: sharedEmbeddingError,
      };
    }

    const config = readConfig();
    try {
      sharedEmbeddingPort = createEmbeddingClient(resolveEmbeddingApiKey(config), resolveEmbeddingModel(config));
      return {
        available: true,
        port: sharedEmbeddingPort,
      };
    } catch (error) {
      sharedEmbeddingError = error instanceof Error ? error.message : String(error);
      return {
        available: false,
        error: sharedEmbeddingError,
      };
    }
  };

  const requirePort = (): EmbeddingPort => {
    const support = getSupport();
    if (!support.port) {
      throw new Error(support.error ?? "Embeddings are unavailable.");
    }

    return support.port;
  };

  const portOrUnavailable = (): EmbeddingPort => {
    const support = getSupport();
    return support.port ?? createUnavailableEmbeddingPort(support.error ?? "Embeddings are unavailable.");
  };

  return {
    getSupport,
    requirePort,
    portOrUnavailable,
  };
}

/** Creates an embedding port that fails lazily when embeddings are requested. */
export function createUnavailableEmbeddingPort(message: string): EmbeddingPort {
  return {
    async embed(): Promise<number[][]> {
      throw new Error(message);
    },
  };
}
