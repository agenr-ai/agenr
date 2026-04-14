import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";

import type { ClaimSlotPolicy } from "../../core/claim-slot-policy.js";
import type { AgenrOpenClawClaimSlotPolicyConfig, AgenrOpenClawMemoryPolicyConfig, AgenrOpenClawPluginConfig, StoreNudgeConfig } from "./types.js";
import pluginManifest from "./openclaw.plugin.json" with { type: "json" };

/**
 * Minimal manifest shape needed by the adapter-side config parser.
 */
type ManifestWithConfig = {
  configSchema: Record<string, unknown>;
  uiHints?: Record<string, { label?: string; help?: string; sensitive?: boolean }>;
};

const manifest = pluginManifest as ManifestWithConfig;
const DEFAULT_STORE_NUDGE_THRESHOLD = 8;
const DEFAULT_STORE_NUDGE_MAX_PER_SESSION = 5;

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

  const rawContinuityModel = value.continuityModel;
  const continuityModel = typeof rawContinuityModel === "string" ? rawContinuityModel.trim() : undefined;
  if (rawContinuityModel !== undefined && !continuityModel) {
    errors.push("continuityModel must be a non-empty string when provided");
  } else if (continuityModel && !continuityModel.includes("/")) {
    errors.push("continuityModel must use provider/model format when provided");
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

  const storeNudgeResult = normalizeStoreNudgeConfig(value.storeNudge);
  if (!storeNudgeResult.ok) {
    errors.push(...storeNudgeResult.errors);
  }

  const memoryPolicyResult = normalizeMemoryPolicyConfig(value.memoryPolicy);
  if (!memoryPolicyResult.ok) {
    errors.push(...memoryPolicyResult.errors);
  }

  const allowedKeys = new Set(["dbPath", "configPath", "continuityModel", "episodeModel", "claimExtractionModel", "storeNudge", "memoryPolicy"]);
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
      ...(continuityModel ? { continuityModel } : {}),
      ...(episodeModel ? { episodeModel } : {}),
      ...(claimExtractionModel ? { claimExtractionModel } : {}),
      ...(storeNudgeResult.ok && storeNudgeResult.value ? { storeNudge: storeNudgeResult.value } : {}),
      ...(memoryPolicyResult.ok && memoryPolicyResult.value ? { memoryPolicy: memoryPolicyResult.value } : {}),
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
 * Resolves store-nudge settings with defaults for omitted fields.
 *
 * @param value - Optional normalized store-nudge overrides from plugin config.
 * @returns Fully resolved store-nudge settings.
 */
export function resolveStoreNudgeConfig(value: Partial<StoreNudgeConfig> | undefined): StoreNudgeConfig {
  return {
    enabled: value?.enabled ?? true,
    threshold: value?.threshold ?? DEFAULT_STORE_NUDGE_THRESHOLD,
    maxPerSession: value?.maxPerSession ?? DEFAULT_STORE_NUDGE_MAX_PER_SESSION,
  };
}

/**
 * Validates and normalizes the nested `storeNudge` plugin config block.
 *
 * Partial values are accepted so callers can override only one field while the
 * runtime still applies defaults for omitted settings.
 *
 * @param value - Raw nested config value.
 * @returns Normalized nested config or stable validation errors.
 */
function normalizeStoreNudgeConfig(value: unknown): { ok: true; value: Partial<StoreNudgeConfig> | undefined } | { ok: false; errors: string[] } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  if (!isRecord(value)) {
    return { ok: false, errors: ["storeNudge must be an object when provided"] };
  }

  const errors: string[] = [];
  const enabled = normalizeOptionalBoolean(value.enabled, "storeNudge.enabled", errors);
  const threshold = normalizeOptionalPositiveInteger(value.threshold, "storeNudge.threshold", errors);
  const maxPerSession = normalizeOptionalPositiveInteger(value.maxPerSession, "storeNudge.maxPerSession", errors);

  const allowedKeys = new Set(["enabled", "threshold", "maxPerSession"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      errors.push(`unknown config field: storeNudge.${key}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const normalizedValue: Partial<StoreNudgeConfig> = {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
    ...(maxPerSession !== undefined ? { maxPerSession } : {}),
  };

  return {
    ok: true,
    value: Object.keys(normalizedValue).length > 0 ? resolveStoreNudgeConfig(normalizedValue) : undefined,
  };
}

/**
 * Validates and normalizes the nested `memoryPolicy` plugin config block.
 *
 * @param value - Raw nested config value.
 * @returns Normalized memory-policy config or stable validation errors.
 */
function normalizeMemoryPolicyConfig(value: unknown): { ok: true; value: AgenrOpenClawMemoryPolicyConfig | undefined } | { ok: false; errors: string[] } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  if (!isRecord(value)) {
    return { ok: false, errors: ["memoryPolicy must be an object when provided"] };
  }

  const errors: string[] = [];
  const slotPoliciesResult = normalizeClaimSlotPolicyConfig(value.slotPolicies);
  if (!slotPoliciesResult.ok) {
    errors.push(...slotPoliciesResult.errors);
  }
  const sessionStartResult = normalizeSessionStartMemoryPolicyConfig(value.sessionStart);
  if (!sessionStartResult.ok) {
    errors.push(...sessionStartResult.errors);
  }

  const allowedKeys = new Set(["slotPolicies", "sessionStart"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      errors.push(`unknown config field: memoryPolicy.${key}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value:
      (slotPoliciesResult.ok && slotPoliciesResult.value) || (sessionStartResult.ok && sessionStartResult.value)
        ? {
            ...(slotPoliciesResult.ok && slotPoliciesResult.value ? { slotPolicies: slotPoliciesResult.value } : {}),
            ...(sessionStartResult.ok && sessionStartResult.value ? { sessionStart: sessionStartResult.value } : {}),
          }
        : undefined,
  };
}

/**
 * Validates and normalizes session-start overrides nested under `memoryPolicy`.
 *
 * @param value - Raw nested config value.
 * @returns Normalized session-start overrides or stable validation errors.
 */
function normalizeSessionStartMemoryPolicyConfig(
  value: unknown,
): { ok: true; value: AgenrOpenClawMemoryPolicyConfig["sessionStart"] | undefined } | { ok: false; errors: string[] } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  if (!isRecord(value)) {
    return { ok: false, errors: ["memoryPolicy.sessionStart must be an object when provided"] };
  }

  const errors: string[] = [];
  const relevantDurableMemory = normalizeOptionalBoolean(value.relevantDurableMemory, "memoryPolicy.sessionStart.relevantDurableMemory", errors);

  const allowedKeys = new Set(["relevantDurableMemory"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      errors.push(`unknown config field: memoryPolicy.sessionStart.${key}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: relevantDurableMemory !== undefined ? { relevantDurableMemory } : undefined,
  };
}

/**
 * Validates and normalizes slot-policy overrides nested under `memoryPolicy`.
 *
 * @param value - Raw nested config value.
 * @returns Normalized slot-policy config or stable validation errors.
 */
function normalizeClaimSlotPolicyConfig(value: unknown): { ok: true; value: AgenrOpenClawClaimSlotPolicyConfig | undefined } | { ok: false; errors: string[] } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  if (!isRecord(value)) {
    return { ok: false, errors: ["memoryPolicy.slotPolicies must be an object when provided"] };
  }

  const errors: string[] = [];
  const attributeHeads = normalizeClaimSlotPolicyAttributeHeads(value.attributeHeads, errors);

  const allowedKeys = new Set(["attributeHeads"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      errors.push(`unknown config field: memoryPolicy.slotPolicies.${key}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: attributeHeads ? { attributeHeads } : undefined,
  };
}

/**
 * Validates and normalizes slot-policy overrides keyed by attribute head.
 *
 * @param value - Raw nested object.
 * @param errors - Mutable validation error collection.
 * @returns Canonicalized attribute-head map when valid.
 */
function normalizeClaimSlotPolicyAttributeHeads(value: unknown, errors: string[]): Record<string, ClaimSlotPolicy> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    errors.push("memoryPolicy.slotPolicies.attributeHeads must be an object when provided");
    return undefined;
  }

  const normalized: Record<string, ClaimSlotPolicy> = {};
  for (const [rawKey, rawPolicy] of Object.entries(value)) {
    const attributeHead = rawKey.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(attributeHead)) {
      errors.push(`memoryPolicy.slotPolicies.attributeHeads.${rawKey} must use a canonical attribute-head label`);
      continue;
    }

    if (rawPolicy !== "exclusive" && rawPolicy !== "multivalued") {
      errors.push(`memoryPolicy.slotPolicies.attributeHeads.${attributeHead} must be "exclusive" or "multivalued"`);
      continue;
    }

    normalized[attributeHead] = rawPolicy;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * Parses one optional boolean plugin-config field.
 *
 * @param value - Raw field value.
 * @param label - Stable validation label.
 * @param errors - Mutable validation error collection.
 * @returns Boolean value when valid, otherwise `undefined`.
 */
function normalizeOptionalBoolean(value: unknown, label: string, errors: string[]): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    errors.push(`${label} must be a boolean when provided`);
    return undefined;
  }

  return value;
}

/**
 * Parses one optional positive-integer plugin-config field.
 *
 * @param value - Raw field value.
 * @param label - Stable validation label.
 * @param errors - Mutable validation error collection.
 * @returns Integer value when valid, otherwise `undefined`.
 */
function normalizeOptionalPositiveInteger(value: unknown, label: string, errors: string[]): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    errors.push(`${label} must be a positive integer when provided`);
    return undefined;
  }

  return value;
}
