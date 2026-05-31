import type { ClaimSlotPolicy, ClaimSlotPolicyConfig } from "../../core/claim-slot-policy.js";
import type { DatabasePort, EmbeddingPort, EpisodeDatabasePort, LlmPort, ProcedureDatabasePort, RecallPorts } from "../../core/ports.js";
import type { ClaimExtractionConfig } from "../../core/store/claim-extraction.js";
import type { BeforeTurnDeps } from "../before-turn/index.js";
import type { MemoryRepository } from "../memory/ports.js";
import type { SessionMemoryRepository } from "../session-memory/index.js";
import type { SessionStartDeps } from "../session-start/index.js";
import type { WorkingMemoryRepository } from "../working-memory/index.js";

/**
 * Slot-policy overrides shared by host plugin adapters at runtime.
 */
export interface PluginClaimSlotPolicyConfig extends ClaimSlotPolicyConfig {
  /** Optional attribute-head policy overrides keyed by canonical attribute head. */
  attributeHeads?: Readonly<Record<string, ClaimSlotPolicy>>;
}

/**
 * Narrow read-time memory-policy settings shared by host plugin adapters.
 */
export interface PluginMemoryPolicyConfig {
  /** Read-time slot-policy overrides used by recall surfaces. */
  slotPolicies?: PluginClaimSlotPolicyConfig;
}

/**
 * Session-start overrides for prompt-time memory injection behavior.
 */
export interface PluginSessionStartMemoryPolicyConfig {
  /** Enables or disables session-start memory injection. Defaults to true. */
  enabled?: boolean;
  /** Enables or disables always-on core memory injection at session start. Defaults to true. */
  coreMemory?: boolean;
  /** Enables or disables artifact-grounded relevant durable memory injection. */
  relevantDurableMemory?: boolean;
}

/**
 * Before-turn overrides for proactive prompt-time memory injection behavior.
 */
export interface PluginBeforeTurnMemoryPolicyConfig {
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
}

/**
 * Working-context overrides for transient per-turn WIP injection.
 */
export interface PluginWorkingContextMemoryPolicyConfig {
  /** Enables or disables automatic working-context injection. Defaults to true when working memory is enabled. */
  enabled?: boolean;
}

/**
 * Memory-policy settings shared by host plugin adapters, including injection knobs.
 */
export interface PluginInjectionMemoryPolicyConfig extends PluginMemoryPolicyConfig {
  /** Session-start overrides for prompt-time memory injection behavior. */
  sessionStart?: PluginSessionStartMemoryPolicyConfig;
  /** Before-turn overrides for proactive prompt-time memory injection behavior. */
  beforeTurn?: PluginBeforeTurnMemoryPolicyConfig;
  /** Working-context overrides for transient per-turn WIP injection. */
  workingContext?: PluginWorkingContextMemoryPolicyConfig;
}

/**
 * Infrastructure path overrides shared by host plugin adapters.
 */
export interface PluginPathConfig {
  /** Path to the shared agenr SQLite database. */
  dbPath?: string;
  /** Path to the agenr config.json file. */
  configPath?: string;
}

/**
 * Concrete runtime paths derived from plugin config and agenr defaults.
 */
export interface ResolvedPluginPaths {
  dbPath: string;
  configPath: string;
}

/**
 * Static embedding availability facts derived from agenr configuration.
 */
export interface PluginEmbeddingStatus {
  available: boolean;
  provider: string;
  requestedProvider: string;
  model: string;
  error?: string;
}

/**
 * Optional claim-extraction runtime wired by host plugin composition.
 */
export interface PluginClaimExtractionRuntime {
  llm: LlmPort;
  config: ClaimExtractionConfig;
}

/**
 * Process-lifetime memory services shared by host plugin runtimes.
 */
export interface PluginMemoryRuntimeServices {
  entries: DatabasePort;
  episodes: EpisodeDatabasePort;
  procedures: ProcedureDatabasePort;
  memory: MemoryRepository;
  workingMemoryRepository?: WorkingMemoryRepository;
  sessionMemoryRepository?: SessionMemoryRepository;
  sessionStart: SessionStartDeps;
  beforeTurn: BeforeTurnDeps;
  embedding: EmbeddingPort;
  recall: RecallPorts;
  claimExtraction?: PluginClaimExtractionRuntime;
  embeddingStatus: PluginEmbeddingStatus;
  close(): Promise<void>;
}
