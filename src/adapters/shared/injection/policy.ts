import type { PluginInjectionMemoryPolicyConfig } from "../../../app/plugin-runtime/types.js";

/** Default session-start recall limits for host prompt injection. */
export const DEFAULT_SESSION_START_POLICY = {
  maxCoreEntries: 4,
  maxArtifactRecallEntries: 3,
  maxDurableEntries: 5,
  maxArtifactChars: 1_200,
} as const;

/** Default before-turn recall limits for host prompt injection. */
export const DEFAULT_BEFORE_TURN_POLICY = {
  maxDurableEntries: 1,
  maxHighConfidenceDurableEntries: 2,
  maxRecentTurns: 2,
  maxQueryChars: 450,
  maxProcedureCandidates: 3,
  recallThreshold: 0.6,
  highConfidenceRecallThreshold: 0.85,
  procedureThreshold: 0.72,
} as const;

/**
 * Resolves effective session-start policy from static defaults plus plugin overrides.
 *
 * @param memoryPolicy - Optional host memory-policy overrides.
 * @returns Effective session-start policy for one prompt build.
 */
export function resolveSessionStartPolicy(memoryPolicy?: PluginInjectionMemoryPolicyConfig) {
  return {
    ...DEFAULT_SESSION_START_POLICY,
    enableArtifactRecall: memoryPolicy?.sessionStart?.relevantDurableMemory !== false,
  };
}

/**
 * Resolves effective before-turn policy from static defaults plus plugin overrides.
 *
 * @param memoryPolicy - Optional host memory-policy overrides.
 * @returns Effective before-turn policy for one prompt build.
 */
export function resolveBeforeTurnPolicy(memoryPolicy?: PluginInjectionMemoryPolicyConfig) {
  return {
    ...DEFAULT_BEFORE_TURN_POLICY,
    enableProcedureSuggestion: memoryPolicy?.beforeTurn?.procedureSuggestion !== false,
    ...(memoryPolicy?.beforeTurn?.maxDurableEntries !== undefined ? { maxDurableEntries: memoryPolicy.beforeTurn.maxDurableEntries } : {}),
    ...(memoryPolicy?.beforeTurn?.recallThreshold !== undefined ? { recallThreshold: memoryPolicy.beforeTurn.recallThreshold } : {}),
    ...(memoryPolicy?.beforeTurn?.highConfidenceRecallThreshold !== undefined
      ? { highConfidenceRecallThreshold: memoryPolicy.beforeTurn.highConfidenceRecallThreshold }
      : {}),
    ...(memoryPolicy?.beforeTurn?.procedureThreshold !== undefined ? { procedureThreshold: memoryPolicy.beforeTurn.procedureThreshold } : {}),
  };
}
