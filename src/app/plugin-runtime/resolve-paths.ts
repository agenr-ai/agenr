import type { AgenrConfig } from "../../config.js";
import { readConfig, resolveConfigPath, resolveDbPath } from "../../config.js";
import type { PluginPathConfig, ResolvedPluginPaths } from "./types.js";

/**
 * Resolves plugin path overrides into concrete runtime paths before initialization.
 *
 * @param config - Raw plugin config supplied by a host adapter.
 * @param resolvePath - Optional host path resolver.
 * @returns Concrete runtime paths plus the agenr config loaded from disk.
 */
export function resolvePluginPaths(
  config: PluginPathConfig,
  resolvePath?: (input: string) => string,
): {
  resolvedConfig: ResolvedPluginPaths;
  agenrConfig: AgenrConfig;
} {
  const dbPathOverride = resolveOptionalPath(config.dbPath, resolvePath);
  const configPathOverride = resolveOptionalPath(config.configPath, resolvePath);
  const configPath = resolveConfigPath({
    configPath: configPathOverride,
    dbPath: dbPathOverride,
  });
  const agenrConfig = readConfig({
    configPath,
    dbPath: dbPathOverride,
  });
  const dbPath = dbPathOverride ?? resolveDbPath(agenrConfig);

  return {
    resolvedConfig: {
      dbPath,
      configPath,
    },
    agenrConfig,
  };
}

/**
 * Resolves plugin paths and returns agenr config with the resolved dbPath applied.
 *
 * @param config - Raw plugin config supplied by a host adapter.
 * @param resolvePath - Optional host path resolver.
 * @returns Concrete runtime paths plus merged agenr runtime config.
 */
export function resolvePluginRuntimeConfig(
  config: PluginPathConfig,
  resolvePath?: (input: string) => string,
): {
  resolvedConfig: ResolvedPluginPaths;
  agenrConfig: AgenrConfig;
} {
  const { resolvedConfig, agenrConfig } = resolvePluginPaths(config, resolvePath);
  return {
    resolvedConfig,
    agenrConfig: {
      ...agenrConfig,
      dbPath: resolvedConfig.dbPath,
    },
  };
}

/**
 * Resolves one optional plugin path using an optional host-provided resolver.
 *
 * @param value - Raw path override supplied in plugin config.
 * @param resolvePath - Optional host path resolver.
 * @returns Normalized path override, or `undefined` when unset.
 */
function resolveOptionalPath(value: string | undefined, resolvePath?: (input: string) => string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }

  return resolvePath ? resolvePath(normalized) : normalized;
}
