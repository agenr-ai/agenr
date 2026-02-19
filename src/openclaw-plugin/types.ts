// Local type aliases for OpenClaw plugin SDK types.
// These mirror the shapes in openclaw/dist/plugin-sdk/ without creating a dependency.

export type BeforeAgentStartEvent = {
  sessionKey?: string;
  prompt?: string;
  [key: string]: unknown;
};

export type BeforeAgentStartResult = {
  prependContext?: string;
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
  on: (
    hook: "before_agent_start",
    handler: (
      event: BeforeAgentStartEvent
    ) => Promise<BeforeAgentStartResult | undefined> | BeforeAgentStartResult | undefined
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
