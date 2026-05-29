import type { LlmPort } from "../../core/ports.js";
import type { AgenrConfig } from "../../config.js";
import { resolveClaimExtractionConfig } from "../../config.js";
import { createLlmClient, resolveLlmApiKey, resolveModel } from "../llm.js";
import type { PluginClaimExtractionRuntime } from "../../app/plugin-runtime/types.js";

/**
 * Builds claim-extraction runtime when enabled and LLM credentials resolve.
 *
 * @param config - Agenr runtime configuration used for claim-extraction behavior.
 * @param resolveLlm - Host-specific LLM port factory.
 * @returns Claim-extraction runtime when available, otherwise `undefined`.
 */
export async function buildClaimExtractionRuntime(
  config: AgenrConfig,
  resolveLlm: () => Promise<LlmPort> | LlmPort,
): Promise<PluginClaimExtractionRuntime | undefined> {
  const claimExtractionConfig = resolveClaimExtractionConfig(config);
  if (!claimExtractionConfig.enabled) {
    return undefined;
  }

  try {
    return {
      llm: await resolveLlm(),
      config: claimExtractionConfig,
    };
  } catch {
    return undefined;
  }
}

/**
 * Resolves claim-extraction runtime using agenr config credentials.
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
