import type { OpenClawConfig, OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/core";

import type { AgenrConfig } from "../../config.js";
import type { RecallOutput } from "../../core/recall/types.js";
import type { EmbeddingPort, LlmPort, RecallPorts } from "../../core/ports.js";
import type { Entry } from "../../core/types.js";
import type { SqlDatabase } from "../db/client.js";
import type { LlmClientMetadata } from "../llm.js";

/**
 * Runtime plugin configuration accepted by the agenr OpenClaw adapter.
 */
export interface AgenrOpenClawPluginConfig {
  dbPath: string;
  configPath?: string;
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
 * Static session-summary LLM availability facts derived from plugin configuration.
 */
export interface AgenrOpenClawSummaryStatus {
  available: boolean;
  provider: string;
  model: string;
  error?: string;
}

/**
 * LLM client used for file-based session continuity summaries.
 */
export interface AgenrOpenClawSummaryClient extends LlmPort {
  metadata: LlmClientMetadata;
}

/**
 * Shared adapter services created once for the OpenClaw plugin process.
 */
export interface AgenrOpenClawServices {
  config: AgenrOpenClawPluginConfig;
  agenrConfig: AgenrConfig;
  dbPath: string;
  database: SqlDatabase;
  embedding: EmbeddingPort;
  recall: RecallPorts;
  embeddingStatus: AgenrOpenClawEmbeddingStatus;
  summaryStatus: AgenrOpenClawSummaryStatus;
  summaryLlm?: AgenrOpenClawSummaryClient;
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
  relevant: RecallOutput[];
  recent: Entry[];
}

/**
 * Minimal before-prompt-build payload used by the agenr OpenClaw adapter.
 */
export interface AgenrOpenClawBeforePromptBuildEvent {
  prompt: string;
  messages: unknown[];
}

/**
 * Minimal before-reset payload used by the agenr OpenClaw adapter.
 */
export interface AgenrOpenClawBeforeResetEvent {
  sessionFile?: string;
  messages?: unknown[];
  reason?: string;
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

/**
 * Shared hook dependencies passed into the reset handler.
 */
export interface AgenrOpenClawBeforeResetDeps {
  logger: PluginLogger;
  servicesPromise: Promise<AgenrOpenClawServices>;
}
