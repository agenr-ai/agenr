import { composeHostPluginServices, createClaimExtractionFromAgenrConfig, EMBEDDING_MODEL } from "../../adapters/plugin-runtime/index.js";
import type { PluginInjectionMemoryPolicyConfig, PluginMemoryRuntimeServices, PluginPathConfig, ResolvedPluginPaths } from "../plugin-runtime/types.js";
import type { AgenrConfig } from "../../config.js";
import { resolveAgenrFeatureFlags } from "../features/resolve.js";
import { resolveRuntimePolicy, type RuntimePolicy } from "../features/runtime-policy.js";
import type { AgenrFeatureFlagConfig } from "../features/types.js";
import { createHostMemoryServices, type AgenrHostMemorySurface } from "../host-memory/create-host-memory-services.js";

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
  /** goals: true (default) enables full goal system /goal tools; false disables goals but keeps independent agenr_work session working set. */
  goals?: boolean;
  /** Optional Skeln host feature-flag overrides merged over agenr config features. */
  featureFlags?: AgenrFeatureFlagConfig;
}

/**
 * Shared Skeln runtime services composed outside the adapter package.
 */
export interface AgenrSkelnServices extends PluginMemoryRuntimeServices, AgenrHostMemorySurface {
  config: ResolvedPluginPaths;
  skelnConfig: AgenrSkelnConfig;
  agenrConfig: AgenrConfig;
  /** Derived runtime capabilities resolved once at startup. */
  capabilities: RuntimePolicy["capabilities"];
  /** Unified runtime policy resolved once at startup. */
  runtimePolicy: RuntimePolicy;
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
    extend: async ({ config: hostConfig, resolvedConfig, agenrConfig, runtimeServices }) => {
      const featureFlags = resolveAgenrFeatureFlags({
        ...agenrConfig.features,
        ...hostConfig.featureFlags,
      });
      const goalContinuationHostPort = undefined;
      const hostMemory = await createHostMemoryServices(featureFlags, {
        workingMemoryRepository: runtimeServices.workingMemoryRepository,
        sessionMemoryRepository: runtimeServices.sessionMemoryRepository,
        workingMemorySourceLabel: "skeln",
        goalWorkingSetsEnabled: hostConfig.goals ?? true,
        onForkSnapshotReadIssue: (failure) => {
          console.warn(`[agenr] session fork snapshot read issue (${failure.code}): ${failure.message}`);
        },
        goalContinuationHostPort,
      });
      const runtimePolicy = resolveRuntimePolicy(featureFlags, {
        workingMemoryRepository: runtimeServices.workingMemoryRepository,
        sessionMemoryRepository: runtimeServices.sessionMemoryRepository,
        memoryPolicy: hostConfig.memoryPolicy,
        goalContinuationHostPort,
      });

      return {
        ...runtimeServices,
        ...hostMemory,
        capabilities: runtimePolicy.capabilities,
        runtimePolicy,
        config: resolvedConfig,
        skelnConfig: hostConfig,
        agenrConfig,
      };
    },
  });
}
