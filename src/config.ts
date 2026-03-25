/**
 * Configuration loading and types.
 * Minimal — no legacy handling, no deprecated fields.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

export function resolveConfigDir(): string {
  return process.env.AGENR_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
}

export function resolveConfigPath(): string {
  return process.env.AGENR_CONFIG_PATH ?? path.join(resolveConfigDir(), "config.json");
}

export function resolveDbPath(config?: AgenrConfig): string {
  return process.env.AGENR_DB_PATH ?? config?.dbPath ?? path.join(resolveConfigDir(), DEFAULT_DB_NAME);
}

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
