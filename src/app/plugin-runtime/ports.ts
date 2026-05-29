import type { AgenrConfig } from "../../config.js";

import type { PluginClaimExtractionRuntime, PluginClaimSlotPolicyConfig, PluginMemoryRuntimeServices } from "./types.js";

/**
 * Input used to compose shared host plugin memory services.
 */
export interface CreatePluginMemoryRuntimeInput {
  /** Resolved SQLite database path. */
  dbPath: string;
  /** Resolved agenr runtime configuration. */
  agenrConfig: AgenrConfig;
  /** Optional read-time slot-policy overrides for recall surfaces. */
  slotPolicies?: PluginClaimSlotPolicyConfig;
  /** Optional claim-extraction runtime wired by host composition. */
  claimExtraction?: PluginClaimExtractionRuntime;
  /** Optional hook invoked before the database closes. */
  onBeforeClose?: () => Promise<void>;
}

/**
 * Port implemented by adapter composition to build process-lifetime plugin memory services.
 */
export interface PluginMemoryRuntimeFactoryPort {
  /**
   * Creates the shared process-lifetime memory services used by host plugin runtimes.
   *
   * @param input - Resolved paths, config, and host-specific hooks.
   * @returns Shared memory services reused for the process lifetime.
   */
  createPluginMemoryRuntime(input: CreatePluginMemoryRuntimeInput): Promise<PluginMemoryRuntimeServices>;
}

/**
 * Context passed to host-specific claim-extraction wiring during plugin composition.
 */
export interface ResolveClaimExtractionContext<TConfig = unknown> {
  /** Resolved agenr runtime configuration. */
  agenrConfig: AgenrConfig;
  /** Raw host plugin config supplied by the adapter. */
  hostConfig: TConfig;
}
