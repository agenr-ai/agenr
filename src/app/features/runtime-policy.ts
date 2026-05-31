import type { PluginInjectionMemoryPolicyConfig } from "../plugin-runtime/types.js";
import type { GoalContinuationHostPort } from "../goal-continuation/service.js";
import { resolveRuntimeCapabilities, type RuntimeCapabilities } from "./capabilities.js";
import type { AgenrFeatureFlags } from "./types.js";
import type { SessionMemoryRepository } from "../session-memory/repository.js";
import type { WorkingMemoryRepository } from "../working-memory/repository.js";

/** Unified runtime policy resolved once per host adapter startup. */
export interface RuntimePolicy {
  /** Fully resolved runtime feature flags. */
  featureFlags: AgenrFeatureFlags;
  /** Derived capability map for host adapters. */
  capabilities: RuntimeCapabilities;
  /** Optional host memory-policy overrides for prompt injection. */
  memoryPolicy?: PluginInjectionMemoryPolicyConfig;
}

/** Optional repositories and policy inputs used to resolve runtime policy. */
export interface ResolveRuntimePolicyInput {
  /** Repository required when workingMemory is enabled. */
  workingMemoryRepository?: WorkingMemoryRepository;
  /** Repository required when session-memory flags are enabled. */
  sessionMemoryRepository?: SessionMemoryRepository;
  /** Optional host memory-policy overrides. */
  memoryPolicy?: PluginInjectionMemoryPolicyConfig;
  /** Host callback required when goalContinuation is enabled. */
  goalContinuationHostPort?: GoalContinuationHostPort;
}

/**
 * Resolves one runtime policy object for host adapters.
 *
 * @param featureFlags - Fully resolved runtime feature flags.
 * @param input - Optional repositories and memory policy.
 * @returns Unified runtime policy for hooks and tools.
 */
export function resolveRuntimePolicy(featureFlags: AgenrFeatureFlags, input: ResolveRuntimePolicyInput = {}): RuntimePolicy {
  return {
    featureFlags,
    capabilities: resolveRuntimeCapabilities(featureFlags, {
      workingMemoryRepository: input.workingMemoryRepository,
      sessionMemoryRepository: input.sessionMemoryRepository,
      goalContinuationHostPort: input.goalContinuationHostPort,
    }),
    ...(input.memoryPolicy ? { memoryPolicy: input.memoryPolicy } : {}),
  };
}
