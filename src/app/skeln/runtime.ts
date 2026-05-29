import { createClaimExtractionFromAgenrConfig, createPluginMemoryRuntime, EMBEDDING_MODEL } from "../plugin-runtime/create-memory-runtime.js";
import { resolvePluginRuntimeConfig } from "../plugin-runtime/resolve-paths.js";
import type { PluginMemoryPolicyConfig, PluginMemoryRuntimeServices, ResolvedPluginPaths } from "../plugin-runtime/types.js";
import type { AgenrConfig } from "../../config.js";

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
  memoryPolicy?: PluginMemoryPolicyConfig;
}

/**
 * Shared Skeln runtime services composed outside the adapter package.
 */
export interface AgenrSkelnServices extends PluginMemoryRuntimeServices {
  config: ResolvedPluginPaths;
  skelnConfig: AgenrSkelnConfig;
  agenrConfig: AgenrConfig;
}

export { EMBEDDING_MODEL };

/**
 * Creates the shared Skeln runtime services used by the plugin process.
 *
 * @param config - Optional plugin config with path overrides and memory policy.
 * @returns Shared services reused for the process lifetime.
 */
export async function createAgenrSkelnServices(config: AgenrSkelnConfig = {}): Promise<AgenrSkelnServices> {
  const { resolvedConfig, agenrConfig } = resolvePluginRuntimeConfig(config);
  const runtimeServices = await createPluginMemoryRuntime({
    dbPath: resolvedConfig.dbPath,
    agenrConfig,
    slotPolicies: config.memoryPolicy?.slotPolicies,
    resolveClaimExtraction: createClaimExtractionFromAgenrConfig,
  });

  return {
    ...runtimeServices,
    config: resolvedConfig,
    skelnConfig: config,
    agenrConfig,
  };
}
