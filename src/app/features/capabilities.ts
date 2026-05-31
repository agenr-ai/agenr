import type { GoalContinuationHostPort } from "../goal-continuation/service.js";
import type { SessionMemoryRepository } from "../session-memory/repository.js";
import type { WorkingMemoryRepository } from "../working-memory/repository.js";
import type { AgenrFeatureFlags } from "./types.js";

/** Resolved runtime capability state for one feature surface. */
export type RuntimeCapabilityState = "enabled" | "disabled" | "misconfigured";

/** Derived runtime capabilities resolved once per host adapter startup. */
export interface RuntimeCapabilities {
  /** Working-memory ledger and tool surface. */
  workingMemory: RuntimeCapabilityState;
  /** Session-memory lifecycle intake and persistence. */
  sessionMemory: RuntimeCapabilityState;
  /** Whether shutdown lifecycle hooks may attempt bounded episode writes. */
  shutdownEpisodes: boolean;
  /** Goal-continuation host contract surface. */
  goalContinuation: RuntimeCapabilityState;
}

/** Optional repositories used to derive capability state. */
export interface ResolveRuntimeCapabilitiesInput {
  /** Repository required when workingMemory is enabled. */
  workingMemoryRepository?: WorkingMemoryRepository;
  /** Repository required when session-memory flags are enabled. */
  sessionMemoryRepository?: SessionMemoryRepository;
  /** Host callback required when goalContinuation is enabled. */
  goalContinuationHostPort?: GoalContinuationHostPort;
}

/**
 * Derives host runtime capabilities from resolved feature flags and wired repositories.
 *
 * @param featureFlags - Fully resolved runtime feature flags.
 * @param input - Optional repositories required by enabled features.
 * @returns Capability map adapters can read without re-deriving flag and repo checks.
 */
export function resolveRuntimeCapabilities(featureFlags: AgenrFeatureFlags, input: ResolveRuntimeCapabilitiesInput = {}): RuntimeCapabilities {
  const sessionMemoryFlagEnabled = featureFlags.sessionTreeLineage || featureFlags.sessionTreeCompaction;

  const sessionMemory = resolveRepositoryBackedCapability(sessionMemoryFlagEnabled, input.sessionMemoryRepository);

  return {
    workingMemory: resolveRepositoryBackedCapability(featureFlags.workingMemory, input.workingMemoryRepository),
    sessionMemory,
    shutdownEpisodes: sessionMemory === "enabled",
    goalContinuation: resolveGoalContinuationCapability(featureFlags.goalContinuation, input.goalContinuationHostPort),
  };
}

/** Returns true when a resolved capability is fully enabled. */
export function isRuntimeCapabilityEnabled(state: RuntimeCapabilityState): boolean {
  return state === "enabled";
}

/** Resolves one repository-backed capability from a feature flag and optional repository. */
function resolveRepositoryBackedCapability(featureEnabled: boolean, repository: unknown): RuntimeCapabilityState {
  if (!featureEnabled) {
    return "disabled";
  }

  return repository ? "enabled" : "misconfigured";
}

/** Resolves goal-continuation capability from the feature flag and optional host port. */
function resolveGoalContinuationCapability(featureEnabled: boolean, hostPort?: GoalContinuationHostPort): RuntimeCapabilityState {
  if (!featureEnabled) {
    return "disabled";
  }

  return hostPort ? "enabled" : "misconfigured";
}
