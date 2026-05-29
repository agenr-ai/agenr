import { composeHostPluginServices, createClaimExtractionFromAgenrConfig, EMBEDDING_MODEL } from "../../adapters/plugin-runtime/index.js";
import type { PluginInjectionMemoryPolicyConfig, PluginMemoryRuntimeServices, PluginPathConfig, ResolvedPluginPaths } from "../plugin-runtime/types.js";
import type { AgenrConfig } from "../../config.js";

/**
 * Runtime configuration accepted by the agenr Skeln adapter.
 *
 * Infrastructure fields point the plugin at the shared agenr database and
 * config file on disk. Embeddings and claim extraction resolve from agenr
 * config credentials, not Skeln host auth.
 */
export interface AgenrSkelnConfig extends PluginPathConfig {
  /** Narrow runtime memory-policy overrides for claim-aware read surfaces. */
  memoryPolicy?: PluginInjectionMemoryPolicyConfig;
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
  return composeHostPluginServices({
    config,
    readSlotPolicies: (hostConfig) => hostConfig.memoryPolicy?.slotPolicies,
    resolveClaimExtraction: ({ agenrConfig }) => createClaimExtractionFromAgenrConfig(agenrConfig),
    extend: ({ config: hostConfig, resolvedConfig, agenrConfig, runtimeServices }) => ({
      ...runtimeServices,
      config: resolvedConfig,
      skelnConfig: hostConfig,
      agenrConfig,
    }),
  });
}
