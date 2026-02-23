// Local type aliases for OpenClaw plugin SDK types.
// These mirror the shapes in openclaw/dist/plugin-sdk/ without creating a dependency.

export type BeforeAgentStartEvent = {
  prompt?: string;
  messages?: unknown[];
  [key: string]: unknown;
};

export type PluginHookAgentContext = {
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  [key: string]: unknown;
};

export type BeforeAgentStartResult = {
  prependContext?: string;
};

export type BeforePromptBuildEvent = {
  prompt?: string;
  messages?: unknown[];
  [key: string]: unknown;
};

export type BeforePromptBuildResult = {
  systemPrompt?: string;
  prependContext?: string;
};

export type BeforeResetEvent = {
  sessionFile?: string;
  messages?: unknown[];
  reason?: string;
};

export type PluginLogger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type PluginToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
};

export type PluginTool = {
  name: string;
  label?: string;
  description: string;
  parameters: import("@sinclair/typebox").TObject;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<PluginToolResult>;
};

export type PluginToolOptions = {
  name?: string;
  names?: string[];
  optional?: boolean;
};

export type PluginApi = {
  id: string;
  name: string;
  version?: string;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  registerTool?: (tool: PluginTool, opts?: PluginToolOptions) => void;
  on: {
    (
      hook: "before_agent_start",
      handler: (
        event: BeforeAgentStartEvent,
        ctx: PluginHookAgentContext
      ) => Promise<BeforeAgentStartResult | undefined> | BeforeAgentStartResult | undefined,
    ): void;
    (
      hook: "before_prompt_build",
      handler: (
        event: BeforePromptBuildEvent,
        ctx: PluginHookAgentContext
      ) => Promise<BeforePromptBuildResult | undefined> | BeforePromptBuildResult | undefined,
    ): void;
    (
      hook: "before_reset",
      handler: (
        event: BeforeResetEvent,
        ctx: PluginHookAgentContext
      ) => Promise<void> | void,
    ): void;
  };
};

export type AgenrPluginConfig = {
  /** Path to agenr CLI entry point (dist/cli.js). Defaults to AGENR_BIN env or bundled dist/cli.js */
  agenrPath?: string;
  /** Token budget for recall (default: 2000) */
  budget?: number;
  /** Active project scope. When set, recall and store calls are scoped to this project. */
  project?: string;
  /** Set to false to disable memory injection without removing the plugin */
  enabled?: boolean;
  /** Path to agenr DB. Defaults to AGENR_DB_PATH env or ~/.agenr/knowledge.db */
  dbPath?: string;
  /** Set to false to disable mid-session signals (default: true) */
  signalsEnabled?: boolean;
  /** Minimum importance for signal entries (default: 8) */
  signalMinImportance?: number;
  /** Max entries per signal notification (default: 3) */
  signalMaxPerSignal?: number;
  /** Minimum ms between signal batches per session (default: 30000). Set 0 to disable cooldown. */
  signalCooldownMs?: number;
  /** Max total signal batches delivered per session lifetime (default: 10). Set 0 to disable. */
  signalMaxPerSession?: number;
  /** Only surface entries created within last N seconds (default: 300). Set 0 to disable age filter. */
  signalMaxAgeSec?: number;
};
