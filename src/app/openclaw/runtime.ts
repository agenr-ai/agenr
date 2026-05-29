import type { AgenrConfig } from "../../config.js";
import { resolveClaimExtractionConfig } from "../../config.js";
import { createOpenClawLlmClient } from "../../adapters/openclaw/llm/openclaw-llm-client.js";
import { resolveDebugConfig, type ResolvedAgenrOpenClawDebugConfig } from "../../adapters/openclaw/config.js";
import { createAgenrDebugSink, createNoopAgenrDebugSink, type AgenrDebugSink } from "../../adapters/openclaw/debug/index.js";
import type { AgenrOpenClawHost, AgenrOpenClawPluginConfig, AgenrOpenClawServices } from "../../adapters/openclaw/types.js";
import path from "node:path";
import { createPluginMemoryRuntime, EMBEDDING_MODEL } from "../plugin-runtime/create-memory-runtime.js";
import { resolvePluginPaths } from "../plugin-runtime/resolve-paths.js";

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
  const { resolvedConfig, agenrConfig: loadedAgenrConfig } = resolvePluginPaths(config, options.resolvePath);
  const agenrConfig: AgenrConfig = {
    ...loadedAgenrConfig,
    dbPath: resolvedConfig.dbPath,
  };
  const debugSink = createDebugSink(options.openClaw, config);
  const runtimeServices = await createPluginMemoryRuntime({
    dbPath: resolvedConfig.dbPath,
    agenrConfig,
    slotPolicies: config.memoryPolicy?.slotPolicies,
    resolveClaimExtraction: (runtimeConfig) => createClaimExtractionFromOpenClaw(runtimeConfig, options.openClaw, config),
    onBeforeClose: () => debugSink.close(),
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
    embeddingStatus: runtimeServices.embeddingStatus,
    debugSink,
    close: runtimeServices.close,
  };
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
function createDebugSink(openClaw: AgenrOpenClawHost, pluginConfig: AgenrOpenClawPluginConfig): AgenrDebugSink {
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
async function createClaimExtractionFromOpenClaw(
  config: AgenrConfig,
  openClaw: AgenrOpenClawHost,
  pluginConfig: AgenrOpenClawPluginConfig,
): Promise<AgenrOpenClawServices["claimExtraction"]> {
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
