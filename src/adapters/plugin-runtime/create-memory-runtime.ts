import type { CrossEncoderPort, EmbeddingPort } from "../../core/ports.js";
import type { AgenrConfig } from "../../config.js";
import { createOpenAICrossEncoder, resolveCrossEncoderApiKey } from "../cross-encoder/openai-cross-encoder.js";
import { createDatabase } from "../db/client.js";
import { createDreamPort } from "../db/dreaming-port.js";
import { listActiveAbstainDirectives, listActiveSessionStartProactiveDirectives, listActiveTopicProactiveDirectives } from "../db/directives-repository.js";
import { createMemoryRepository } from "../db/memory-repository.js";
import { createSessionMemoryRepository } from "../db/session-memory-repository.js";
import { createSessionStartRepository } from "../db/session-start-repository.js";
import { createWorkingMemoryRepository } from "../db/working-memory-repository.js";
import { createRecallAdapter } from "../db/recall-adapter.js";
import { createEmbeddingClient, EMBEDDING_MODEL, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../embeddings.js";
import { resolveModel } from "../llm.js";
import type { CreatePluginMemoryRuntimeInput, PluginMemoryRuntimeFactoryPort } from "../../app/plugin-runtime/ports.js";
import type { PluginEmbeddingStatus, PluginMemoryRuntimeServices } from "../../app/plugin-runtime/types.js";
import { attachCrossEncoderPort } from "./attach-cross-encoder.js";
import { createEmbedQuery } from "./embed-query.js";

export { EMBEDDING_MODEL, pluginMemoryRuntimeFactory };

/**
 * Internal embedding status shape that includes the resolved API key.
 */
type ResolvedEmbeddingStatus = PluginEmbeddingStatus & {
  apiKey?: string;
};

/**
 * Adapter-owned factory that composes process-lifetime plugin memory services.
 */
const pluginMemoryRuntimeFactory: PluginMemoryRuntimeFactoryPort = {
  createPluginMemoryRuntime,
};

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
  const slotPolicies = input.slotPolicies;
  const fetchActiveAbstainDirectives = (): Promise<Awaited<ReturnType<typeof listActiveAbstainDirectives>>> => listActiveAbstainDirectives(database);
  const fetchSessionStartProactiveDirectives = (): Promise<Awaited<ReturnType<typeof listActiveSessionStartProactiveDirectives>>> =>
    listActiveSessionStartProactiveDirectives(database);
  const fetchTopicProactiveDirectives = (): Promise<Awaited<ReturnType<typeof listActiveTopicProactiveDirectives>>> =>
    listActiveTopicProactiveDirectives(database);
  const sessionMemoryRepository = createSessionMemoryRepository(database);
  let closed = false;

  return {
    entries: database,
    episodes: database,
    procedures: database,
    memory: createMemoryRepository(database, {
      claimSlotPolicyConfig: slotPolicies,
    }),
    dreaming: createDreamPort(database),
    workingMemoryRepository: createWorkingMemoryRepository(database),
    sessionMemoryRepository,
    sessionStart: {
      repository: createSessionStartRepository(database),
      recall,
      slotPolicyConfig: slotPolicies,
      listActiveAbstainDirectives: fetchActiveAbstainDirectives,
      listActiveProactiveDirectives: fetchSessionStartProactiveDirectives,
      sessionMemoryRepository,
    },
    beforeTurn: {
      recall,
      procedures: database,
      embedQuery: createEmbedQuery(embedding, embeddingStatus.available),
      slotPolicyConfig: slotPolicies,
      listActiveAbstainDirectives: fetchActiveAbstainDirectives,
      listActiveTopicProactiveDirectives: fetchTopicProactiveDirectives,
    },
    embedding,
    recall,
    claimExtraction: input.claimExtraction,
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
function toPublicEmbeddingStatus(status: ResolvedEmbeddingStatus): PluginEmbeddingStatus {
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
