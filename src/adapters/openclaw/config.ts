import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";

import type { AgenrOpenClawPluginConfig } from "./types.js";
import pluginManifest from "./openclaw.plugin.json" with { type: "json" };

/**
 * Minimal manifest shape needed by the adapter-side config parser.
 */
type ManifestWithConfig = {
  configSchema: Record<string, unknown>;
  uiHints?: Record<string, { label?: string; help?: string; sensitive?: boolean }>;
};

const manifest = pluginManifest as ManifestWithConfig;

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
  const normalized: AgenrOpenClawPluginConfig = {};

  for (const key of ["dbPath", "apiKey", "embeddingApiKey", "embeddingModel"] as const) {
    const rawValue = value[key];
    if (rawValue === undefined) {
      continue;
    }

    if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
      errors.push(`${key} must be a non-empty string when provided`);
      continue;
    }

    normalized[key] = rawValue.trim();
  }

  const allowedKeys = new Set(["dbPath", "apiKey", "embeddingApiKey", "embeddingModel"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      errors.push(`unknown config field: ${key}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: normalized };
}

/**
 * Coerces the plugin config supplied by OpenClaw into a normalized runtime shape.
 *
 * @param value - Raw or partially typed plugin config from OpenClaw.
 * @returns Normalized config values with invalid fields dropped.
 */
export function coerceAgenrOpenClawPluginConfig(value: unknown): AgenrOpenClawPluginConfig {
  const normalized = normalizeAgenrOpenClawPluginConfig(value);
  return normalized.ok ? normalized.value : {};
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
