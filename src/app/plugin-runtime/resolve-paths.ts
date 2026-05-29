import type { AgenrConfig } from "../../config.js";
import { readConfig, resolveConfigPath, resolveDbPath } from "../../config.js";
import type { PluginPathConfig, ResolvedPluginPaths } from "./types.js";

/**
 * Resolves plugin path overrides into concrete runtime paths and merged agenr config.
 *
 * @param config - Raw plugin config supplied by a host adapter.
 * @param resolvePath - Optional host path resolver.
 * @returns Concrete runtime paths plus agenr config with the resolved dbPath applied.
 */
export function resolvePluginRuntimeConfig(
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
  const loadedConfig = readConfig({
    configPath,
    dbPath: dbPathOverride,
  });
  const dbPath = dbPathOverride ?? resolveDbPath(loadedConfig);

  return {
    resolvedConfig: {
      dbPath,
      configPath,
    },
    agenrConfig: {
      ...loadedConfig,
      dbPath,
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
