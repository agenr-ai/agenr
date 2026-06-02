import type { TSchema } from "typebox";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";

import type { SkelnBranchEntryLike } from "./session/branch-compaction.js";

/** Minimal Skeln extension API surface used by the agenr adapter. */
export interface ExtensionAPI {
  /** Reads one extension setting supplied by Skeln config. */
  getSetting(key: string): unknown;
  /** Registers one model-facing tool with the Skeln runtime. */
  registerTool(tool: SkelnToolDefinition): void;
}

/** Minimal Skeln session manager surface used by the agenr adapter. */
export interface SkelnSessionManager {
  /** Returns the active Skeln session id. */
  getSessionId(): string | number;
  /** Returns the active session working directory. */
  getCwd(): string;
  /** Returns the active session JSONL file path when available. */
  getSessionFile(): string;
  /** Returns active branch entries visible to before-turn recall. */
  getBranch(): SkelnBranchEntryLike[];
}

/** Minimal Skeln extension context surface used by the agenr adapter. */
export interface ExtensionContext {
  /** Current working directory when provided directly by newer Skeln hosts. */
  cwd?: string;
  /** Session manager for identity, cwd fallback, and transcript location. */
  sessionManager: SkelnSessionManager;
}

/** Tool-update callback shape accepted by Skeln tool handlers. */
export type SkelnToolUpdateCallback = (update: unknown) => void;

/** Minimal Skeln tool definition shape registered by the agenr adapter. */
export interface SkelnToolDefinition {
  /** Tool name exposed to the model. */
  name: string;
  /** Human-readable label shown by host UI. */
  label?: string;
  /** Tool description shown to the model and host UI. */
  description: string;
  /** Optional prompt snippet injected by Skeln. */
  promptSnippet?: string;
  /** Optional model-facing usage guidelines injected by Skeln. */
  promptGuidelines?: string[];
  /** TypeBox-compatible parameter schema. */
  parameters?: TSchema;
  /** Executes one Skeln tool call. */
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: SkelnToolUpdateCallback | undefined,
    context: ExtensionContext,
  ): AgentToolResult<Record<string, unknown>> | Promise<AgentToolResult<Record<string, unknown>>>;
}
