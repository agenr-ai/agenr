import type { AgenrConfig } from "../../config.js";
import { readConfig } from "../../config.js";
import type { EmbeddingPort } from "../../core/ports.js";
import { createRecallAdapter } from "../db/recall-adapter.js";
import { createDatabase } from "../db/client.js";
import { createEmbeddingClient, EMBEDDING_MODEL, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../embeddings.js";
import { createLlmClient, resolveLlmApiKey } from "../llm.js";
import type { AgenrOpenClawEmbeddingStatus, AgenrOpenClawPluginConfig, AgenrOpenClawServices, AgenrOpenClawSummaryStatus } from "./types.js";

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
    ...readConfig({
      configPath: resolvedConfig.configPath,
      dbPath: resolvedConfig.dbPath,
    }),
    dbPath: resolvedConfig.dbPath,
  };
  const dbPath = resolvedConfig.dbPath;
  const embeddingStatus = resolveEmbeddingStatus(agenrConfig);
  let summaryStatus = resolveSummaryStatus(agenrConfig);
  const database = await createDatabase(dbPath);
  const embedding = embeddingStatus.available
    ? createEmbeddingClient(requireApiKey(embeddingStatus), embeddingStatus.model)
    : createUnavailableEmbeddingPort(embeddingStatus.error ?? "Embeddings are unavailable.");
  let summaryLlm;
  if (summaryStatus.available) {
    try {
      summaryLlm = createLlmClient(summaryStatus.provider, summaryStatus.model, {
        apiKey: requireLlmApiKey(summaryStatus),
      });
    } catch (error) {
      summaryStatus = {
        ...summaryStatus,
        available: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  let closed = false;

  return {
    config: resolvedConfig,
    agenrConfig,
    dbPath,
    database,
    embedding,
    recall: createRecallAdapter(database, embedding),
    embeddingStatus: toPublicEmbeddingStatus(embeddingStatus),
    summaryStatus: toPublicSummaryStatus(summaryStatus),
    ...(summaryLlm ? { summaryLlm } : {}),
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

/** Internal summary status shape that includes the resolved API key. */
type ResolvedSummaryStatus = AgenrOpenClawSummaryStatus & {
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
  try {
    return {
      available: true,
      provider: "openai",
      requestedProvider: "openai",
      model,
      apiKey: resolveEmbeddingApiKey(config),
    };
  } catch (error) {
    return {
      available: false,
      provider: "unconfigured",
      requestedProvider: "openai",
      model,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
 * Resolves the configured LLM provider/model for session continuity summaries.
 *
 * @param config - Agenr-compatible plugin configuration.
 * @returns Static summary-model availability facts used by the plugin runtime.
 */
function resolveSummaryStatus(config: AgenrConfig): ResolvedSummaryStatus {
  const provider = normalizeOptionalString(config.provider) ?? "openai";
  const model = normalizeOptionalString(config.model) ?? "gpt-5.4-mini";

  try {
    return {
      available: true,
      provider,
      model,
      apiKey: resolveLlmApiKey(config, provider),
    };
  } catch (error) {
    return {
      available: false,
      provider,
      model,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Hides private summary-model credentials from the public runtime status object.
 *
 * @param status - Internal summary status that may include secrets.
 * @returns Public summary status safe to share with runtime consumers.
 */
function toPublicSummaryStatus(status: ResolvedSummaryStatus): AgenrOpenClawSummaryStatus {
  return {
    available: status.available,
    provider: status.provider,
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
 * @returns Config with plugin paths normalized to absolute runtime paths.
 */
function resolveRuntimeConfig(config: AgenrOpenClawPluginConfig, resolvePath?: (input: string) => string): AgenrOpenClawPluginConfig {
  if (!resolvePath) {
    return config;
  }

  return {
    ...config,
    dbPath: resolvePath(config.dbPath),
    ...(config.configPath ? { configPath: resolvePath(config.configPath) } : {}),
  };
}

/** Narrows resolved embedding status to the available branch with a concrete API key. */
function requireApiKey(status: ResolvedEmbeddingStatus): string {
  if (!status.apiKey) {
    throw new Error("Embedding API key is unavailable.");
  }

  return status.apiKey;
}

/** Narrows resolved summary status to the available branch with a concrete API key. */
function requireLlmApiKey(status: ResolvedSummaryStatus): string {
  if (!status.apiKey) {
    throw new Error("Summary LLM API key is unavailable.");
  }

  return status.apiKey;
}

/** Normalizes optional strings into trimmed non-empty values. */
function normalizeOptionalString(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
