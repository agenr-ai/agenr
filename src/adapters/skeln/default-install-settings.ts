/**
 * Default Skeln extension `memoryPolicy` JSON written on fresh installs.
 *
 * Session-start and before-turn injection stay off; working context stays on
 * so WIP surfaces remain available when `features.workingMemory` is enabled.
 */
export const DEFAULT_SKELN_INSTALL_MEMORY_POLICY_JSON =
  '{"sessionStart":{"enabled":false,"coreMemory":false,"relevantDurableMemory":false},"beforeTurn":{"enabled":false,"procedureSuggestion":false},"workingContext":{"enabled":true}}' as const;
