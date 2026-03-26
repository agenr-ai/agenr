/**
 * Configuration loading and types.
 * Minimal — no legacy handling, no deprecated fields.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Runtime configuration loaded from disk or environment overrides.
 */
export interface AgenrConfig {
  /** LLM provider (e.g., "openai", "anthropic"). */
  provider?: string;

  /** Default model for extraction and other LLM tasks. */
  model?: string;

  /** API key (prefer env var AGENR_API_KEY). */
  apiKey?: string;

  /** Embedding model. */
  embeddingModel?: string;

  /** Database file path (overridden by AGENR_DB_PATH env var). */
  dbPath?: string;

  /** HTTP API port (default: 3000). */
  apiPort?: number;
}

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), ".agenr");
const DEFAULT_DB_NAME = "knowledge.db";

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
 * @returns Absolute path to the config file.
 */
export function resolveConfigPath(): string {
  return process.env.AGENR_CONFIG_PATH ?? path.join(resolveConfigDir(), "config.json");
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
 * @returns Parsed configuration values, or an empty object when unavailable.
 */
export function readConfig(): AgenrConfig {
  const configPath = resolveConfigPath();
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
