import type { OpenClawConfig, OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/core";

import type { OpenClawRepository } from "../../app/openclaw/ports.js";
import type { AgenrConfig } from "../../config.js";
import type { DatabasePort, EmbeddingPort, EpisodeDatabasePort, LlmPort, RecallPorts } from "../../core/ports.js";
import type { ClaimExtractionConfig } from "../../core/store/claim-extraction.js";
import type { Entry } from "../../core/types.js";

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
  entriesStored: number;
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
  /** Model override for continuity summary generation (OpenClaw auth). */
  continuityModel?: string;
  /** Model override for episode summary generation at session-start (OpenClaw auth). */
  episodeModel?: string;
  /** Model override for claim-key extraction at store time (OpenClaw auth). Format: "provider/model". */
  claimExtractionModel?: string;
  /** Mid-session nudging config for reminding the agent to store durable memory. */
  storeNudge?: Partial<StoreNudgeConfig>;
}

/**
 * Concrete runtime paths derived from plugin config and agenr defaults.
 */
export interface ResolvedAgenrOpenClawPluginConfig {
  dbPath: string;
  configPath: string;
}

/**
 * Static embedding availability facts derived from plugin configuration.
 */
export interface AgenrOpenClawEmbeddingStatus {
  available: boolean;
  provider: string;
  requestedProvider: string;
  model: string;
  error?: string;
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

/**
 * Shared adapter services created once for the OpenClaw plugin process.
 */
export interface AgenrOpenClawServices {
  openClaw: AgenrOpenClawHost;
  config: ResolvedAgenrOpenClawPluginConfig;
  pluginConfig: AgenrOpenClawPluginConfig;
  agenrConfig: AgenrConfig;
  dbPath: string;
  entries: DatabasePort;
  episodes: EpisodeDatabasePort;
  memory: OpenClawRepository;
  embedding: EmbeddingPort;
  recall: RecallPorts;
  claimExtraction?: {
    llm: LlmPort;
    config: ClaimExtractionConfig;
  };
  embeddingStatus: AgenrOpenClawEmbeddingStatus;
  close(): Promise<void>;
}

/**
 * Entry rendered inside an injected OpenClaw prompt section.
 */
export interface OpenClawPromptMemoryEntry {
  entry: Entry;
  score?: number;
}

/**
 * One labeled memory section injected into the system prompt.
 */
export interface OpenClawPromptMemorySection {
  title: string;
  entries: OpenClawPromptMemoryEntry[];
}

/**
 * Structured session-start recall result before formatting for prompt injection.
 */
export interface OpenClawSessionStartRecall {
  core: Entry[];
}

/**
 * Minimal before-prompt-build payload used by the agenr OpenClaw adapter.
 */
export interface AgenrOpenClawBeforePromptBuildEvent {
  prompt: string;
  messages: unknown[];
}

/**
 * Minimal session-start payload used to track predecessor continuity.
 */
export interface AgenrOpenClawSessionStartEvent {
  sessionId: string;
  sessionKey?: string;
  resumedFrom?: string;
}

/**
 * Minimal session-end payload used for lifecycle cleanup.
 */
export interface AgenrOpenClawSessionEndEvent {
  sessionId: string;
  sessionKey?: string;
  messageCount: number;
  durationMs?: number;
}

/**
 * Minimal after-tool-call payload used for synchronous memory-action tracking.
 */
export interface AgenrOpenClawAfterToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

/**
 * Minimal hook context surface used by session-start recall.
 */
export interface AgenrOpenClawHookContext {
  agentId?: string;
  channelId?: string;
  messageProvider?: string;
  sessionId?: string;
  sessionKey?: string;
  trigger?: string;
  workspaceDir?: string;
}

/**
 * Prompt mutation payload returned from the session-start hook.
 */
export interface AgenrOpenClawBeforePromptBuildResult {
  systemPrompt?: string;
  prependContext?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
}

/**
 * Memory embedding probe result expected by newer OpenClaw memory runtimes.
 */
export interface AgenrOpenClawMemoryEmbeddingProbeResult {
  ok: boolean;
  error?: string;
}

/**
 * Memory runtime status payload consumed by OpenClaw status surfaces.
 */
export interface AgenrOpenClawMemoryProviderStatus {
  backend: "builtin" | "qmd";
  provider: string;
  model?: string;
  dbPath?: string;
  files?: number;
  chunks?: number;
  vector?: {
    enabled: boolean;
    available?: boolean;
    dims?: number;
  };
  custom?: Record<string, unknown>;
}

/**
 * Lightweight memory search manager contract needed by OpenClaw status/inspect flows.
 */
export interface AgenrOpenClawRegisteredMemorySearchManager {
  status(): AgenrOpenClawMemoryProviderStatus;
  probeEmbeddingAvailability(): Promise<AgenrOpenClawMemoryEmbeddingProbeResult>;
  probeVectorAvailability(): Promise<boolean>;
  sync?(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: { completed: number; total: number; label?: string }) => void;
  }): Promise<void>;
  close?(): Promise<void>;
}

/**
 * Backend selection payload returned by the agenr memory runtime.
 */
export interface AgenrOpenClawMemoryRuntimeBackendConfig {
  backend: "builtin" | "qmd";
  qmd?: object;
}

/**
 * Memory runtime registration contract used by newer OpenClaw builds.
 */
export interface AgenrOpenClawMemoryPluginRuntime {
  getMemorySearchManager(params: { cfg: OpenClawConfig; agentId: string; purpose?: "default" | "status" }): Promise<{
    manager: AgenrOpenClawRegisteredMemorySearchManager | null;
    error?: string;
  }>;
  resolveMemoryBackendConfig(params: { cfg: OpenClawConfig; agentId: string }): AgenrOpenClawMemoryRuntimeBackendConfig;
  closeAllMemorySearchManagers?(): Promise<void>;
}

/**
 * Flush-plan payload used by newer OpenClaw memory slot integrations.
 */
export interface AgenrOpenClawMemoryFlushPlan {
  softThresholdTokens: number;
  forceFlushTranscriptBytes: number;
  reserveTokensFloor: number;
  prompt: string;
  systemPrompt: string;
  relativePath: string;
}

/**
 * Flush-plan resolver contract used by newer OpenClaw memory slot integrations.
 */
export type AgenrOpenClawMemoryFlushPlanResolver = (params: { cfg?: OpenClawConfig; nowMs?: number }) => AgenrOpenClawMemoryFlushPlan | null;

/**
 * Public memory prompt-section builder contract.
 */
export type AgenrOpenClawMemoryPromptSectionBuilder = (params: { availableTools: Set<string>; citationsMode?: "auto" | "on" | "off" }) => string[];

/**
 * OpenClaw plugin API plus newer memory-slot registration hooks when available.
 *
 * The published npm SDK currently lags these methods, so they are optional here
 * and the adapter feature-detects them at runtime.
 */
export interface AgenrOpenClawMemoryPluginApi extends OpenClawPluginApi {
  registerMemoryPromptSection(builder: AgenrOpenClawMemoryPromptSectionBuilder): void;
  registerMemoryFlushPlan?: (resolver: AgenrOpenClawMemoryFlushPlanResolver) => void;
  registerMemoryRuntime?: (runtime: AgenrOpenClawMemoryPluginRuntime) => void;
}

/**
 * Shared hook dependencies passed into the session-start handler.
 */
export interface AgenrOpenClawBeforePromptBuildDeps {
  logger: PluginLogger;
  servicesPromise: Promise<AgenrOpenClawServices>;
}
