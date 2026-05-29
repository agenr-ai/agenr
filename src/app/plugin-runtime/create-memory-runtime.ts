import type { CrossEncoderPort, EmbeddingPort } from "../../core/ports.js";
import type { AgenrConfig } from "../../config.js";
import { resolveClaimExtractionConfig } from "../../config.js";
import { createOpenAICrossEncoder, resolveCrossEncoderApiKey } from "../../adapters/cross-encoder/openai-cross-encoder.js";
import { createDatabase } from "../../adapters/db/client.js";
import { createMemoryRepository } from "../../adapters/db/memory-repository.js";
import { createSessionStartRepository } from "../../adapters/db/session-start-repository.js";
import { createRecallAdapter } from "../../adapters/db/recall-adapter.js";
import { createEmbeddingClient, EMBEDDING_MODEL, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../../adapters/embeddings.js";
import { createLlmClient, resolveLlmApiKey, resolveModel } from "../../adapters/llm.js";
import type { BeforeTurnDeps } from "../before-turn/index.js";
import { attachCrossEncoderPort } from "../evals/recall/attach-cross-encoder.js";
import type { PluginClaimExtractionRuntime, PluginClaimSlotPolicyConfig, PluginEmbeddingStatus, PluginMemoryRuntimeServices } from "./types.js";

export { EMBEDDING_MODEL };

/**
 * Internal embedding status shape that includes the resolved API key.
 */
type ResolvedEmbeddingStatus = PluginEmbeddingStatus & {
  apiKey?: string;
};

/**
 * Input used to compose shared host plugin memory services.
 */
export interface CreatePluginMemoryRuntimeInput {
  /** Resolved SQLite database path. */
  dbPath: string;
  /** Resolved agenr runtime configuration. */
  agenrConfig: AgenrConfig;
  /** Optional read-time slot-policy overrides for recall surfaces. */
  slotPolicies?: PluginClaimSlotPolicyConfig;
  /**
   * Host-specific claim-extraction wiring.
   *
   * Return `undefined` when claim extraction should stay disabled.
   */
  resolveClaimExtraction?: (config: AgenrConfig) => Promise<PluginClaimExtractionRuntime | undefined> | PluginClaimExtractionRuntime | undefined;
  /** Optional hook invoked before the database closes. */
  onBeforeClose?: () => Promise<void>;
}

/**
 * Creates the shared process-lifetime memory services used by host plugin runtimes.
 *
 * @param input - Resolved paths, config, and host-specific hooks.
 * @returns Shared memory services reused for the process lifetime.
 */
export async function createPluginMemoryRuntime(input: CreatePluginMemoryRuntimeInput): Promise<PluginMemoryRuntimeServices> {
  const embeddingStatus = resolveEmbeddingStatus(input.agenrConfig);
  const database = await createDatabase(input.dbPath);
  const embedding = embeddingStatus.available
    ? createEmbeddingClient(requireApiKey(embeddingStatus), embeddingStatus.model)
    : createUnavailableEmbeddingPort(embeddingStatus.error ?? "Embeddings are unavailable.");
  const baseRecall = createRecallAdapter(database, embedding);
  const recall = attachCrossEncoderPort(baseRecall, resolveCrossEncoder(input.agenrConfig));
  const claimExtraction = input.resolveClaimExtraction ? await input.resolveClaimExtraction(input.agenrConfig) : undefined;
  const slotPolicies = input.slotPolicies;
  let closed = false;

  return {
    entries: database,
    episodes: database,
    procedures: database,
    memory: createMemoryRepository(database, {
      claimSlotPolicyConfig: slotPolicies,
    }),
    sessionStart: {
      repository: createSessionStartRepository(database),
      recall,
      slotPolicyConfig: slotPolicies,
    },
    beforeTurn: {
      recall,
      procedures: database,
      embedQuery: createEmbedQuery(embedding, embeddingStatus.available),
      slotPolicyConfig: slotPolicies,
    },
    embedding,
    recall,
    claimExtraction,
    embeddingStatus: toPublicEmbeddingStatus(embeddingStatus),
    async close() {
      if (closed) {
        return;
      }

      closed = true;
      if (input.onBeforeClose) {
        await input.onBeforeClose();
      }

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
export function resolveEmbeddingStatus(config: AgenrConfig): ResolvedEmbeddingStatus {
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
export function toPublicEmbeddingStatus(status: ResolvedEmbeddingStatus): PluginEmbeddingStatus {
  return {
    available: status.available,
    provider: status.provider,
    requestedProvider: status.requestedProvider,
    model: status.model,
    ...(status.error ? { error: status.error } : {}),
  };
}

/**
 * Resolves an optional claim-extraction runtime using agenr config credentials.
 *
 * @param config - Agenr runtime configuration used for claim-extraction behavior.
 * @returns Claim-extraction runtime when available, otherwise `undefined`.
 */
export function createClaimExtractionFromAgenrConfig(config: AgenrConfig): PluginClaimExtractionRuntime | undefined {
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

/**
 * Creates a before-turn query embedder when embeddings are available.
 *
 * @param embedding - Embedding port used for query vectors.
 * @param available - Whether embedding credentials resolved successfully.
 * @returns Query embedder, or `undefined` when embeddings are unavailable.
 */
function createEmbedQuery(embedding: EmbeddingPort, available: boolean): BeforeTurnDeps["embedQuery"] {
  if (!available) {
    return undefined;
  }

  return async (text: string) => {
    const vectors = await embedding.embed([text]);
    return vectors[0] ?? [];
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
