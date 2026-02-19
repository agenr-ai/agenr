// Local type aliases for OpenClaw plugin SDK types.
// These mirror the shapes in openclaw/dist/plugin-sdk/ without creating a dependency.

export type BootstrapFile = {
  name: string;
  path: string;
  content?: string;
  missing: boolean;
};

export type BootstrapHookContext = {
  bootstrapFiles: BootstrapFile[];
  sessionKey?: string;
  workspaceDir?: string;
  sessionId?: string;
  agentId?: string;
};

export type HookEvent = {
  type: string;
  action: string;
  sessionKey: string;
  context: Record<string, unknown>;
  timestamp: Date;
  messages: string[];
};

export type PluginLogger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type PluginApi = {
  id: string;
  name: string;
  version?: string;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  registerHook: (
    events: string | string[],
    handler: (event: HookEvent) => Promise<void> | void
  ) => void;
};

export type AgenrPluginConfig = {
  /** Path to agenr CLI entry point (dist/cli.js). Defaults to AGENR_BIN env or bundled dist/cli.js */
  agenrPath?: string;
  /** Token budget for recall (default: 2000) */
  budget?: number;
  /** Set to false to disable memory injection without removing the plugin */
  enabled?: boolean;
};
