import type { ExtensionAPI } from "./skeln-types.js";

import type { PluginInjectionMemoryPolicyConfig } from "../../app/plugin-runtime/types.js";
import { normalizePluginInjectionMemoryPolicyConfig } from "../shared/plugin-memory-policy-config.js";

/**
 * Result of reading the Skeln `goals` extension setting.
 * Defaults to true when absent.
 */
export type SkelnGoalsSettingResult = { ok: true; value: boolean } | { ok: false; error: string };

/**
 * Reads the `goals` extension setting (boolean, defaults to true).
 * When true (default): enable full goal system, goal tools, /goal commands, goal working sets.
 * When false: disable goals and goal tools, but keep independent `agenr_work` session working set.
 */
export function readSkelnGoalsSetting(skeln: Pick<ExtensionAPI, "getSetting">): SkelnGoalsSettingResult {
  const value = skeln.getSetting("goals");
  if (value === undefined) {
    return { ok: true, value: true };
  }
  if (typeof value === "boolean") {
    return { ok: true, value };
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return { ok: true, value: true };
    }
    if (normalized === "false" || normalized === "0" || normalized === "no") {
      return { ok: true, value: false };
    }
  }
  return { ok: false, error: "goals must be boolean or boolean-like string (true/false)" };
}

/** Result of parsing the Skeln `memoryPolicy` extension setting. */
export type SkelnMemoryPolicySettingResult = { ok: true; value: PluginInjectionMemoryPolicyConfig | undefined } | { ok: false; error: string };

/**
 * Parses one JSON-encoded `memoryPolicy` extension setting.
 *
 * @param raw - Raw JSON string from Skeln extension settings.
 * @returns Normalized memory policy or a stable validation error.
 */
export function parseSkelnMemoryPolicyJson(raw: string): SkelnMemoryPolicySettingResult {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizePluginInjectionMemoryPolicyConfig(parsed);
    if (!normalized.ok) {
      return { ok: false, error: normalized.errors.join("; ") };
    }

    return { ok: true, value: normalized.value };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `memoryPolicy must be valid JSON: ${message}` };
  }
}

/**
 * Reads and validates the Skeln `memoryPolicy` extension setting.
 *
 * @param skeln - Skeln extension API for the active runtime.
 * @returns Normalized memory policy or a stable validation error.
 */
export function readSkelnMemoryPolicySetting(skeln: Pick<ExtensionAPI, "getSetting">): SkelnMemoryPolicySettingResult {
  const value = skeln.getSetting("memoryPolicy");
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, error: "memoryPolicy must be a non-empty JSON string when provided" };
  }

  return parseSkelnMemoryPolicyJson(value.trim());
}

/**
 * Merges Skeln settings and programmatic memory-policy overrides.
 *
 * Programmatic overrides win at each nested level when both sides provide values.
 *
 * @param fromSettings - Memory policy parsed from Skeln extension settings.
 * @param fromOptions - Memory policy supplied by the host registration call.
 * @returns Combined memory policy when either side provides values.
 */
export function mergeSkelnMemoryPolicy(
  fromSettings: PluginInjectionMemoryPolicyConfig | undefined,
  fromOptions: PluginInjectionMemoryPolicyConfig | undefined,
): PluginInjectionMemoryPolicyConfig | undefined {
  if (!fromSettings) {
    return fromOptions;
  }

  if (!fromOptions) {
    return fromSettings;
  }

  const slotPolicies = mergeSlotPolicies(fromSettings.slotPolicies, fromOptions.slotPolicies);
  const sessionStart = fromSettings.sessionStart || fromOptions.sessionStart ? { ...fromSettings.sessionStart, ...fromOptions.sessionStart } : undefined;
  const beforeTurn = fromSettings.beforeTurn || fromOptions.beforeTurn ? { ...fromSettings.beforeTurn, ...fromOptions.beforeTurn } : undefined;
  const episodes = fromSettings.episodes || fromOptions.episodes ? { ...fromSettings.episodes, ...fromOptions.episodes } : undefined;

  if (!slotPolicies && !sessionStart && !beforeTurn && !episodes) {
    return undefined;
  }

  return {
    ...(slotPolicies ? { slotPolicies } : {}),
    ...(sessionStart ? { sessionStart } : {}),
    ...(beforeTurn ? { beforeTurn } : {}),
    ...(episodes ? { episodes } : {}),
  };
}

/** Merges slot-policy overrides from settings and programmatic registration options. */
function mergeSlotPolicies(
  fromSettings: PluginInjectionMemoryPolicyConfig["slotPolicies"],
  fromOptions: PluginInjectionMemoryPolicyConfig["slotPolicies"],
): PluginInjectionMemoryPolicyConfig["slotPolicies"] {
  if (!fromSettings) {
    return fromOptions;
  }

  if (!fromOptions) {
    return fromSettings;
  }

  const attributeHeads =
    fromSettings.attributeHeads || fromOptions.attributeHeads
      ? {
          ...fromSettings.attributeHeads,
          ...fromOptions.attributeHeads,
        }
      : undefined;

  if (!attributeHeads) {
    return undefined;
  }

  return { attributeHeads };
}
