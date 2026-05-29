import type { OpenClawConfig, PluginLogger } from "openclaw/plugin-sdk/core";
import type {
  MemoryEmbeddingProbeResult as OpenClawMemoryEmbeddingProbeResult,
  MemoryProviderStatus as OpenClawMemoryProviderStatus,
  MemorySearchManager as OpenClawMemorySearchManager,
  MemorySearchResult as OpenClawMemorySearchResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

import type { AgenrOpenClawServices } from "../../app/openclaw/types.js";

export type {
  AgenrOpenClawDebugConfig,
  AgenrOpenClawDebugEventLevel,
  AgenrOpenClawHost,
  AgenrOpenClawMemoryPolicyConfig,
  AgenrOpenClawPluginConfig,
  AgenrOpenClawResolvedProviderAuth,
  AgenrOpenClawRuntime,
  MidSessionState,
  ResolvedAgenrOpenClawPluginConfig,
  StoreNudgeConfig,
} from "./contract.js";
export type { AgenrOpenClawServices } from "../../app/openclaw/types.js";

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
