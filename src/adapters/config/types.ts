import type { ClaimExtractionConfig } from "../../core/store/claim-extraction.js";
import { DURABLE_KINDS, type DurableKind } from "../../core/types.js";
import {
  AGENR_FEATURE_FLAG_KEYS,
  DEFAULT_AGENR_FEATURE_FLAGS,
  type AgenrFeatureFlagConfig,
  type AgenrFeatureFlagKey,
  type AgenrFeatureFlags,
} from "../../app/features/types.js";

/** Fully resolved runtime feature flags. */
export type ResolvedAgenrFeatureFlags = AgenrFeatureFlags;

export type { AgenrFeatureFlagConfig, AgenrFeatureFlagKey };

/**
 * Supported auth methods for agenr-managed LLM access.
 */
export type AgenrAuthMethod = "openai-api-key" | "openai-subscription" | "anthropic-api-key" | "anthropic-oauth" | "anthropic-token";

/**
 * Providers currently supported by agenr setup and runtime helpers.
 */
export type AgenrProvider = "openai" | "openai-codex" | "anthropic";

/**
 * Manually entered credentials persisted in `config.json`.
 *
 * OAuth and subscription credentials are auto-detected from external CLIs and
 * should not be stored here.
 */
export interface AgenrStoredCredentials {
  /** OpenAI API key used for extraction, embeddings, or both. */
  openaiApiKey?: string;
  /** Anthropic API key used for extraction requests. */
  anthropicApiKey?: string;
  /** Anthropic long-lived token used for subscription auth. */
  anthropicOauthToken?: string;
}

/**
 * Per-pipeline model configuration.
 *
 * Each pipeline stage can use a different provider/model combination.
 * Falls back to the top-level provider/model when not set.
 */
export interface ModelConfig {
  /** Provider name (for example `openai` or `anthropic`). */
  provider?: string;
  /** Model ID (for example `gpt-5.4` or `gpt-5.4-nano`). */
  model?: string;
}

/**
 * Prune-stage protection configuration for dreaming runs.
 */
export interface DreamingPruneConfig {
  /** Protect durables recalled within this many days. */
  protectRecalledDays?: number;
  /** Protect durables at or above this importance. */
  protectMinImportance?: number;
}

/**
 * Dreaming module configuration persisted in `config.json`.
 */
export interface DreamingConfig {
  /** Model override for dreaming runs. */
  model?: ModelConfig;
  /** Maximum total dreaming cost in the last 24 hours. */
  dailyCostCap?: number;
  /** Context token limit override. */
  contextLimitTokens?: number;
  /** Custom instructions appended to dreaming synthesis prompts. */
  customInstructions?: string;
  tiers?: {
    light?: { enabled?: boolean };
    standard?: { enabled?: boolean };
    deep?: { enabled?: boolean; intervalHours?: number };
  };
  stages?: {
    extract?: {
      maxSessionsPerRun?: number;
      maxChunksPerSession?: number;
      contextLookup?: { enabled?: boolean; maxNeighborsPerCandidate?: number };
    };
    project?: { maxProfileDurables?: number };
    prune?: DreamingPruneConfig;
  };
  triggers?: {
    postSessionLightDream?: boolean;
    importanceThreshold?: number;
    minIntervalMinutes?: number;
  };
}

/**
 * Persisted config overrides for optional claim-key extraction.
 */
export interface AgenrClaimExtractionConfig extends Partial<ClaimExtractionConfig> {
  /** Model override for claim-key extraction. */
  model?: ModelConfig;
}

/**
 * Static metadata for one supported auth method.
 */
export interface AuthMethodDefinition {
  /** Stable config ID for the auth method. */
  id: AgenrAuthMethod;
  /** Underlying provider name passed to pi-ai. */
  provider: AgenrProvider;
  /** Human-readable label shown in setup. */
  title: string;
  /** Short setup guidance shown during selection. */
  setupDescription: string;
  /** Ordered model IDs allowed for this auth method. */
  preferredModels: readonly string[];
}

/**
 * Raw persisted agenr config shape as it appears on disk.
 */
export interface AgenrConfigInput {
  /** Selected auth method for the default extraction provider. */
  auth?: AgenrAuthMethod;
  /** Default LLM provider. */
  provider?: string;
  /** Default model for LLM tasks. */
  model?: string;
  /** Stored manual credentials. */
  credentials?: AgenrStoredCredentials;
  /** Embedding model override. */
  embeddingModel?: string;
  /** Prompt context appended to extraction requests. */
  extractionContext?: string;
  /** Model override for extraction. */
  extractionModel?: ModelConfig;
  /** Model override for dedup. */
  dedupModel?: ModelConfig;
  /** Model override for episode summaries. */
  episodeModel?: ModelConfig;
  /**
   * Model override for the cross-encoder rerank stage.
   *
   * The cross-encoder requires OpenAI chat completions with
   * `logprobs`/`logit_bias` support. Set `provider` to `openai` and
   * `model` to any model with logprob support (for example
   * `gpt-4.1-nano`).
   */
  crossEncoderModel?: ModelConfig;
  /** Best-effort claim-key extraction settings. */
  claimExtraction?: AgenrClaimExtractionConfig;
  /** Dreaming module configuration. */
  dreaming?: DreamingConfig;
  /** Staged rollout feature flags. All default to false. */
  features?: AgenrFeatureFlagConfig;
  /** Database file path. */
  dbPath?: string;
  /** HTTP API port. */
  apiPort?: number;
}

/**
 * Backward-compatible alias for the persisted config shape.
 */
export type AgenrConfig = AgenrConfigInput;

/**
 * Fully resolved claim-extraction runtime settings.
 */
export interface ResolvedAgenrClaimExtractionConfig extends ClaimExtractionConfig {
  /** Optional model override for claim-key extraction. */
  model?: ModelConfig;
}

/**
 * Fully resolved prune-stage protection settings.
 */
export interface ResolvedDreamingPruneConfig {
  /** Protect durables recalled within this many days. */
  protectRecalledDays: number;
  /** Protect durables at or above this importance. */
  protectMinImportance: number;
}

/**
 * Fully resolved dreaming runtime configuration.
 */
export interface ResolvedDreamingConfig {
  /** Optional model override for dreaming runs. */
  model?: ModelConfig;
  /** Maximum total dreaming cost in the last 24 hours. */
  dailyCostCap: number;
  /** Context token limit override. */
  contextLimitTokens: number;
  /** Custom instructions appended to dreaming synthesis prompts. */
  customInstructions?: string;
  tiers: {
    light: { enabled: boolean };
    standard: { enabled: boolean };
    deep: { enabled: boolean; intervalHours: number };
  };
  stages: {
    extract: {
      maxSessionsPerRun: number;
      maxChunksPerSession: number;
      contextLookup: { enabled: boolean; maxNeighborsPerCandidate: number };
    };
    project: { maxProfileDurables: number };
    prune: ResolvedDreamingPruneConfig;
  };
  triggers: {
    postSessionLightDream: boolean;
    importanceThreshold: number;
    minIntervalMinutes: number;
  };
}

/**
 * Fully normalized agenr runtime configuration.
 */
export interface ResolvedAgenrConfig extends Omit<AgenrConfigInput, "claimExtraction" | "dreaming" | "dbPath" | "apiPort"> {
  /** Best-effort claim-key extraction settings with defaults applied. */
  claimExtraction: ResolvedAgenrClaimExtractionConfig;
  /** Dreaming module configuration with defaults applied. */
  dreaming: ResolvedDreamingConfig;
  /** Feature flags with defaults applied. */
  features: ResolvedAgenrFeatureFlags;
  /** Database file path after config resolution. */
  dbPath: string;
  /** HTTP API port after config resolution. */
  apiPort: number;
}

/**
 * Default 24-hour dreaming cost cap in USD.
 */
const DEFAULT_DREAMING_DAILY_COST_CAP = 75.0;

/**
 * Default dreaming context limit override. Zero means auto-detect.
 */
const DEFAULT_DREAMING_CONTEXT_LIMIT_TOKENS = 0;

/**
 * Default prune-stage recall protection window in days.
 */
const DEFAULT_DREAMING_PRUNE_PROTECT_RECALLED_DAYS = 14;

/**
 * Default prune-stage importance protection threshold.
 */
const DEFAULT_DREAMING_PRUNE_PROTECT_MIN_IMPORTANCE = 9;

const DEFAULT_DREAMING_IMPORTANCE_THRESHOLD = 25;
const DEFAULT_DREAMING_MIN_INTERVAL_MINUTES = 30;
const DEFAULT_DREAMING_EXTRACT_MAX_SESSIONS = 8;
const DEFAULT_DREAMING_EXTRACT_MAX_CHUNKS = 12;
const DEFAULT_DREAMING_CONTEXT_LOOKUP_MAX_NEIGHBORS = 5;
const DEFAULT_DREAMING_MAX_PROFILE_DURABLES = 8;
const DEFAULT_DREAMING_DEEP_INTERVAL_HOURS = 168;

/**
 * Default claim-extraction concurrency.
 */
const DEFAULT_CLAIM_EXTRACTION_CONCURRENCY = 10;

/**
 * Default claim-extraction confidence threshold.
 */
const DEFAULT_CLAIM_EXTRACTION_CONFIDENCE_THRESHOLD = 0.8;

/**
 * Default claim-extraction entry types.
 */
const DEFAULT_CLAIM_EXTRACTION_ELIGIBLE_TYPES = ["fact", "preference", "decision", "lesson"] as const satisfies readonly DurableKind[];

/**
 * Default HTTP API port.
 */
const DEFAULT_API_PORT = 3000;

/**
 * Static auth metadata used by setup and runtime helpers.
 */
const AUTH_METHOD_DEFINITIONS: readonly AuthMethodDefinition[] = [
  {
    id: "openai-api-key",
    provider: "openai",
    title: "OpenAI API key",
    setupDescription: "Standard OpenAI API key. Pay per token.",
    preferredModels: ["gpt-5.4-mini", "gpt-5.4", "gpt-5.4-nano"],
  },
  {
    id: "openai-subscription",
    provider: "openai-codex",
    title: "OpenAI - Subscription (via Codex CLI)",
    setupDescription: "Uses your Codex CLI login. No per-token cost. Requires `codex auth`.",
    preferredModels: ["gpt-5.4-mini", "gpt-5.4"],
  },
  {
    id: "anthropic-api-key",
    provider: "anthropic",
    title: "Anthropic API key",
    setupDescription: "Standard Anthropic API key. Pay per token.",
    preferredModels: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"],
  },
  {
    id: "anthropic-oauth",
    provider: "anthropic",
    title: "Anthropic - Claude subscription (OAuth)",
    setupDescription: "Uses your Claude Code CLI login. No per-token cost.",
    preferredModels: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"],
  },
  {
    id: "anthropic-token",
    provider: "anthropic",
    title: "Anthropic - Claude subscription (long-lived token)",
    setupDescription: "Uses a Claude long-lived token instead of an API key.",
    preferredModels: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"],
  },
] as const;

const AUTH_METHOD_SET = new Set<AgenrAuthMethod>(AUTH_METHOD_DEFINITIONS.map((definition) => definition.id));

/**
 * Shared exported config defaults and registries used across setup and runtime parsing.
 */
export {
  AUTH_METHOD_DEFINITIONS,
  DEFAULT_API_PORT,
  DEFAULT_AGENR_FEATURE_FLAGS,
  AGENR_FEATURE_FLAG_KEYS,
  DEFAULT_CLAIM_EXTRACTION_CONCURRENCY,
  DEFAULT_CLAIM_EXTRACTION_CONFIDENCE_THRESHOLD,
  DEFAULT_CLAIM_EXTRACTION_ELIGIBLE_TYPES,
  DEFAULT_DREAMING_CONTEXT_LIMIT_TOKENS,
  DEFAULT_DREAMING_CONTEXT_LOOKUP_MAX_NEIGHBORS,
  DEFAULT_DREAMING_DAILY_COST_CAP,
  DEFAULT_DREAMING_DEEP_INTERVAL_HOURS,
  DEFAULT_DREAMING_EXTRACT_MAX_CHUNKS,
  DEFAULT_DREAMING_EXTRACT_MAX_SESSIONS,
  DEFAULT_DREAMING_IMPORTANCE_THRESHOLD,
  DEFAULT_DREAMING_MAX_PROFILE_DURABLES,
  DEFAULT_DREAMING_MIN_INTERVAL_MINUTES,
  DEFAULT_DREAMING_PRUNE_PROTECT_MIN_IMPORTANCE,
  DEFAULT_DREAMING_PRUNE_PROTECT_RECALLED_DAYS,
  SUPPORTED_AGENR_PROVIDERS,
};

/**
 * Supported provider identifiers.
 */
const SUPPORTED_AGENR_PROVIDERS = ["openai", "openai-codex", "anthropic"] as const satisfies readonly AgenrProvider[];

/**
 * Returns whether a string is one of agenr's supported auth methods.
 *
 * @param value - Candidate string to inspect.
 * @returns True when the value is a known auth-method ID.
 */
export function isAgenrAuthMethod(value: string): value is AgenrAuthMethod {
  return AUTH_METHOD_SET.has(value as AgenrAuthMethod);
}

/**
 * Returns whether a string is one of agenr's supported providers.
 *
 * @param value - Candidate string to inspect.
 * @returns True when the value is a supported provider.
 */
export function isAgenrProvider(value: string): value is AgenrProvider {
  return (SUPPORTED_AGENR_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Looks up the provider used by one auth method.
 *
 * @param auth - Auth method to resolve.
 * @returns Provider identifier used by pi-ai.
 */
export function authMethodToProvider(auth: AgenrAuthMethod): AgenrProvider {
  const definition = AUTH_METHOD_DEFINITIONS.find((candidate) => candidate.id === auth);
  if (!definition) {
    throw new Error(`Unsupported auth method "${auth}".`);
  }

  return definition.provider;
}

/**
 * Looks up metadata for one auth method.
 *
 * @param auth - Auth method to resolve.
 * @returns Static auth metadata used by setup and runtime helpers.
 */
export function getAuthMethodDefinition(auth: AgenrAuthMethod): AuthMethodDefinition {
  const definition = AUTH_METHOD_DEFINITIONS.find((candidate) => candidate.id === auth);
  if (!definition) {
    throw new Error(`Unsupported auth method "${auth}".`);
  }

  return definition;
}

/**
 * Returns whether one ordered entry-type list matches another exactly.
 *
 * @param left - Left candidate list.
 * @param right - Right candidate list.
 * @returns True when both lists contain the same entry types in the same order.
 */
export function sameEligibleKinds(left: readonly DurableKind[], right: readonly DurableKind[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Returns whether a string is a supported entry type.
 *
 * @param value - Candidate string to inspect.
 * @returns True when the string is one of agenr's entry types.
 */
export function isDurableKind(value: string): value is DurableKind {
  return DURABLE_KINDS.includes(value as DurableKind);
}
