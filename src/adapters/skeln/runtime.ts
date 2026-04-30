import type { CrossEncoderPort, EmbeddingPort, RecallPorts } from "../../core/ports.js";
import type { AgenrConfig } from "../../config.js";
import { readConfig, resolveConfigPath, resolveDbPath } from "../../config.js";
import { createOpenAICrossEncoder, resolveCrossEncoderApiKey } from "../cross-encoder/openai-cross-encoder.js";
import { createDatabase } from "../db/client.js";
import { createMemoryRepository } from "../db/memory-repository.js";
import { createRecallAdapter } from "../db/recall-adapter.js";
import { createEmbeddingClient, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../embeddings.js";
import { resolveModel } from "../llm.js";
import { attachCrossEncoderPort } from "../../app/evals/recall/attach-cross-encoder.js";
import type { AgenrSkelnEmbeddingStatus, AgenrSkelnServices } from "./types.js";

/**
 * Options used to create Skeln-owned agenr runtime services.
 */
export interface CreateAgenrSkelnServicesOptions {
  /** Optional path to an agenr config file. */
  configPath?: string;
  /** Optional database path override. */
  databasePath?: string;
}

/**
 * Creates host-neutral DB-backed services for the Skeln adapter.
 *
 * @param options - Config and database path overrides from the provider factory.
 * @returns Shared services used by Skeln memory tools.
 */
export async function createAgenrSkelnServices(options: CreateAgenrSkelnServicesOptions): Promise<AgenrSkelnServices> {
  const { dbPath, config } = resolveRuntimeConfig(options);
  const embeddingStatus = resolveEmbeddingStatus(config);
  const database = await createDatabase(dbPath);
  const embedding = embeddingStatus.available
    ? createEmbeddingClient(requireApiKey(embeddingStatus), embeddingStatus.model)
    : createUnavailableEmbeddingPort(embeddingStatus.error ?? "Embeddings are unavailable.");
  const baseRecall = createRecallAdapter(database, embedding);
  const recall: RecallPorts = attachCrossEncoderPort(baseRecall, resolveCrossEncoder(config));
  let closed = false;

  return {
    dbPath,
    entries: database,
    episodes: database,
    procedures: database,
    memory: createMemoryRepository(database),
    recall,
    embeddingStatus: toPublicEmbeddingStatus(embeddingStatus),
    embedQuery: embeddingStatus.available
      ? async (text: string) => {
          const vectors = await embedding.embed([text]);
          return vectors[0] ?? [];
        }
      : undefined,
    async close(): Promise<void> {
      if (closed) {
        return;
      }

      closed = true;
      await database.close();
    },
  };
}

/**
 * Internal embedding status shape that includes the resolved API key.
 */
type ResolvedEmbeddingStatus = AgenrSkelnEmbeddingStatus & {
  /** Resolved provider credential. */
  apiKey?: string;
};

/**
 * Resolves config and database path overrides for the Skeln runtime.
 */
function resolveRuntimeConfig(options: CreateAgenrSkelnServicesOptions): { dbPath: string; config: AgenrConfig } {
  const databasePath = normalizeOptionalString(options.databasePath);
  const configPath = resolveConfigPath({
    configPath: normalizeOptionalString(options.configPath),
    dbPath: databasePath,
  });
  const loadedConfig = readConfig({
    configPath,
    dbPath: databasePath,
  });
  const dbPath = databasePath ?? resolveDbPath(loadedConfig);

  return {
    dbPath,
    config: {
      ...loadedConfig,
      dbPath,
    },
  };
}

/**
 * Resolves static embedding availability facts without a network probe.
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
 * Removes private credential fields from the public embedding status.
 */
function toPublicEmbeddingStatus(status: ResolvedEmbeddingStatus): AgenrSkelnEmbeddingStatus {
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
 */
function createUnavailableEmbeddingPort(errorMessage: string): EmbeddingPort {
  return {
    async embed(): Promise<number[][]> {
      throw new Error(errorMessage);
    },
  };
}

/**
 * Narrows resolved embedding status to the available branch with an API key.
 */
function requireApiKey(status: ResolvedEmbeddingStatus): string {
  if (!status.apiKey) {
    throw new Error("Embedding API key is unavailable.");
  }

  return status.apiKey;
}

/**
 * Best-effort construction of an OpenAI-backed cross-encoder port.
 */
function resolveCrossEncoder(config: AgenrConfig): CrossEncoderPort | undefined {
  try {
    const apiKey = resolveCrossEncoderApiKey(config);
    const { modelId } = resolveModel(config, "cross_encoder");
    return createOpenAICrossEncoder({ apiKey, model: modelId });
  } catch {
    return undefined;
  }
}

/**
 * Normalizes optional string values from host options.
 */
function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}
