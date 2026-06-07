import type { PluginInjectionMemoryPolicyConfig } from "../../app/plugin-runtime/types.js";

/**
 * Returns whether automatic host episode writes are enabled.
 *
 * Episode writes default to on unless `memoryPolicy.episodes.enabled` is explicitly false.
 *
 * @param memoryPolicy - Resolved plugin memory policy, if any.
 * @returns True when episode writes should run.
 */
export function isPluginEpisodeWriteEnabled(memoryPolicy?: PluginInjectionMemoryPolicyConfig): boolean {
  return memoryPolicy?.episodes?.enabled !== false;
}
