import type { ExtensionContext } from "./skeln-types.js";

import type { AgenrFeatureFlagConfig } from "../../app/features/types.js";
import type { PluginInjectionMemoryPolicyConfig } from "../../app/plugin-runtime/types.js";

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
  /** Optional host-neutral conversation identifier supplied by Skeln. */
  conversationKey?: string;
  /** Stable recall/session key derived from Skeln session identity and cwd. */
  sessionKey: string;
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
  memoryPolicy?: PluginInjectionMemoryPolicyConfig;
  /** Optional Skeln host feature-flag overrides merged over agenr config features. */
  featureFlags?: AgenrFeatureFlagConfig;
  /**
   * When false, disables goal working sets, goal alias tools, and goal-targeted mutations
   * while keeping the independent session working set enabled.
   */
  goals?: boolean;
  /**
   * Optional host callback that supplies Skeln-native scope facts. When absent,
   * the adapter derives cwd and sessionKey from the active extension context.
   */
  getHostContext?: (context: ExtensionContext) => Partial<SkelnHostContext> | Promise<Partial<SkelnHostContext>>;
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
  /** Optional host-neutral conversation identifier. */
  conversationKey?: string;
}
