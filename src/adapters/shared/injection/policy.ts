import type { RuntimeCapabilityState } from "../../../app/features/capabilities.js";
import type { WorkingMemoryFeatureFlags } from "../../../app/features/types.js";
import type { PluginInjectionMemoryPolicyConfig } from "../../../app/plugin-runtime/types.js";

/** Default session-start recall limits for host prompt injection. */
const DEFAULT_SESSION_START_POLICY = {
  maxCoreDurables: 4,
  maxArtifactRecallDurables: 3,
  maxDurables: 5,
  maxArtifactChars: 1_200,
} as const;

/** Default before-turn recall limits for host prompt injection. */
const DEFAULT_BEFORE_TURN_POLICY = {
  maxDurables: 1,
  maxHighConfidenceDurables: 2,
  maxRecentTurns: 2,
  maxQueryChars: 450,
  maxProcedureCandidates: 3,
  recallThreshold: 0.6,
  highConfidenceRecallThreshold: 0.85,
  procedureThreshold: 0.72,
} as const;

export { DEFAULT_BEFORE_TURN_POLICY, DEFAULT_SESSION_START_POLICY };

/**
 * Resolves effective session-start policy from static defaults plus plugin overrides.
 *
 * @param memoryPolicy - Optional host memory-policy overrides.
 * @returns Effective session-start policy for one prompt build.
 */
export function resolveSessionStartPolicy(memoryPolicy?: PluginInjectionMemoryPolicyConfig) {
  return {
    ...DEFAULT_SESSION_START_POLICY,
    ...(memoryPolicy?.sessionStart?.coreMemory === false ? { maxCoreDurables: 0 } : {}),
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
    ...(memoryPolicy?.beforeTurn?.maxDurables !== undefined ? { maxDurables: memoryPolicy.beforeTurn.maxDurables } : {}),
    ...(memoryPolicy?.beforeTurn?.recallThreshold !== undefined ? { recallThreshold: memoryPolicy.beforeTurn.recallThreshold } : {}),
    ...(memoryPolicy?.beforeTurn?.highConfidenceRecallThreshold !== undefined
      ? { highConfidenceRecallThreshold: memoryPolicy.beforeTurn.highConfidenceRecallThreshold }
      : {}),
    ...(memoryPolicy?.beforeTurn?.procedureThreshold !== undefined ? { procedureThreshold: memoryPolicy.beforeTurn.procedureThreshold } : {}),
  };
}

/** Result when working-context resolution is blocked by feature flags or policy. */
export type WorkingContextGateBlocked = {
  ok: false;
  reason: string;
};

/** Result when working-context resolution may proceed for one turn. */
export type WorkingContextGateAllowed = {
  ok: true;
};

/** Gate result for automatic working-context injection on one turn. */
export type WorkingContextGateResult = WorkingContextGateAllowed | WorkingContextGateBlocked;

/**
 * Resolves whether a host should resolve and inject working context for one turn.
 *
 * @param workingMemory - Resolved working-memory capability or legacy feature flags.
 * @returns Allowed when working memory is enabled and policy permits injection, otherwise a skip reason.
 */
export function resolveWorkingContextGate(workingMemory: RuntimeCapabilityState | WorkingMemoryFeatureFlags): WorkingContextGateResult {
  const capability = resolveWorkingMemoryCapability(workingMemory);
  if (capability === "disabled") {
    return { ok: false, reason: "features.workingMemory=false" };
  }
  if (capability === "misconfigured") {
    return { ok: false, reason: "features.workingMemory enabled without repository" };
  }
  return { ok: true };
}

/** Normalizes legacy feature-flag input into one working-memory capability state. */
function resolveWorkingMemoryCapability(workingMemory: RuntimeCapabilityState | WorkingMemoryFeatureFlags): RuntimeCapabilityState {
  if (typeof workingMemory === "string") {
    return workingMemory;
  }

  return workingMemory.workingMemory ? "enabled" : "disabled";
}
