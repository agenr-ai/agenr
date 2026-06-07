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
 * Most flags default to off and are persisted only when explicitly enabled.
 * `sessionTreeCompaction` defaults to on and is persisted only when explicitly
 * disabled.
 */
export type AgenrFeatureFlagConfig = Partial<Record<AgenrFeatureFlagKey, boolean>>;

/**
 * Fully resolved runtime feature flags.
 */
export type AgenrFeatureFlags = Record<AgenrFeatureFlagKey, boolean>;

/**
 * Default feature flags. Session-tree compaction is on by default; other staged
 * features remain off until explicitly enabled.
 */
const DEFAULT_AGENR_FEATURE_FLAGS: AgenrFeatureFlags = {
  workingMemory: false,
  sessionTreeLineage: false,
  sessionTreeCompaction: true,
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
 * Working-memory rollout flags for the ledger, agenr_work, context injection, and /goal surfaces.
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
