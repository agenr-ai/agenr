import type { PluginClaimSlotPolicyConfig } from "../../app/plugin-runtime/types.js";

export type { AgenrSkelnConfig, AgenrSkelnServices } from "../../app/skeln/runtime.js";

/**
 * Skeln-native scope facts gathered by the host extension and passed into the
 * agenr adapter for recall, store provenance, and session-start routing.
 */
export interface SkelnHostContext {
  /** Current working directory for the active Skeln session. */
  cwd: string;
  /** Repository root when the session cwd is inside a git work tree. */
  gitRoot?: string;
  /** Current git branch when available from the host extension. */
  gitBranch?: string;
  /** Optional project label supplied by the host extension. */
  project?: string;
  /** Stable recall/session key derived from Skeln session identity and cwd. */
  sessionKey: string;
}

/**
 * Narrow memory-policy settings exposed through the Skeln plugin config.
 */
export interface AgenrSkelnMemoryPolicyConfig {
  /** Read-time slot-policy overrides used by recall surfaces. */
  slotPolicies?: PluginClaimSlotPolicyConfig;
  /** Session-start overrides for prompt-time memory injection behavior. */
  sessionStart?: {
    /** Enables or disables artifact-grounded relevant durable memory injection. */
    relevantDurableMemory?: boolean;
  };
  /** Before-turn overrides for proactive prompt-time memory injection behavior. */
  beforeTurn?: {
    /** Enables or disables the proactive before-turn patch path. */
    enabled?: boolean;
    /** Enables or disables proactive procedure suggestion inside the patch. */
    procedureSuggestion?: boolean;
    /** Normal durable-item cap before very-high-confidence expansion applies. */
    maxDurableEntries?: number;
    /** Durable-recall score threshold required before an entry can surface. */
    recallThreshold?: number;
    /** Durable-recall score threshold required before surfacing more than the normal cap. */
    highConfidenceRecallThreshold?: number;
    /** Procedure-recall score threshold required before a proactive procedure can surface. */
    procedureThreshold?: number;
  };
}

/**
 * Options accepted by {@link registerAgenrSkelnMemory}.
 */
export interface RegisterAgenrSkelnMemoryOptions {
  /** Path to the shared agenr SQLite database. */
  dbPath?: string;
  /** Path to the agenr config.json file. */
  configPath?: string;
  /** Narrow runtime memory-policy overrides for claim-aware read surfaces. */
  memoryPolicy?: AgenrSkelnMemoryPolicyConfig;
  /**
   * Optional host callback that supplies Skeln-native scope facts. When absent,
   * the adapter derives cwd and sessionKey from the active extension context.
   */
  getHostContext?: () => SkelnHostContext | Promise<SkelnHostContext>;
}

/**
 * Resolved session scope used by Skeln lifecycle hooks and recall routing.
 */
export interface AgenrSkelnSessionScope {
  /** Ephemeral Skeln session identifier. */
  sessionId: string;
  /** Stable recall/session key for durable memory routing. */
  sessionKey: string;
  /** Current working directory for the active session. */
  cwd: string;
  /** Repository root when available. */
  gitRoot?: string;
  /** Current git branch when available. */
  gitBranch?: string;
  /** Optional project label when available. */
  project?: string;
  /** Previous session file path recorded on session_start when supplied. */
  previousSessionFile?: string;
}
