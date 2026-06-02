/**
 * Canonical feature flags for staged working-memory, session-memory, and goal rollout.
 */

/**
 * Feature-flag keys supported across agenr config and app services.
 */
const AGENR_FEATURE_FLAG_KEYS = ["workingMemory", "sessionTreeLineage", "sessionTreeCompaction", "goalContinuation"] as const;

/**
 * Union of feature-flag keys supported by agenr config.
 */
export type AgenrFeatureFlagKey = (typeof AGENR_FEATURE_FLAG_KEYS)[number];

/**
 * Sparse persisted feature-flag overrides.
 *
 * Only `true` values are written to disk. Explicit `false` is accepted during
 * parse and reflected in resolved runtime flags, but canonicalization strips
 * false entries because every flag defaults to off.
 */
export type AgenrFeatureFlagConfig = Partial<Record<AgenrFeatureFlagKey, boolean>>;

/**
 * Fully resolved runtime feature flags.
 */
export type AgenrFeatureFlags = Record<AgenrFeatureFlagKey, boolean>;

/**
 * Default feature flags. Every staged feature is off in Phase 0.
 */
const DEFAULT_AGENR_FEATURE_FLAGS: AgenrFeatureFlags = {
  workingMemory: false,
  sessionTreeLineage: false,
  sessionTreeCompaction: false,
  goalContinuation: false,
};

/**
 * Returns a persisted feature-flag block with every known flag enabled.
 *
 * Used by first-run init so `config.json` explicitly records the full feature
 * surface instead of relying on implicit defaults.
 *
 * @returns Sparse persisted shape with every flag set to `true`.
 */
export function createAllEnabledFeatureFlagConfig(): AgenrFeatureFlagConfig {
  return Object.fromEntries(AGENR_FEATURE_FLAG_KEYS.map((key) => [key, true])) as AgenrFeatureFlagConfig;
}

/**
 * Working-memory rollout flags for the ledger, agenr_work, and /goal surfaces.
 * Automatic per-turn injection is controlled separately by memoryPolicy.workingContext.
 */
export type WorkingMemoryFeatureFlags = Pick<AgenrFeatureFlags, "workingMemory">;

/**
 * Session-memory rollout flags consumed by the Phase 0 trigger router.
 */
export type SessionMemoryFeatureFlags = Pick<AgenrFeatureFlags, "sessionTreeLineage" | "sessionTreeCompaction">;

/**
 * Goal continuation rollout flags consumed by the Phase 0 goal stub.
 */
export type GoalContinuationFeatureFlags = Pick<AgenrFeatureFlags, "goalContinuation">;

export { AGENR_FEATURE_FLAG_KEYS, DEFAULT_AGENR_FEATURE_FLAGS };
