/**
 * Configuration loading and runtime-facing config helpers.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalizeAgenrConfigInput, parseAgenrConfig, toAgenrConfigInput } from "./adapters/config/parse-agenr-config.js";
import {
  authMethodToProvider,
  AGENR_FEATURE_FLAG_KEYS,
  getAuthMethodDefinition,
  isAgenrAuthMethod,
  DEFAULT_API_PORT,
  DEFAULT_AGENR_FEATURE_FLAGS,
  DEFAULT_CLAIM_EXTRACTION_CONCURRENCY,
  DEFAULT_CLAIM_EXTRACTION_CONFIDENCE_THRESHOLD,
  DEFAULT_CLAIM_EXTRACTION_ELIGIBLE_TYPES,
  DEFAULT_SURGEON_CONTEXT_LIMIT,
  DEFAULT_SURGEON_COST_CAP,
  DEFAULT_SURGEON_DAILY_COST_CAP,
  DEFAULT_SURGEON_RETIREMENT_PROTECT_MIN_IMPORTANCE,
  DEFAULT_SURGEON_RETIREMENT_PROTECT_RECALLED_DAYS,
  DEFAULT_SURGEON_SKIP_RECENTLY_EVALUATED_DAYS,
  type AgenrAuthMethod,
  type AgenrClaimExtractionConfig,
  type AgenrConfig,
  type AgenrConfigInput,
  type AgenrFeatureFlagConfig,
  type AgenrFeatureFlagKey,
  type AgenrProvider,
  type AgenrStoredCredentials,
  type AuthMethodDefinition,
  type ModelConfig,
  type ResolvedAgenrConfig,
  type ResolvedAgenrFeatureFlags,
  type SurgeonConfig,
  type SurgeonPassConfig,
} from "./adapters/config/types.js";
import type { ClaimExtractionConfig } from "./core/store/claim-extraction.js";

/**
 * Overrides used when resolving the agenr config file path.
 */
export interface ResolveConfigPathOptions {
  /** Explicit config file path. */
  configPath?: string;
  /** Database path used to infer an adjacent `config.json` when available. */
  dbPath?: string;
}

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), ".agenr");
const DEFAULT_DB_NAME = "knowledge.db";
const CONFIG_DIR_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;

export {
  authMethodToProvider,
  AGENR_FEATURE_FLAG_KEYS,
  DEFAULT_API_PORT,
  DEFAULT_AGENR_FEATURE_FLAGS,
  DEFAULT_CLAIM_EXTRACTION_CONCURRENCY,
  DEFAULT_CLAIM_EXTRACTION_CONFIDENCE_THRESHOLD,
  DEFAULT_CLAIM_EXTRACTION_ELIGIBLE_TYPES,
  DEFAULT_SURGEON_CONTEXT_LIMIT,
  DEFAULT_SURGEON_COST_CAP,
  DEFAULT_SURGEON_DAILY_COST_CAP,
  DEFAULT_SURGEON_RETIREMENT_PROTECT_MIN_IMPORTANCE,
  DEFAULT_SURGEON_RETIREMENT_PROTECT_RECALLED_DAYS,
  DEFAULT_SURGEON_SKIP_RECENTLY_EVALUATED_DAYS,
  getAuthMethodDefinition,
  isAgenrAuthMethod,
  toAgenrConfigInput,
  type AgenrAuthMethod,
  type AgenrClaimExtractionConfig,
  type AgenrConfig,
  type AgenrConfigInput,
  type AgenrFeatureFlagConfig,
  type AgenrFeatureFlagKey,
  type AgenrProvider,
  type AgenrStoredCredentials,
  type AuthMethodDefinition,
  type ModelConfig,
  type ResolvedAgenrConfig,
  type ResolvedAgenrFeatureFlags,
  type SurgeonConfig,
  type SurgeonPassConfig,
};

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
 * @param config - Optional loaded or partial configuration values.
 * @returns Absolute or configured SQLite database path.
 */
export function resolveDbPath(config?: AgenrConfigInput | ResolvedAgenrConfig): string {
  return normalizeOptionalString(process.env.AGENR_DB_PATH) ?? normalizeOptionalString(config?.dbPath) ?? resolvePersistedDefaultDbPath();
}

/**
 * Resolves claim-extraction overrides into a fully populated runtime config.
 *
 * @param config - Optional loaded or partial configuration values.
 * @returns Claim-extraction settings with defaults applied.
 */
export function resolveClaimExtractionConfig(config?: AgenrConfigInput | ResolvedAgenrConfig): ClaimExtractionConfig {
  if (config && "enabled" in (config.claimExtraction ?? {})) {
    const claimExtraction = config.claimExtraction as Partial<ResolvedAgenrConfig["claimExtraction"]>;
    if (
      typeof claimExtraction.enabled === "boolean" &&
      typeof claimExtraction.confidenceThreshold === "number" &&
      Array.isArray(claimExtraction.eligibleTypes) &&
      typeof claimExtraction.concurrency === "number"
    ) {
      return {
        enabled: claimExtraction.enabled,
        confidenceThreshold: claimExtraction.confidenceThreshold,
        eligibleTypes: [...claimExtraction.eligibleTypes],
        concurrency: claimExtraction.concurrency,
      };
    }
  }

  const parsed = parseAgenrConfig(
    {
      ...(config?.claimExtraction ? { claimExtraction: config.claimExtraction as AgenrClaimExtractionConfig } : {}),
    },
    {
      defaultDbPath: resolvePersistedDefaultDbPath(),
    },
  );

  if (!parsed.ok) {
    return {
      enabled: true,
      confidenceThreshold: DEFAULT_CLAIM_EXTRACTION_CONFIDENCE_THRESHOLD,
      eligibleTypes: [...DEFAULT_CLAIM_EXTRACTION_ELIGIBLE_TYPES],
      concurrency: DEFAULT_CLAIM_EXTRACTION_CONCURRENCY,
    };
  }

  return {
    enabled: parsed.value.claimExtraction.enabled,
    confidenceThreshold: parsed.value.claimExtraction.confidenceThreshold,
    eligibleTypes: [...parsed.value.claimExtraction.eligibleTypes],
    concurrency: parsed.value.claimExtraction.concurrency,
  };
}

/**
 * Reads the persisted agenr configuration file when it exists.
 *
 * @param options - Optional config path overrides.
 * @returns Fully resolved configuration values.
 * @throws Error When the file contains malformed JSON or invalid config data.
 */
export function readConfig(options: ResolveConfigPathOptions = {}): ResolvedAgenrConfig {
  const configPath = resolveFilesystemPath(resolveConfigPath(options));
  const defaultDbPath = resolveReadDefaultDbPath(options);

  if (!fs.existsSync(configPath)) {
    const parsed = parseAgenrConfig(undefined, { defaultDbPath });
    if (!parsed.ok) {
      throw new Error("Internal config parser failure for empty config.");
    }

    return parsed.value;
  }

  let parsedJson: unknown;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    parsedJson = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid agenr config at ${configPath}: JSON parse failed - ${message}`, {
      cause: error,
    });
  }

  const parsed = parseAgenrConfig(parsedJson, { defaultDbPath });
  if (!parsed.ok) {
    throw new Error(formatConfigValidationError(configPath, parsed.issues));
  }

  return parsed.value;
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
 * @throws Error When the config contains invalid values.
 */
export function writeConfig(config: AgenrConfigInput, options: ResolveConfigPathOptions = {}): void {
  const configPath = resolveFilesystemPath(resolveConfigPath(options));
  const configDir = path.dirname(configPath);
  const canonical = canonicalizeAgenrConfigInput(config, {
    defaultDbPath: resolvePersistedDefaultDbPath(),
  });

  if (!canonical.ok) {
    throw new Error(formatConfigValidationError(configPath, canonical.issues));
  }

  fs.mkdirSync(configDir, { recursive: true, mode: CONFIG_DIR_MODE });
  try {
    fs.chmodSync(configDir, CONFIG_DIR_MODE);
  } catch {
    // Best-effort permission hardening.
  }

  fs.writeFileSync(configPath, `${JSON.stringify(canonical.value, null, 2)}\n`, {
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

/** Resolves the default persisted database path before env overrides apply. */
function resolvePersistedDefaultDbPath(): string {
  return path.join(resolveConfigDir(), DEFAULT_DB_NAME);
}

/** Resolves the runtime default database path with env and caller overrides applied. */
function resolveReadDefaultDbPath(options: ResolveConfigPathOptions): string {
  return normalizeOptionalString(process.env.AGENR_DB_PATH) ?? normalizeOptionalString(options.dbPath) ?? resolvePersistedDefaultDbPath();
}

/** Formats config-validation issues into one stable error string. */
function formatConfigValidationError(
  configPath: string,
  issues: ReadonlyArray<{
    path: string;
    message: string;
  }>,
): string {
  const details = issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");

  return `Invalid agenr config at ${configPath}: ${details}`;
}
