import type { DatabasePort, EmbeddingPort, EpisodeDatabasePort, RecallPorts } from "../../core/ports.js";
import type { AgenrConfig } from "../../config.js";
import { readConfig, resolveConfigPath, resolveDbPath } from "../../config.js";
import { createDatabase } from "../../adapters/db/client.js";
import { createOpenClawRepository } from "../../adapters/db/openclaw-repository.js";
import { createRecallAdapter } from "../../adapters/db/recall-adapter.js";
import { createEmbeddingClient, EMBEDDING_MODEL, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../../adapters/embeddings.js";
import type {
  AgenrOpenClawEmbeddingStatus,
  AgenrOpenClawHost,
  AgenrOpenClawPluginConfig,
  AgenrOpenClawServices,
  ResolvedAgenrOpenClawPluginConfig,
} from "../../adapters/openclaw/types.js";
import type { OpenClawRepository } from "./ports.js";

/**
 * Shared OpenClaw runtime services composed outside the adapter package.
 */
interface OpenClawRuntimeServices {
  entries: DatabasePort;
  episodes: EpisodeDatabasePort;
  memory: OpenClawRepository;
  embedding: EmbeddingPort;
  recall: RecallPorts;
  close(): Promise<void>;
}

/**
 * Creates the shared OpenClaw runtime services used by the plugin process.
 *
 * @param config - Normalized plugin config supplied by OpenClaw.
 * @param options - Host runtime and optional path-resolution hooks.
 * @returns Shared services reused for the process lifetime.
 */
export async function createAgenrOpenClawServices(
  config: AgenrOpenClawPluginConfig,
  options: {
    openClaw: AgenrOpenClawHost;
    resolvePath?: (input: string) => string;
  },
): Promise<AgenrOpenClawServices> {
  const { resolvedConfig, agenrConfig: loadedAgenrConfig } = resolveRuntimeConfig(config, options.resolvePath);
  const agenrConfig: AgenrConfig = {
    ...loadedAgenrConfig,
    dbPath: resolvedConfig.dbPath,
  };
  const embeddingStatus = resolveEmbeddingStatus(agenrConfig);
  const runtimeServices = await createRuntimeServices(resolvedConfig.dbPath, embeddingStatus);

  return {
    openClaw: options.openClaw,
    config: resolvedConfig,
    pluginConfig: config,
    agenrConfig,
    dbPath: resolvedConfig.dbPath,
    entries: runtimeServices.entries,
    episodes: runtimeServices.episodes,
    memory: runtimeServices.memory,
    embedding: runtimeServices.embedding,
    recall: runtimeServices.recall,
    embeddingStatus: toPublicEmbeddingStatus(embeddingStatus),
    close: runtimeServices.close,
  };
}

/**
 * Internal embedding status shape that includes the resolved API key.
 */
type ResolvedEmbeddingStatus = AgenrOpenClawEmbeddingStatus & {
  apiKey?: string;
};

/**
 * Resolves the configured embedding provider and model without a network probe.
 *
 * @param config - Agenr-compatible plugin configuration.
 * @returns Static embedding availability facts used by the runtime.
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
 * Builds the process-lifetime runtime services used by the OpenClaw adapter.
 *
 * @param dbPath - Resolved SQLite path.
 * @param embeddingStatus - Resolved embedding availability facts.
 * @returns Shared runtime services.
 */
async function createRuntimeServices(dbPath: string, embeddingStatus: ResolvedEmbeddingStatus): Promise<OpenClawRuntimeServices> {
  const database = await createDatabase(dbPath);
  const embedding = embeddingStatus.available
    ? createEmbeddingClient(requireApiKey(embeddingStatus), embeddingStatus.model)
    : createUnavailableEmbeddingPort(embeddingStatus.error ?? "Embeddings are unavailable.");
  let closed = false;

  return {
    entries: database,
    episodes: database,
    memory: createOpenClawRepository(database),
    embedding,
    recall: createRecallAdapter(database, embedding),
    async close() {
      if (closed) {
        return;
      }

      closed = true;
      await database.close();
    },
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
 * Resolves plugin overrides into concrete runtime paths before initialization.
 *
 * @param config - Raw plugin config supplied by OpenClaw.
 * @param resolvePath - Optional OpenClaw path resolver.
 * @returns Concrete runtime config plus the agenr config loaded from disk.
 */
function resolveRuntimeConfig(
  config: AgenrOpenClawPluginConfig,
  resolvePath?: (input: string) => string,
): {
  resolvedConfig: ResolvedAgenrOpenClawPluginConfig;
  agenrConfig: AgenrConfig;
} {
  const dbPathOverride = resolveOptionalPath(config.dbPath, resolvePath);
  const configPathOverride = resolveOptionalPath(config.configPath, resolvePath);
  const configPath = resolveConfigPath({
    configPath: configPathOverride,
    dbPath: dbPathOverride,
  });
  const agenrConfig = readConfig({
    configPath,
    dbPath: dbPathOverride,
  });
  const dbPath = dbPathOverride ?? resolveDbPath(agenrConfig);

  return {
    resolvedConfig: {
      dbPath,
      configPath,
    },
    agenrConfig,
  };
}

/**
 * Resolves one optional plugin path using the host-provided resolver.
 *
 * @param value - Raw path override supplied in plugin config.
 * @param resolvePath - Optional OpenClaw path resolver.
 * @returns Normalized path override, or `undefined` when unset.
 */
function resolveOptionalPath(value: string | undefined, resolvePath?: (input: string) => string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }

  return resolvePath ? resolvePath(normalized) : normalized;
}

/**
 * Narrows resolved embedding status to the available branch with an API key.
 *
 * @param status - Resolved embedding status.
 * @returns Stable API key for the configured embedding provider.
 */
function requireApiKey(status: ResolvedEmbeddingStatus): string {
  if (!status.apiKey) {
    throw new Error("Embedding API key is unavailable.");
  }

  return status.apiKey;
}
