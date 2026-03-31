/**
 * Configuration loading and types.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
 * Each pipeline stage can use a different provider/model combination.
 * Falls back to the top-level provider/model when not set.
 */
export interface ModelConfig {
  /** Provider name (e.g., "openai", "anthropic"). */
  provider?: string;
  /** Model ID (e.g., "gpt-5.4", "gpt-5.4-nano"). */
  model?: string;
}

/**
 * Per-pass surgeon configuration.
 */
export interface SurgeonPassConfig {
  /** Protect entries recalled within this many days (default: 14). */
  protectRecalledDays?: number;
  /** Protect entries at or above this importance (default: 9). */
  protectMinImportance?: number;
  /** Skip entries evaluated by surgeon in the last N days (default: 7). */
  skipRecentlyEvaluatedDays?: number;
}

/**
 * Surgeon module configuration.
 */
export interface SurgeonConfig {
  /** Model override for surgeon runs. */
  model?: ModelConfig;
  /** Maximum cost per run in USD (default: 15.00). */
  costCap?: number;
  /** Maximum total surgeon cost in the last 24 hours (default: 75.00). */
  dailyCostCap?: number;
  /** Context token limit override. */
  contextLimit?: number;
  /** Custom instructions appended to the surgeon system prompt. */
  customInstructions?: string;
  /** Per-pass configuration. */
  passes?: {
    retirement?: SurgeonPassConfig;
  };
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
 * Runtime configuration loaded from disk or environment overrides.
 */
export interface AgenrConfig {
  /** Selected auth method for the default extraction provider. */
  auth?: AgenrAuthMethod;

  /** Default LLM provider (e.g., "openai", "anthropic"). */
  provider?: string;

  /** Default model for LLM tasks. */
  model?: string;

  /**
   * Stored manual credentials.
   *
   * OAuth and subscription auth continue to resolve from external credential
   * stores and are not written to this object.
   */
  credentials?: AgenrStoredCredentials;

  /** Embedding model. */
  embeddingModel?: string;

  /** User-provided context injected into the extraction prompt. Helps the LLM understand what's relevant to this user. */
  extractionContext?: string;

  /** Model override for extraction (the main LLM extraction pipeline). */
  extractionModel?: ModelConfig;

  /** Model override for LLM dedup (typically a smaller/cheaper model). */
  dedupModel?: ModelConfig;

  /** Model override for episode summary generation (CLI backfill). */
  episodeModel?: ModelConfig;

  /** Surgeon module configuration. */
  surgeon?: SurgeonConfig;

  /** Database file path (overridden by AGENR_DB_PATH env var). */
  dbPath?: string;

  /** HTTP API port (default: 3000). */
  apiPort?: number;
}

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), ".agenr");
const DEFAULT_DB_NAME = "knowledge.db";
const CONFIG_DIR_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;

const DEFAULT_SURGEON_COST_CAP = 15.0;
const DEFAULT_SURGEON_DAILY_COST_CAP = 75.0;
const DEFAULT_SURGEON_CONTEXT_LIMIT = 0;
const DEFAULT_SURGEON_RETIREMENT_PROTECT_RECALLED_DAYS = 14;
const DEFAULT_SURGEON_RETIREMENT_PROTECT_MIN_IMPORTANCE = 9;
const DEFAULT_SURGEON_SKIP_RECENTLY_EVALUATED_DAYS = 7;

export {
  DEFAULT_SURGEON_CONTEXT_LIMIT,
  DEFAULT_SURGEON_COST_CAP,
  DEFAULT_SURGEON_DAILY_COST_CAP,
  DEFAULT_SURGEON_RETIREMENT_PROTECT_MIN_IMPORTANCE,
  DEFAULT_SURGEON_RETIREMENT_PROTECT_RECALLED_DAYS,
  DEFAULT_SURGEON_SKIP_RECENTLY_EVALUATED_DAYS,
};

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
 * Overrides used when resolving the agenr config file path.
 */
export interface ResolveConfigPathOptions {
  /** Explicit config file path. */
  configPath?: string;

  /** Database path used to infer an adjacent `config.json` when available. */
  dbPath?: string;
}

/**
 * Resolves the directory that stores agenr configuration files.
 *
 * @returns Absolute path to the configuration directory.
 */
export function resolveConfigDir(): string {
  return process.env.AGENR_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
}

/**
 * Resolves the JSON config file path.
 *
 * Resolution order:
 * 1. `AGENR_CONFIG_PATH`
 * 2. Explicit `configPath`
 * 3. `config.json` next to the configured database path
 * 4. Default config directory
 *
 * @param options - Optional overrides used during path resolution.
 * @returns Absolute path to the config file.
 */
export function resolveConfigPath(options: ResolveConfigPathOptions = {}): string {
  const envConfigPath = normalizeOptionalString(process.env.AGENR_CONFIG_PATH);
  if (envConfigPath) {
    return envConfigPath;
  }

  const explicitConfigPath = normalizeOptionalString(options.configPath);
  if (explicitConfigPath) {
    return explicitConfigPath;
  }

  const adjacentConfigPath = resolveAdjacentConfigPath(options.dbPath);
  if (adjacentConfigPath) {
    return adjacentConfigPath;
  }

  return path.join(resolveConfigDir(), "config.json");
}

/**
 * Resolves the knowledge database path using environment and config fallbacks.
 *
 * @param config - Optional loaded configuration values.
 * @returns Absolute path to the SQLite database file.
 */
export function resolveDbPath(config?: AgenrConfig): string {
  return process.env.AGENR_DB_PATH ?? config?.dbPath ?? path.join(resolveConfigDir(), DEFAULT_DB_NAME);
}

/**
 * Reads the persisted agenr configuration file when it exists.
 *
 * @param options - Optional config path overrides.
 * @returns Parsed configuration values, or an empty object when unavailable.
 * @throws Error When the file still uses removed legacy auth fields.
 */
export function readConfig(options: ResolveConfigPathOptions = {}): AgenrConfig {
  const configPath = resolveFilesystemPath(resolveConfigPath(options));
  if (!fs.existsSync(configPath)) {
    return {};
  }

  let parsed: unknown;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {};
  }

  if (!isRecord(parsed)) {
    return {};
  }

  assertSupportedConfig(parsed, configPath);
  return parsed as AgenrConfig;
}

/**
 * Checks whether the persisted agenr configuration file exists on disk.
 *
 * @param options - Optional config path overrides.
 * @returns True when the resolved config path exists.
 */
export function configFileExists(options: ResolveConfigPathOptions = {}): boolean {
  return fs.existsSync(resolveFilesystemPath(resolveConfigPath(options)));
}

/**
 * Persists the agenr configuration file with locked-down permissions.
 *
 * @param config - Configuration values to write.
 * @param options - Optional config path overrides.
 * @throws Error When the config still contains removed legacy auth fields.
 */
export function writeConfig(config: AgenrConfig, options: ResolveConfigPathOptions = {}): void {
  const configPath = resolveFilesystemPath(resolveConfigPath(options));
  const configDir = path.dirname(configPath);
  assertSupportedConfig(config as Record<string, unknown>, configPath);

  fs.mkdirSync(configDir, { recursive: true, mode: CONFIG_DIR_MODE });
  try {
    fs.chmodSync(configDir, CONFIG_DIR_MODE);
  } catch {
    // Best-effort permission hardening.
  }

  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf-8",
    mode: CONFIG_FILE_MODE,
  });

  try {
    fs.chmodSync(configPath, CONFIG_FILE_MODE);
  } catch {
    // Best-effort permission hardening.
  }
}

/** Resolves an adjacent `config.json` path from a database path when possible. */
function resolveAdjacentConfigPath(dbPath?: string): string | undefined {
  const normalizedDbPath = normalizeOptionalString(dbPath);
  if (!normalizedDbPath || normalizedDbPath === ":memory:") {
    return undefined;
  }

  if (normalizedDbPath.startsWith("file:")) {
    try {
      return path.join(path.dirname(fileURLToPath(normalizedDbPath)), "config.json");
    } catch {
      return undefined;
    }
  }

  return path.join(path.dirname(normalizedDbPath), "config.json");
}

/** Normalizes optional string input into a trimmed value when present. */
function normalizeOptionalString(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

/** Throws when a loaded config still uses removed legacy auth fields. */
function assertSupportedConfig(config: Record<string, unknown>, configPath: string): void {
  const unsupportedFields = ["apiKey", "embeddingApiKey"].filter((field) => field in config);
  if (unsupportedFields.length === 0) {
    return;
  }

  throw new Error(
    `Unsupported agenr config field(s) in ${configPath}: ${unsupportedFields.join(", ")}. ` +
      "Move `apiKey` to `credentials.openaiApiKey` or `credentials.anthropicApiKey` depending on your configured auth, " +
      "move `embeddingApiKey` to `credentials.openaiApiKey`, then remove the legacy fields.",
  );
}

/** Converts filesystem-style or file-URL config paths into usable disk paths. */
function resolveFilesystemPath(targetPath: string): string {
  if (!targetPath.startsWith("file:")) {
    return targetPath;
  }

  try {
    return fileURLToPath(targetPath);
  } catch {
    return targetPath;
  }
}

/** Returns whether one parsed config value is an object-like record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
