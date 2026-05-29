import type { CrossEncoderPort, DatabasePort, EmbeddingPort, EpisodeDatabasePort, LlmPort, ProcedureDatabasePort, RecallPorts } from "../../core/ports.js";
import type { AgenrConfig } from "../../config.js";
import { readConfig, resolveClaimExtractionConfig, resolveConfigPath, resolveDbPath } from "../../config.js";
import { createOpenAICrossEncoder, resolveCrossEncoderApiKey } from "../../adapters/cross-encoder/openai-cross-encoder.js";
import { createDatabase } from "../../adapters/db/client.js";
import { createMemoryRepository } from "../../adapters/db/memory-repository.js";
import { createSessionStartRepository } from "../../adapters/db/session-start-repository.js";
import { createRecallAdapter } from "../../adapters/db/recall-adapter.js";
import { createEmbeddingClient, EMBEDDING_MODEL, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../../adapters/embeddings.js";
import { createLlmClient, resolveLlmApiKey, resolveModel } from "../../adapters/llm.js";
import type { ClaimSlotPolicy, ClaimSlotPolicyConfig } from "../../core/claim-slot-policy.js";
import type { ClaimExtractionConfig } from "../../core/store/claim-extraction.js";
import type { MemoryRepository } from "../memory/ports.js";
import type { BeforeTurnDeps } from "../before-turn/index.js";
import { attachCrossEncoderPort } from "../evals/recall/attach-cross-encoder.js";
import type { SessionStartDeps } from "../session-start/index.js";

/**
 * Slot-policy overrides that the Skeln adapter can apply at runtime.
 */
export interface AgenrSkelnClaimSlotPolicyConfig extends ClaimSlotPolicyConfig {
  /** Optional attribute-head policy overrides keyed by canonical attribute head. */
  attributeHeads?: Readonly<Record<string, ClaimSlotPolicy>>;
}

/**
 * Narrow memory-policy settings exposed through the Skeln plugin config.
 */
export interface AgenrSkelnMemoryPolicyConfig {
  /** Read-time slot-policy overrides used by recall surfaces. */
  slotPolicies?: AgenrSkelnClaimSlotPolicyConfig;
}

/**
 * Runtime configuration accepted by the agenr Skeln adapter.
 *
 * Infrastructure fields point the plugin at the shared agenr database and
 * config file on disk. Embeddings and claim extraction resolve from agenr
 * config credentials, not Skeln host auth.
 */
export interface AgenrSkelnConfig {
  /** Path to the shared agenr SQLite database. */
  dbPath?: string;
  /** Path to the agenr config.json file. */
  configPath?: string;
  /** Narrow runtime memory-policy overrides for claim-aware read surfaces. */
  memoryPolicy?: AgenrSkelnMemoryPolicyConfig;
}

/**
 * Concrete runtime paths derived from plugin config and agenr defaults.
 */
export interface ResolvedAgenrSkelnConfig {
  dbPath: string;
  configPath: string;
}

/**
 * Static embedding availability facts derived from agenr configuration.
 */
export interface AgenrSkelnEmbeddingStatus {
  available: boolean;
  provider: string;
  requestedProvider: string;
  model: string;
  error?: string;
}

/**
 * Shared Skeln runtime services composed outside the adapter package.
 */
export interface AgenrSkelnServices {
  config: ResolvedAgenrSkelnConfig;
  skelnConfig: AgenrSkelnConfig;
  agenrConfig: AgenrConfig;
  dbPath: string;
  entries: DatabasePort;
  episodes: EpisodeDatabasePort;
  procedures: ProcedureDatabasePort;
  memory: MemoryRepository;
  sessionStart: SessionStartDeps;
  beforeTurn: BeforeTurnDeps;
  embedding: EmbeddingPort;
  recall: RecallPorts;
  claimExtraction?: {
    llm: LlmPort;
    config: ClaimExtractionConfig;
  };
  embeddingStatus: AgenrSkelnEmbeddingStatus;
  close(): Promise<void>;
}

/**
 * Internal embedding status shape that includes the resolved API key.
 */
type ResolvedEmbeddingStatus = AgenrSkelnEmbeddingStatus & {
  apiKey?: string;
};

/**
 * Internal process-lifetime runtime services used by the Skeln composition layer.
 */
interface SkelnRuntimeServices {
  entries: DatabasePort;
  episodes: EpisodeDatabasePort;
  procedures: ProcedureDatabasePort;
  memory: MemoryRepository;
  sessionStart: SessionStartDeps;
  beforeTurn: BeforeTurnDeps;
  embedding: EmbeddingPort;
  recall: RecallPorts;
  claimExtraction?: AgenrSkelnServices["claimExtraction"];
  close(): Promise<void>;
}

/**
 * Creates the shared Skeln runtime services used by the plugin process.
 *
 * @param config - Optional plugin config with path overrides and memory policy.
 * @returns Shared services reused for the process lifetime.
 */
export async function createAgenrSkelnServices(config: AgenrSkelnConfig = {}): Promise<AgenrSkelnServices> {
  const { resolvedConfig, agenrConfig: loadedAgenrConfig } = resolveRuntimeConfig(config);
  const agenrConfig: AgenrConfig = {
    ...loadedAgenrConfig,
    dbPath: resolvedConfig.dbPath,
  };
  const embeddingStatus = resolveEmbeddingStatus(agenrConfig);
  const runtimeServices = await createRuntimeServices(resolvedConfig.dbPath, agenrConfig, embeddingStatus, config);

  return {
    config: resolvedConfig,
    skelnConfig: config,
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
 * Builds the process-lifetime runtime services used by the Skeln adapter.
 *
 * @param dbPath - Resolved SQLite path.
 * @param config - Resolved agenr runtime configuration.
 * @param embeddingStatus - Resolved embedding availability facts.
 * @param skelnConfig - Skeln plugin config used for memory-policy overrides.
 * @returns Shared runtime services.
 */
async function createRuntimeServices(
  dbPath: string,
  config: AgenrConfig,
  embeddingStatus: ResolvedEmbeddingStatus,
  skelnConfig: AgenrSkelnConfig,
): Promise<SkelnRuntimeServices> {
  const database = await createDatabase(dbPath);
  const embedding = embeddingStatus.available
    ? createEmbeddingClient(requireApiKey(embeddingStatus), embeddingStatus.model)
    : createUnavailableEmbeddingPort(embeddingStatus.error ?? "Embeddings are unavailable.");
  const baseRecall = createRecallAdapter(database, embedding);
  const crossEncoder = resolveCrossEncoder(config);
  const recall: RecallPorts = attachCrossEncoderPort(baseRecall, crossEncoder);
  const claimExtraction = createClaimExtractionRuntime(config);
  let closed = false;

  return {
    entries: database,
    episodes: database,
    procedures: database,
    memory: createMemoryRepository(database, {
      claimSlotPolicyConfig: skelnConfig.memoryPolicy?.slotPolicies,
    }),
    sessionStart: {
      repository: createSessionStartRepository(database),
      recall,
      slotPolicyConfig: skelnConfig.memoryPolicy?.slotPolicies,
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
      slotPolicyConfig: skelnConfig.memoryPolicy?.slotPolicies,
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
 * Resolves the configured embedding provider and model without a network probe.
 *
 * @param config - Agenr runtime configuration.
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
 * Hides private embedding credentials from the public runtime status object.
 *
 * @param status - Internal embedding status that may include secrets.
 * @returns Public embedding status safe to share with runtime consumers.
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
 * @param config - Raw plugin config supplied by Skeln.
 * @returns Concrete runtime config plus the agenr config loaded from disk.
 */
function resolveRuntimeConfig(config: AgenrSkelnConfig): {
  resolvedConfig: ResolvedAgenrSkelnConfig;
  agenrConfig: AgenrConfig;
} {
  const dbPathOverride = resolveOptionalPath(config.dbPath);
  const configPathOverride = resolveOptionalPath(config.configPath);
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
 * Resolves one optional plugin path override.
 *
 * @param value - Raw path override supplied in plugin config.
 * @returns Normalized path override, or `undefined` when unset.
 */
function resolveOptionalPath(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }

  return normalized;
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
 * Resolves an optional claim-extraction runtime using agenr config credentials.
 *
 * @param config - Agenr runtime configuration used for claim-extraction behavior.
 * @returns Claim-extraction runtime when available, otherwise `undefined`.
 */
function createClaimExtractionRuntime(config: AgenrConfig): SkelnRuntimeServices["claimExtraction"] {
  const claimExtractionConfig = resolveClaimExtractionConfig(config);
  if (!claimExtractionConfig.enabled) {
    return undefined;
  }

  try {
    const { provider, modelId } = resolveModel(config, "claim");
    const apiKey = resolveLlmApiKey(config, provider);
    return {
      llm: createLlmClient(provider, modelId, { apiKey }),
      config: claimExtractionConfig,
    };
  } catch {
    return undefined;
  }
}
