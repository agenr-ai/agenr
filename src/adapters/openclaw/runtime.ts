import type { AgenrConfig } from "../../config.js";
import { resolveDbPath } from "../../config.js";
import type { EmbeddingPort } from "../../core/ports.js";
import { createRecallAdapter } from "../db/recall-adapter.js";
import { createDatabase } from "../db/client.js";
import { createEmbeddingClient, EMBEDDING_MODEL, resolveEmbeddingModel } from "../embeddings.js";
import type { AgenrOpenClawEmbeddingStatus, AgenrOpenClawPluginConfig, AgenrOpenClawServices } from "./types.js";

/**
 * Creates the shared DB and embedding adapters used by the OpenClaw plugin.
 *
 * @param config - Normalized plugin config supplied by OpenClaw.
 * @returns Shared adapter services reused for the process lifetime.
 */
export async function createAgenrOpenClawServices(
  config: AgenrOpenClawPluginConfig,
  options: {
    resolvePath?: (input: string) => string;
  } = {},
): Promise<AgenrOpenClawServices> {
  const resolvedConfig = resolveRuntimeConfig(config, options.resolvePath);
  const agenrConfig: AgenrConfig = {
    dbPath: resolvedConfig.dbPath,
    apiKey: resolvedConfig.apiKey,
    embeddingApiKey: resolvedConfig.embeddingApiKey,
    embeddingModel: resolvedConfig.embeddingModel,
  };
  const dbPath = resolveDbPath(agenrConfig);
  const embeddingStatus = resolveEmbeddingStatus(agenrConfig);
  const database = await createDatabase(dbPath);
  const embedding = embeddingStatus.available
    ? createEmbeddingClient(requireApiKey(embeddingStatus), embeddingStatus.model)
    : createUnavailableEmbeddingPort(embeddingStatus.error ?? "Embeddings are unavailable.");
  let closed = false;

  return {
    config: resolvedConfig,
    dbPath,
    database,
    embedding,
    recall: createRecallAdapter(database, embedding),
    embeddingStatus: toPublicEmbeddingStatus(embeddingStatus),
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await database.close();
    },
  };
}

/** Internal embedding status shape that includes the resolved API key. */
type ResolvedEmbeddingStatus = AgenrOpenClawEmbeddingStatus & {
  apiKey?: string;
};

/**
 * Resolves the configured embedding provider/model without performing a network probe.
 *
 * @param config - Agenr-compatible plugin configuration.
 * @returns Static embedding availability facts used by the plugin runtime.
 */
function resolveEmbeddingStatus(config: AgenrConfig): ResolvedEmbeddingStatus {
  const model = resolveEmbeddingModel(config);
  const apiKey = config.embeddingApiKey?.trim() || config.apiKey?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return {
      available: false,
      provider: "unconfigured",
      requestedProvider: "openai",
      model,
      error: "Embedding API key is required. Set embeddingApiKey, apiKey, or OPENAI_API_KEY.",
    };
  }

  return {
    available: true,
    provider: "openai",
    requestedProvider: "openai",
    model,
    apiKey,
  };
}

/**
 * Hides private embedding credentials from the public runtime status object.
 *
 * @param status - Internal embedding status that may include secrets.
 * @returns Public embedding status safe to share with runtime consumers.
 */
function toPublicEmbeddingStatus(status: ResolvedEmbeddingStatus): AgenrOpenClawEmbeddingStatus {
  return {
    available: status.available,
    provider: status.provider,
    requestedProvider: status.requestedProvider,
    model: status.model,
    ...(status.error ? { error: status.error } : {}),
  };
}

/**
 * Creates an embedding port that always throws a stable configuration error.
 *
 * @param errorMessage - Human-readable failure message.
 * @returns Embedding port that rejects every embed request.
 */
function createUnavailableEmbeddingPort(errorMessage: string): EmbeddingPort {
  return {
    async embed(): Promise<number[][]> {
      throw new Error(errorMessage);
    },
  };
}

export { EMBEDDING_MODEL };

/**
 * Resolves relative plugin config paths before adapter initialization.
 *
 * @param config - Raw plugin config supplied by OpenClaw.
 * @param resolvePath - Optional OpenClaw path resolver.
 * @returns Config with dbPath normalized to an absolute runtime path when present.
 */
function resolveRuntimeConfig(config: AgenrOpenClawPluginConfig, resolvePath?: (input: string) => string): AgenrOpenClawPluginConfig {
  const dbPath = config.dbPath?.trim();
  if (!dbPath || !resolvePath) {
    return config;
  }

  return {
    ...config,
    dbPath: resolvePath(dbPath),
  };
}

/** Narrows resolved embedding status to the available branch with a concrete API key. */
function requireApiKey(status: ResolvedEmbeddingStatus): string {
  if (!status.apiKey) {
    throw new Error("Embedding API key is unavailable.");
  }

  return status.apiKey;
}
