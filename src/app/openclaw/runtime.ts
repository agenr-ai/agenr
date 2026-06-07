import { createOpenClawLlmClient } from "../../adapters/openclaw/llm/openclaw-llm-client.js";
import type { AgenrOpenClawHost, AgenrOpenClawPluginConfig } from "./contract.js";
import { resolveDebugConfig, type ResolvedAgenrOpenClawDebugConfig } from "../../adapters/openclaw/config.js";
import { createAgenrDebugSink, createNoopAgenrDebugSink } from "../../adapters/openclaw/debug/index.js";
import type { OpenClawPluginDebugSink } from "./debug-sink.js";
import path from "node:path";
import { buildClaimExtractionRuntime, composeHostPluginServices, EMBEDDING_MODEL } from "../../adapters/plugin-runtime/index.js";
import { resolveAgenrFeatureFlags } from "../features/resolve.js";
import { createHostMemoryServices } from "../host-memory/create-host-memory-services.js";
import type { AgenrOpenClawServices } from "./types.js";

export type { AgenrOpenClawServices } from "./types.js";
export { EMBEDDING_MODEL };

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
  const debugSink = createDebugSink(options.openClaw, config);

  return composeHostPluginServices({
    config,
    resolvePath: options.resolvePath,
    readSlotPolicies: (hostConfig) => hostConfig.memoryPolicy?.slotPolicies,
    resolveClaimExtraction: ({ agenrConfig, hostConfig }) =>
      buildClaimExtractionRuntime(agenrConfig, () =>
        createOpenClawLlmClient(options.openClaw, hostConfig.claimExtractionModel, "claim extraction model override"),
      ),
    onBeforeClose: () => debugSink.close(),
    extend: ({ resolvedConfig, agenrConfig, runtimeServices }) => {
      const featureFlags = resolveAgenrFeatureFlags(agenrConfig.features);
      const hostMemory = createHostMemoryServices(featureFlags, {
        workingMemoryRepository: runtimeServices.workingMemoryRepository,
        sessionMemoryRepository: runtimeServices.sessionMemoryRepository,
        workingMemorySourceLabel: "openclaw",
      });

      return {
        ...runtimeServices,
        ...hostMemory,
        openClaw: options.openClaw,
        config: resolvedConfig,
        pluginConfig: config,
        agenrConfig,
        debugSink,
      };
    },
  });
}

/**
 * Creates the adapter-owned debug sink based on the plugin config.
 *
 * Resolves a default log path relative to the OpenClaw state dir when
 * the plugin config omits an explicit `debug.logPath`.
 *
 * @param openClaw - OpenClaw host used for state-dir resolution.
 * @param pluginConfig - Plugin config supplied by OpenClaw.
 * @returns Debug sink ready to accept structured events.
 */
function createDebugSink(openClaw: AgenrOpenClawHost, pluginConfig: AgenrOpenClawPluginConfig): OpenClawPluginDebugSink {
  const resolved = resolveDebugConfig(pluginConfig.debug);
  if (!resolved.enabled) {
    return createNoopAgenrDebugSink();
  }

  const withLogPath = ensureDebugLogPath(resolved, openClaw);
  return createAgenrDebugSink(withLogPath);
}

/**
 * Ensures the resolved debug config always has an absolute log-file path.
 *
 * @param resolved - Resolved debug config with an optional log path.
 * @param openClaw - OpenClaw host used for state-dir resolution.
 * @returns Resolved config with a concrete log path applied.
 */
function ensureDebugLogPath(resolved: ResolvedAgenrOpenClawDebugConfig, openClaw: AgenrOpenClawHost): ResolvedAgenrOpenClawDebugConfig {
  if (resolved.logPath) {
    return resolved;
  }

  try {
    const stateDir = openClaw.runtime.state.resolveStateDir(process.env);
    return {
      ...resolved,
      logPath: path.join(stateDir, "agenr", "logs", "debug.jsonl"),
    };
  } catch {
    return { ...resolved, enabled: false };
  }
}
