import type { ClaimSlotPolicy, ClaimSlotPolicyConfig } from "../../core/claim-slot-policy.js";
import type { DatabasePort, EmbeddingPort, EpisodeDatabasePort, LlmPort, ProcedureDatabasePort, RecallPorts } from "../../core/ports.js";
import type { ClaimExtractionConfig } from "../../core/store/claim-extraction.js";
import type { BeforeTurnDeps } from "../before-turn/index.js";
import type { MemoryRepository } from "../memory/ports.js";
import type { SessionStartDeps } from "../session-start/index.js";

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
  sessionStart: SessionStartDeps;
  beforeTurn: BeforeTurnDeps;
  embedding: EmbeddingPort;
  recall: RecallPorts;
  claimExtraction?: PluginClaimExtractionRuntime;
  embeddingStatus: PluginEmbeddingStatus;
  close(): Promise<void>;
}
