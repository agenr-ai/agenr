/**
 * Default Skeln extension `memoryPolicy` JSON written on fresh installs.
 *
 * Session-start and before-turn recall injection stay off on fresh installs.
 * Working context is controlled by `features.workingMemory`.
 */
const DEFAULT_SKELN_INSTALL_MEMORY_POLICY_JSON =
  '{"sessionStart":{"enabled":false,"coreMemory":false,"relevantDurableMemory":false},"beforeTurn":{"enabled":false,"procedureSuggestion":false}}' as const;

export { DEFAULT_SKELN_INSTALL_MEMORY_POLICY_JSON };
