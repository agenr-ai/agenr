import type { OpenClawConfig, OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/core";
import type {
  MemoryEmbeddingProbeResult as OpenClawMemoryEmbeddingProbeResult,
  MemoryProviderStatus as OpenClawMemoryProviderStatus,
  MemorySearchManager as OpenClawMemorySearchManager,
  MemorySearchResult as OpenClawMemorySearchResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

import type { AgenrDebugSink } from "./debug/sink.js";
import type { MemoryRepository } from "../../app/memory/ports.js";
import type { BeforeTurnDeps } from "../../app/before-turn/index.js";
import type { PluginClaimSlotPolicyConfig, PluginEmbeddingStatus, ResolvedPluginPaths } from "../../app/plugin-runtime/types.js";
import type { SessionStartDeps } from "../../app/session-start/index.js";
import type { AgenrConfig } from "../../config.js";
import type { DatabasePort, EmbeddingPort, EpisodeDatabasePort, LlmPort, ProcedureDatabasePort, RecallPorts } from "../../core/ports.js";
import type { ClaimExtractionConfig } from "../../core/store/claim-extraction.js";

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
 * Slot-policy overrides that the OpenClaw adapter can apply at runtime.
 */
export type AgenrOpenClawClaimSlotPolicyConfig = PluginClaimSlotPolicyConfig;

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
export interface AgenrOpenClawMemoryPolicyConfig {
  /** Read-time slot-policy overrides used by recall and trace surfaces. */
  slotPolicies?: AgenrOpenClawClaimSlotPolicyConfig;
  /** Session-start overrides for prompt-time memory injection behavior. */
  sessionStart?: {
    /** Enables or disables artifact-grounded "Relevant Durable Memory" injection. */
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
  /** Narrow runtime memory-policy overrides for claim-aware read surfaces. */
  memoryPolicy?: AgenrOpenClawMemoryPolicyConfig;
  /** Opt-in JSONL debug sink config for live OpenClaw runs. */
  debug?: AgenrOpenClawDebugConfig;
}

/**
 * Concrete runtime paths derived from plugin config and agenr defaults.
 */
export type ResolvedAgenrOpenClawPluginConfig = ResolvedPluginPaths;

/**
 * Static embedding availability facts derived from plugin configuration.
 */
export type AgenrOpenClawEmbeddingStatus = PluginEmbeddingStatus;

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
  procedures: ProcedureDatabasePort;
  memory: MemoryRepository;
  sessionStart: SessionStartDeps;
  beforeTurn: BeforeTurnDeps;
  embedding: EmbeddingPort;
  recall: RecallPorts;
  claimExtraction?: {
    llm: LlmPort;
    config: ClaimExtractionConfig;
  };
  embeddingStatus: AgenrOpenClawEmbeddingStatus;
  /** Opt-in JSONL debug sink shared by adapter paths that emit structured events. */
  debugSink: AgenrDebugSink;
  close(): Promise<void>;
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
 * Memory search result shape consumed by OpenClaw memory-host surfaces.
 */
export type AgenrOpenClawMemorySearchResult = OpenClawMemorySearchResult;

/**
 * Memory embedding probe result expected by current OpenClaw memory runtimes.
 */
export type AgenrOpenClawMemoryEmbeddingProbeResult = OpenClawMemoryEmbeddingProbeResult;

/**
 * Memory runtime status payload consumed by OpenClaw status surfaces.
 */
export type AgenrOpenClawMemoryProviderStatus = OpenClawMemoryProviderStatus;

/**
 * Lightweight memory search manager contract needed by OpenClaw status/inspect flows.
 */
export type AgenrOpenClawRegisteredMemorySearchManager = OpenClawMemorySearchManager;

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
 * Public artifact content types supported by the OpenClaw memory capability API.
 */
export type AgenrOpenClawMemoryPluginPublicArtifactContentType = "markdown" | "json" | "text";

/**
 * Public artifact shape exposed by OpenClaw memory plugins.
 */
export interface AgenrOpenClawMemoryPluginPublicArtifact {
  kind: string;
  workspaceDir: string;
  relativePath: string;
  absolutePath: string;
  agentIds: string[];
  contentType: AgenrOpenClawMemoryPluginPublicArtifactContentType;
}

/**
 * Public artifact provider contract used by the unified OpenClaw memory capability API.
 */
export interface AgenrOpenClawMemoryPluginPublicArtifactsProvider {
  listArtifacts(params: { cfg: OpenClawConfig }): Promise<AgenrOpenClawMemoryPluginPublicArtifact[]>;
}

/**
 * Unified memory capability registration payload used by current OpenClaw builds.
 */
export interface AgenrOpenClawMemoryPluginCapability {
  promptBuilder?: AgenrOpenClawMemoryPromptSectionBuilder;
  flushPlanResolver?: AgenrOpenClawMemoryFlushPlanResolver;
  runtime?: AgenrOpenClawMemoryPluginRuntime;
  publicArtifacts?: AgenrOpenClawMemoryPluginPublicArtifactsProvider;
}

/**
 * Shared hook dependencies passed into the session-start handler.
 */
export interface AgenrOpenClawBeforePromptBuildDeps {
  logger: PluginLogger;
  servicesPromise: Promise<AgenrOpenClawServices>;
}
