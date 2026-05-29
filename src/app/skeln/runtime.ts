import type { AgenrConfig } from "../../config.js";
import type { DatabasePort, EmbeddingPort, EpisodeDatabasePort, LlmPort, ProcedureDatabasePort, RecallPorts } from "../../core/ports.js";
import type { ClaimExtractionConfig } from "../../core/store/claim-extraction.js";
import type { BeforeTurnDeps } from "../before-turn/index.js";
import type { MemoryRepository } from "../memory/ports.js";
import { createClaimExtractionFromAgenrConfig, createPluginMemoryRuntime, EMBEDDING_MODEL } from "../plugin-runtime/create-memory-runtime.js";
import { resolvePluginPaths } from "../plugin-runtime/resolve-paths.js";
import type { PluginClaimSlotPolicyConfig, PluginEmbeddingStatus, PluginMemoryPolicyConfig, ResolvedPluginPaths } from "../plugin-runtime/types.js";
import type { SessionStartDeps } from "../session-start/index.js";

/**
 * Slot-policy overrides that the Skeln adapter can apply at runtime.
 */
export type AgenrSkelnClaimSlotPolicyConfig = PluginClaimSlotPolicyConfig;

/**
 * Narrow memory-policy settings exposed through the Skeln plugin config.
 */
export type AgenrSkelnMemoryPolicyConfig = PluginMemoryPolicyConfig;

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
export type ResolvedAgenrSkelnConfig = ResolvedPluginPaths;

/**
 * Static embedding availability facts derived from agenr configuration.
 */
export type AgenrSkelnEmbeddingStatus = PluginEmbeddingStatus;

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

export { EMBEDDING_MODEL };

/**
 * Creates the shared Skeln runtime services used by the plugin process.
 *
 * @param config - Optional plugin config with path overrides and memory policy.
 * @returns Shared services reused for the process lifetime.
 */
export async function createAgenrSkelnServices(config: AgenrSkelnConfig = {}): Promise<AgenrSkelnServices> {
  const { resolvedConfig, agenrConfig: loadedAgenrConfig } = resolvePluginPaths(config);
  const agenrConfig: AgenrConfig = {
    ...loadedAgenrConfig,
    dbPath: resolvedConfig.dbPath,
  };
  const runtimeServices = await createPluginMemoryRuntime({
    dbPath: resolvedConfig.dbPath,
    agenrConfig,
    slotPolicies: config.memoryPolicy?.slotPolicies,
    resolveClaimExtraction: createClaimExtractionFromAgenrConfig,
  });

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
    embeddingStatus: runtimeServices.embeddingStatus,
    close: runtimeServices.close,
  };
}
