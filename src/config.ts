/**
 * Configuration loading and types.
 * Minimal - no legacy handling, no deprecated fields.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
 * Runtime configuration loaded from disk or environment overrides.
 */
export interface AgenrConfig {
  /** Default LLM provider (e.g., "openai", "anthropic"). */
  provider?: string;

  /** Default model for LLM tasks. */
  model?: string;

  /** API key for LLM calls (prefer env var AGENR_API_KEY or provider-specific env vars). */
  apiKey?: string;

  /** API key specifically for embeddings. Falls back to apiKey if not set. */
  embeddingApiKey?: string;

  /** Embedding model. */
  embeddingModel?: string;

  /** User-provided context injected into the extraction prompt. Helps the LLM understand what's relevant to this user. */
  extractionContext?: string;

  /** Model override for extraction (the main LLM extraction pipeline). */
  extractionModel?: ModelConfig;

  /** Model override for LLM dedup (typically a smaller/cheaper model). */
  dedupModel?: ModelConfig;

  /** Database file path (overridden by AGENR_DB_PATH env var). */
  dbPath?: string;

  /** HTTP API port (default: 3000). */
  apiPort?: number;
}

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), ".agenr");
const DEFAULT_DB_NAME = "knowledge.db";

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
 */
export function readConfig(options: ResolveConfigPathOptions = {}): AgenrConfig {
  const configPath = resolveConfigPath(options);
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as AgenrConfig;
  } catch {
    return {};
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
