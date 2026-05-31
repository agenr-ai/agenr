import { AGENR_FEATURE_FLAG_KEYS, DEFAULT_AGENR_FEATURE_FLAGS, type AgenrFeatureFlagConfig, type AgenrFeatureFlags } from "./types.js";

/**
 * Resolves sparse or partial feature-flag input into a full runtime record.
 *
 * @param features - Sparse config overrides, if any.
 * @returns Fully resolved feature flags with defaults applied.
 */
export function resolveAgenrFeatureFlags(features?: AgenrFeatureFlagConfig): AgenrFeatureFlags {
  const resolved = { ...DEFAULT_AGENR_FEATURE_FLAGS };

  for (const key of AGENR_FEATURE_FLAG_KEYS) {
    if (features?.[key] !== undefined) {
      resolved[key] = features[key];
    }
  }

  return resolved;
}
