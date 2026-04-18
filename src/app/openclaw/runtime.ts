import type { CrossEncoderPort, DatabasePort, EmbeddingPort, EpisodeDatabasePort, LlmPort, ProcedureDatabasePort, RecallPorts } from "../../core/ports.js";
import type { AgenrConfig } from "../../config.js";
import { readConfig, resolveClaimExtractionConfig, resolveConfigPath, resolveDbPath } from "../../config.js";
import { createOpenAICrossEncoder, resolveCrossEncoderApiKey } from "../../adapters/cross-encoder/openai-cross-encoder.js";
import { createDatabase } from "../../adapters/db/client.js";
import { createOpenClawRepository } from "../../adapters/db/openclaw-repository.js";
import { createSessionStartRepository } from "../../adapters/db/session-start-repository.js";
import { createRecallAdapter } from "../../adapters/db/recall-adapter.js";
import { createEmbeddingClient, EMBEDDING_MODEL, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../../adapters/embeddings.js";
import { resolveModel } from "../../adapters/llm.js";
import { createOpenClawLlmClient } from "../../adapters/openclaw/llm/openclaw-llm-client.js";
import type {
  AgenrOpenClawEmbeddingStatus,
  AgenrOpenClawHost,
  AgenrOpenClawPluginConfig,
  AgenrOpenClawServices,
  ResolvedAgenrOpenClawPluginConfig,
} from "../../adapters/openclaw/types.js";
import type { OpenClawRepository } from "./ports.js";
import type { BeforeTurnDeps } from "../before-turn/index.js";
import type { SessionStartDeps } from "../session-start/index.js";

/**
 * Shared OpenClaw runtime services composed outside the adapter package.
 */
interface OpenClawRuntimeServices {
  entries: DatabasePort;
  episodes: EpisodeDatabasePort;
  procedures: ProcedureDatabasePort;
  memory: OpenClawRepository;
  sessionStart: SessionStartDeps;
  beforeTurn: BeforeTurnDeps;
  embedding: EmbeddingPort;
  recall: RecallPorts;
  claimExtraction?: {
    llm: LlmPort;
    config: ReturnType<typeof resolveClaimExtractionConfig>;
  };
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
  const runtimeServices = await createRuntimeServices(resolvedConfig.dbPath, agenrConfig, embeddingStatus, {
    openClaw: options.openClaw,
    pluginConfig: config,
  });

  return {
    openClaw: options.openClaw,
    config: resolvedConfig,
    pluginConfig: config,
    agenrConfig,
    dbPath: resolvedConfig.dbPath,
    entries: runtimeServices.entries,
    episodes: runtimeServices.episodes,
    procedures: runtimeServices.procedures,
    memory: runtimeServices.memory,
    sessionStart: runtimeServices.sessionStart,
    beforeTurn: runtimeServices.beforeTurn,
    embedding: runtimeServices.embedding,
    recall: runtimeServices.recall,
    claimExtraction: runtimeServices.claimExtraction,
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
 * @param config - Resolved agenr runtime configuration.
 * @param embeddingStatus - Resolved embedding availability facts.
 * @param openClawContext - OpenClaw runtime and plugin config used by claim extraction.
 * @returns Shared runtime services.
 */
async function createRuntimeServices(
  dbPath: string,
  config: AgenrConfig,
  embeddingStatus: ResolvedEmbeddingStatus,
  openClawContext: {
    openClaw: AgenrOpenClawHost;
    pluginConfig: AgenrOpenClawPluginConfig;
  },
): Promise<OpenClawRuntimeServices> {
  const database = await createDatabase(dbPath);
  const embedding = embeddingStatus.available
    ? createEmbeddingClient(requireApiKey(embeddingStatus), embeddingStatus.model)
    : createUnavailableEmbeddingPort(embeddingStatus.error ?? "Embeddings are unavailable.");
  const baseRecall = createRecallAdapter(database, embedding);
  const crossEncoder = resolveCrossEncoder(config);
  const recall: RecallPorts = crossEncoder ? { ...baseRecall, crossEncoder } : baseRecall;
  const claimExtraction = await createClaimExtractionRuntime(config, openClawContext.openClaw, openClawContext.pluginConfig);
  let closed = false;

  return {
    entries: database,
    episodes: database,
    procedures: database,
    memory: createOpenClawRepository(database, {
      claimSlotPolicyConfig: openClawContext.pluginConfig.memoryPolicy?.slotPolicies,
    }),
    sessionStart: {
      repository: createSessionStartRepository(database),
      recall,
      slotPolicyConfig: openClawContext.pluginConfig.memoryPolicy?.slotPolicies,
    },
    beforeTurn: {
      recall,
      procedures: database,
      embedQuery: embeddingStatus.available
        ? async (text: string) => {
            const vectors = await embedding.embed([text]);
            return vectors[0] ?? [];
          }
        : undefined,
      slotPolicyConfig: openClawContext.pluginConfig.memoryPolicy?.slotPolicies,
    },
    embedding,
    recall,
    claimExtraction,
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

/**
 * Best-effort construction of an OpenAI-backed cross-encoder port.
 *
 * The OpenClaw runtime wires the cross-encoder silently when an OpenAI
 * credential is available. Credential resolution failures leave the
 * rerank disabled rather than aborting plugin startup. The cross-encoder
 * model mirrors the convention used for other per-stage models: read the
 * `crossEncoderModel` override from agenr config through `resolveModel`,
 * with a stage default baked into the adapter.
 *
 * @param config - Resolved agenr configuration loaded for the plugin.
 * @returns Cross-encoder port when credentials are available.
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
 * Resolves an optional claim-extraction runtime using OpenClaw's auth system.
 *
 * Claim extraction behavior comes from agenr config. The model override and
 * credentials come from OpenClaw's plugin config and provider auth profiles.
 *
 * @param config - Agenr runtime configuration used for claim-extraction behavior.
 * @param openClaw - OpenClaw host runtime used for model-auth resolution.
 * @param pluginConfig - Plugin config with an optional claim-extraction model override.
 * @returns Claim-extraction runtime when available, otherwise `undefined`.
 */
async function createClaimExtractionRuntime(
  config: AgenrConfig,
  openClaw: AgenrOpenClawHost,
  pluginConfig: AgenrOpenClawPluginConfig,
): Promise<OpenClawRuntimeServices["claimExtraction"]> {
  const claimExtractionConfig = resolveClaimExtractionConfig(config);
  if (!claimExtractionConfig.enabled) {
    return undefined;
  }

  try {
    return {
      llm: await createOpenClawLlmClient(openClaw, pluginConfig.claimExtractionModel, "claim extraction model override"),
      config: claimExtractionConfig,
    };
  } catch {
    return undefined;
  }
}
