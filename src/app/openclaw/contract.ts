import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/core";

import type { PluginInjectionMemoryPolicyConfig } from "../plugin-runtime/types.js";

/**
 * Resolved store-nudge settings used by mid-session prompting.
 */
export interface StoreNudgeConfig {
  /** Enables or disables mid-session store nudges. */
  enabled: boolean;
  /** Turns without durable memory work before injecting a nudge. */
  threshold: number;
  /** Maximum nudges to inject during one session lifetime. */
  maxPerSession: number;
}

/**
 * Stable event detail levels accepted by the agenr debug sink.
 *
 * `basic` limits payloads to routing, selection, and summary facts.
 * `detailed` admits bounded top-K candidate breakdowns into recall and
 * before-turn events.
 */
export type AgenrOpenClawDebugEventLevel = "basic" | "detailed";

/**
 * Narrow adapter-facing debug config after normalization. Shared across
 * the plugin config and the sink lifecycle owner.
 */
export interface AgenrOpenClawDebugConfig {
  /** Enables or disables the agenr JSONL debug sink. */
  enabled?: boolean;
  /** Optional explicit log-file path. Resolved relative to the host when unset. */
  logPath?: string;
  /** Event-detail level, gating bounded top-K candidate payloads. */
  eventLevel?: AgenrOpenClawDebugEventLevel;
  /** Whether to split one log file per OpenClaw session. */
  perSessionFiles?: boolean;
  /** Maximum top-K candidates retained in detailed recall and before-turn events. */
  maxTopCandidates?: number;
}

/**
 * Narrow memory-policy settings exposed through the OpenClaw plugin config.
 */
export type AgenrOpenClawMemoryPolicyConfig = PluginInjectionMemoryPolicyConfig;

/**
 * Per-session in-memory state used for mid-session store nudging.
 */
export interface MidSessionState {
  /** Count of non-first user turns observed in the active session. */
  turnCount: number;
  /** Turn index of the last successful agenr_store result. */
  lastSuccessfulStoreTurn: number;
  /** Turn index of the last memory action attempt or maintenance action. */
  lastMemoryActionTurn: number;
  /** Turn index of the last explicit memory maintenance action. */
  lastExplicitMemoryActionTurn: number;
  /** Count of nudges already injected for the active session. */
  nudgeCount: number;
  /** Count of successful agenr_store calls during the active session. */
  durablesStored: number;
  /** Deduplicated list of recently stored subjects for nudge copy. */
  storedSubjects: string[];
}

/**
 * Runtime plugin configuration accepted by the agenr OpenClaw adapter.
 *
 * Model fields here control tasks that execute inside the OpenClaw process
 * using OpenClaw's credential system (`modelAuth.resolveApiKeyForProvider`).
 * These are intentionally separate from the model fields in `AgenrConfig`,
 * which control CLI pipeline stages that use agenr's own credentials.
 *
 * Infrastructure fields (`dbPath`, `configPath`) point the plugin at the
 * shared agenr database and config file on disk.
 */
export interface AgenrOpenClawPluginConfig {
  /** Path to the shared agenr SQLite database. */
  dbPath?: string;
  /** Path to the agenr config.json file. */
  configPath?: string;
  /** Model override for episode summary generation at session-start (OpenClaw auth). */
  episodeModel?: string;
  /** Model override for claim-key extraction at store time (OpenClaw auth). Format: "provider/model". */
  claimExtractionModel?: string;
  /** Mid-session nudging config for reminding the agent to store durable memory. */
  storeNudge?: Partial<StoreNudgeConfig>;
  /** Narrow runtime memory-policy overrides for claim-aware read surfaces. */
  memoryPolicy?: AgenrOpenClawMemoryPolicyConfig;
  /** Opt-in JSONL debug sink config for live OpenClaw runs. */
  debug?: AgenrOpenClawDebugConfig;
}

/**
 * Resolved provider auth from OpenClaw's credential system.
 */
export interface AgenrOpenClawResolvedProviderAuth {
  apiKey?: string;
  source: string;
  mode: "api-key" | "oauth" | "token" | "aws-sdk";
}

/**
 * Minimal OpenClaw runtime helpers reused by the agenr adapter.
 */
export interface AgenrOpenClawRuntime {
  agent: Pick<OpenClawPluginApi["runtime"]["agent"], "resolveAgentDir" | "resolveAgentWorkspaceDir" | "runEmbeddedPiAgent">;
  /** Model credential resolution using OpenClaw's auth profiles. */
  modelAuth: {
    resolveApiKeyForProvider: (params: { provider: string; cfg?: OpenClawConfig }) => Promise<AgenrOpenClawResolvedProviderAuth>;
  };
  state: Pick<OpenClawPluginApi["runtime"]["state"], "resolveStateDir">;
}

/**
 * OpenClaw host config/runtime facts reused by the agenr adapter.
 */
export interface AgenrOpenClawHost {
  config: OpenClawConfig;
  runtime: AgenrOpenClawRuntime;
}
