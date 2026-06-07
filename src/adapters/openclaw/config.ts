import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";

import { normalizePluginInjectionMemoryPolicyConfig } from "../shared/plugin-memory-policy-config.js";
import { normalizeOptionalBoolean } from "../shared/plugin-config-validators.js";
import type { AgenrOpenClawDebugConfig, AgenrOpenClawDebugEventLevel, AgenrOpenClawPluginConfig } from "./types.js";
import pluginManifest from "./openclaw.plugin.json" with { type: "json" };

/**
 * Minimal manifest shape needed by the adapter-side config parser.
 */
type ManifestWithConfig = {
  configSchema: Record<string, unknown>;
  uiHints?: Record<string, { label?: string; help?: string; sensitive?: boolean }>;
};

const manifest = pluginManifest as ManifestWithConfig;
const DEFAULT_DEBUG_EVENT_LEVEL: AgenrOpenClawDebugEventLevel = "basic";
const DEFAULT_DEBUG_PER_SESSION_FILES = false;
const DEFAULT_DEBUG_MAX_TOP_CANDIDATES = 10;
const MAX_DEBUG_MAX_TOP_CANDIDATES = 25;

/**
 * Normalizes raw plugin config into the adapter's runtime shape.
 *
 * @param value - Raw plugin config supplied by OpenClaw after manifest validation.
 * @returns Parsed config or stable validation errors.
 */
export function normalizeAgenrOpenClawPluginConfig(value: unknown): { ok: true; value: AgenrOpenClawPluginConfig } | { ok: false; errors: string[] } {
  if (value === undefined) {
    return { ok: true, value: {} };
  }

  if (!isRecord(value)) {
    return { ok: false, errors: ["config must be an object"] };
  }

  const errors: string[] = [];
  const rawDbPath = value.dbPath;
  const dbPath = typeof rawDbPath === "string" ? rawDbPath.trim() : undefined;
  if (rawDbPath !== undefined && !dbPath) {
    errors.push("dbPath must be a non-empty string");
  }

  const rawConfigPath = value.configPath;
  const configPath = typeof rawConfigPath === "string" ? rawConfigPath.trim() : undefined;
  if (rawConfigPath !== undefined && !configPath) {
    errors.push("configPath must be a non-empty string when provided");
  }

  const rawEpisodeModel = value.episodeModel;
  const episodeModel = typeof rawEpisodeModel === "string" ? rawEpisodeModel.trim() : undefined;
  if (rawEpisodeModel !== undefined && !episodeModel) {
    errors.push("episodeModel must be a non-empty string when provided");
  } else if (episodeModel && !episodeModel.includes("/")) {
    errors.push("episodeModel must use provider/model format when provided");
  }

  const rawClaimExtractionModel = value.claimExtractionModel;
  const claimExtractionModel = typeof rawClaimExtractionModel === "string" ? rawClaimExtractionModel.trim() : undefined;
  if (rawClaimExtractionModel !== undefined && !claimExtractionModel) {
    errors.push("claimExtractionModel must be a non-empty string when provided");
  } else if (claimExtractionModel && !claimExtractionModel.includes("/")) {
    errors.push("claimExtractionModel must use provider/model format when provided");
  }

  const memoryPolicyResult = normalizePluginInjectionMemoryPolicyConfig(value.memoryPolicy);
  if (!memoryPolicyResult.ok) {
    errors.push(...memoryPolicyResult.errors);
  }

  const debugResult = normalizeDebugConfig(value.debug);
  if (!debugResult.ok) {
    errors.push(...debugResult.errors);
  }

  const allowedKeys = new Set(["dbPath", "configPath", "episodeModel", "claimExtractionModel", "memoryPolicy", "debug"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      errors.push(`unknown config field: ${key}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      ...(dbPath ? { dbPath } : {}),
      ...(configPath ? { configPath } : {}),
      ...(episodeModel ? { episodeModel } : {}),
      ...(claimExtractionModel ? { claimExtractionModel } : {}),
      ...(memoryPolicyResult.ok && memoryPolicyResult.value ? { memoryPolicy: memoryPolicyResult.value } : {}),
      ...(debugResult.ok && debugResult.value ? { debug: debugResult.value } : {}),
    },
  };
}

/**
 * Coerces the plugin config supplied by OpenClaw into a normalized runtime shape.
 *
 * @param value - Raw or partially typed plugin config from OpenClaw.
 * @returns Normalized config values.
 * @throws Error When validation fails.
 */
export function coerceAgenrOpenClawPluginConfig(value: unknown): AgenrOpenClawPluginConfig {
  const normalized = normalizeAgenrOpenClawPluginConfig(value);
  if (normalized.ok) {
    return normalized.value;
  }

  throw new Error(`Invalid agenr OpenClaw plugin config: ${normalized.errors.join("; ")}`);
}

/**
 * Builds the runtime config schema passed into `definePluginEntry(...)`.
 *
 * @returns OpenClaw plugin config schema backed by agenr's manifest metadata.
 */
export function createAgenrOpenClawPluginConfigSchema(): OpenClawPluginConfigSchema {
  return {
    validate(value) {
      const parsed = normalizeAgenrOpenClawPluginConfig(value);
      return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, errors: parsed.errors };
    },
    ...(manifest.uiHints ? { uiHints: manifest.uiHints } : {}),
    jsonSchema: manifest.configSchema,
  };
}

/**
 * Checks whether a raw value is a string-keyed object.
 *
 * @param value - Candidate value to inspect.
 * @returns True when the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fully resolved debug-sink settings used by the runtime factory.
 */
export interface ResolvedAgenrOpenClawDebugConfig {
  enabled: boolean;
  logPath?: string;
  eventLevel: AgenrOpenClawDebugEventLevel;
  perSessionFiles: boolean;
  maxTopCandidates: number;
}

/**
 * Resolves debug-sink settings with defaults for omitted fields.
 *
 * @param value - Optional normalized debug config from the plugin config.
 * @returns Fully resolved debug-sink settings suitable for the runtime.
 */
export function resolveDebugConfig(value: AgenrOpenClawDebugConfig | undefined): ResolvedAgenrOpenClawDebugConfig {
  const logPath = value?.logPath?.trim();
  return {
    enabled: value?.enabled ?? false,
    ...(logPath ? { logPath } : {}),
    eventLevel: value?.eventLevel ?? DEFAULT_DEBUG_EVENT_LEVEL,
    perSessionFiles: value?.perSessionFiles ?? DEFAULT_DEBUG_PER_SESSION_FILES,
    maxTopCandidates: value?.maxTopCandidates ?? DEFAULT_DEBUG_MAX_TOP_CANDIDATES,
  };
}

/**
 * Validates and normalizes the nested `debug` plugin config block.
 *
 * @param value - Raw nested config value.
 * @returns Normalized debug config or stable validation errors.
 */
function normalizeDebugConfig(value: unknown): { ok: true; value: AgenrOpenClawDebugConfig | undefined } | { ok: false; errors: string[] } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  if (!isRecord(value)) {
    return { ok: false, errors: ["debug must be an object when provided"] };
  }

  const errors: string[] = [];
  const enabled = normalizeOptionalBoolean(value.enabled, "debug.enabled", errors);
  const logPathRaw = value.logPath;
  let logPath: string | undefined;
  if (logPathRaw !== undefined) {
    if (typeof logPathRaw !== "string" || logPathRaw.trim().length === 0) {
      errors.push("debug.logPath must be a non-empty string when provided");
    } else {
      logPath = logPathRaw.trim();
    }
  }
  const eventLevel = normalizeOptionalDebugEventLevel(value.eventLevel, errors);
  const perSessionFiles = normalizeOptionalBoolean(value.perSessionFiles, "debug.perSessionFiles", errors);
  const maxTopCandidates = normalizeOptionalTopCandidateCap(value.maxTopCandidates, errors);

  const allowedKeys = new Set(["enabled", "logPath", "eventLevel", "perSessionFiles", "maxTopCandidates"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      errors.push(`unknown config field: debug.${key}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const normalized: AgenrOpenClawDebugConfig = {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(logPath !== undefined ? { logPath } : {}),
    ...(eventLevel !== undefined ? { eventLevel } : {}),
    ...(perSessionFiles !== undefined ? { perSessionFiles } : {}),
    ...(maxTopCandidates !== undefined ? { maxTopCandidates } : {}),
  };

  return {
    ok: true,
    value: Object.keys(normalized).length > 0 ? normalized : undefined,
  };
}

/**
 * Parses one optional debug-event-level field.
 *
 * @param value - Raw field value.
 * @param errors - Mutable validation error collection.
 * @returns Narrow event level when valid, otherwise `undefined`.
 */
function normalizeOptionalDebugEventLevel(value: unknown, errors: string[]): AgenrOpenClawDebugEventLevel | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "basic" || value === "detailed") {
    return value;
  }

  errors.push('debug.eventLevel must be "basic" or "detailed" when provided');
  return undefined;
}

/**
 * Parses the optional `debug.maxTopCandidates` override.
 *
 * @param value - Raw field value.
 * @param errors - Mutable validation error collection.
 * @returns Validated candidate cap when present, otherwise `undefined`.
 */
function normalizeOptionalTopCandidateCap(value: unknown, errors: string[]): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0 || value > MAX_DEBUG_MAX_TOP_CANDIDATES) {
    errors.push(`debug.maxTopCandidates must be an integer between 1 and ${MAX_DEBUG_MAX_TOP_CANDIDATES} when provided`);
    return undefined;
  }

  return value;
}
