import type { AgenrConfig } from "../../config.js";
import { resolvePluginRuntimeConfig } from "../../app/plugin-runtime/resolve-paths.js";
import type { ResolveClaimExtractionContext } from "../../app/plugin-runtime/ports.js";
import type {
  PluginClaimExtractionRuntime,
  PluginInjectionMemoryPolicyConfig,
  PluginMemoryRuntimeServices,
  PluginPathConfig,
  ResolvedPluginPaths,
} from "../../app/plugin-runtime/types.js";
import { createPluginMemoryRuntime } from "./create-memory-runtime.js";

/**
 * Input used to compose host-specific plugin services on top of shared memory runtime.
 */
export interface ComposeHostPluginServicesInput<TConfig extends PluginPathConfig, TResult> {
  /** Raw host plugin config with optional path overrides. */
  config: TConfig;
  /** Optional host path resolver. */
  resolvePath?: (input: string) => string;
  /** Reads slot-policy overrides from host config. */
  readSlotPolicies?: (config: TConfig) => PluginInjectionMemoryPolicyConfig["slotPolicies"] | undefined;
  /** Host-specific claim-extraction wiring. */
  resolveClaimExtraction?: (
    ctx: ResolveClaimExtractionContext<TConfig>,
  ) => Promise<PluginClaimExtractionRuntime | undefined> | PluginClaimExtractionRuntime | undefined;
  /** Optional hook invoked before the database closes. */
  onBeforeClose?: () => Promise<void>;
  /** Host-specific service envelope builder. */
  extend: (ctx: { config: TConfig; resolvedConfig: ResolvedPluginPaths; agenrConfig: AgenrConfig; runtimeServices: PluginMemoryRuntimeServices }) => TResult;
}

/**
 * Composes shared plugin memory services and host-specific runtime envelopes.
 *
 * @param input - Host config, optional hooks, and envelope builder.
 * @returns Host-specific services reused for the process lifetime.
 */
export async function composeHostPluginServices<TConfig extends PluginPathConfig, TResult>(
  input: ComposeHostPluginServicesInput<TConfig, TResult>,
): Promise<TResult> {
  const { resolvedConfig, agenrConfig } = resolvePluginRuntimeConfig(input.config, input.resolvePath);
  const claimExtraction = input.resolveClaimExtraction ? await input.resolveClaimExtraction({ agenrConfig, hostConfig: input.config }) : undefined;
  const runtimeServices = await createPluginMemoryRuntime({
    dbPath: resolvedConfig.dbPath,
    agenrConfig,
    slotPolicies: input.readSlotPolicies?.(input.config),
    claimExtraction,
    onBeforeClose: input.onBeforeClose,
  });

  return input.extend({
    config: input.config,
    resolvedConfig,
    agenrConfig,
    runtimeServices,
  });
}
