import type { PluginClaimSlotPolicyConfig, PluginInjectionMemoryPolicyConfig } from "../../app/plugin-runtime/types.js";
import type { ClaimSlotPolicy } from "../../core/claim-slot-policy.js";
import { normalizeOptionalBoolean, normalizeOptionalPositiveInteger, normalizeOptionalUnitInterval } from "./plugin-config-validators.js";

/**
 * Validates and normalizes the nested `memoryPolicy` plugin config block.
 *
 * @param value - Raw nested config value.
 * @returns Normalized memory-policy config or stable validation errors.
 */
export function normalizePluginInjectionMemoryPolicyConfig(
  value: unknown,
): { ok: true; value: PluginInjectionMemoryPolicyConfig | undefined } | { ok: false; errors: string[] } {
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

  const beforeTurnResult = normalizeBeforeTurnMemoryPolicyConfig(value.beforeTurn);
  if (!beforeTurnResult.ok) {
    errors.push(...beforeTurnResult.errors);
  }

  const episodesResult = normalizeEpisodeMemoryPolicyConfig(value.episodes);
  if (!episodesResult.ok) {
    errors.push(...episodesResult.errors);
  }

  const allowedKeys = new Set(["slotPolicies", "sessionStart", "beforeTurn", "episodes"]);
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
      (slotPoliciesResult.ok && slotPoliciesResult.value) ||
      (sessionStartResult.ok && sessionStartResult.value) ||
      (beforeTurnResult.ok && beforeTurnResult.value) ||
      (episodesResult.ok && episodesResult.value)
        ? {
            ...(slotPoliciesResult.ok && slotPoliciesResult.value ? { slotPolicies: slotPoliciesResult.value } : {}),
            ...(sessionStartResult.ok && sessionStartResult.value ? { sessionStart: sessionStartResult.value } : {}),
            ...(beforeTurnResult.ok && beforeTurnResult.value ? { beforeTurn: beforeTurnResult.value } : {}),
            ...(episodesResult.ok && episodesResult.value ? { episodes: episodesResult.value } : {}),
          }
        : undefined,
  };
}

/**
 * Validates and normalizes episode-write overrides nested under `memoryPolicy`.
 *
 * @param value - Raw nested config value.
 * @returns Normalized episode overrides or stable validation errors.
 */
function normalizeEpisodeMemoryPolicyConfig(
  value: unknown,
): { ok: true; value: PluginInjectionMemoryPolicyConfig["episodes"] | undefined } | { ok: false; errors: string[] } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  if (!isRecord(value)) {
    return { ok: false, errors: ["memoryPolicy.episodes must be an object when provided"] };
  }

  const errors: string[] = [];
  const enabled = normalizeOptionalBoolean(value.enabled, "memoryPolicy.episodes.enabled", errors);

  const allowedKeys = new Set(["enabled"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      errors.push(`unknown config field: memoryPolicy.episodes.${key}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: enabled !== undefined ? { enabled } : undefined,
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
): { ok: true; value: PluginInjectionMemoryPolicyConfig["sessionStart"] | undefined } | { ok: false; errors: string[] } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  if (!isRecord(value)) {
    return { ok: false, errors: ["memoryPolicy.sessionStart must be an object when provided"] };
  }

  const errors: string[] = [];
  const enabled = normalizeOptionalBoolean(value.enabled, "memoryPolicy.sessionStart.enabled", errors);
  const coreMemory = normalizeOptionalBoolean(value.coreMemory, "memoryPolicy.sessionStart.coreMemory", errors);
  const relevantDurableMemory = normalizeOptionalBoolean(value.relevantDurableMemory, "memoryPolicy.sessionStart.relevantDurableMemory", errors);

  const allowedKeys = new Set(["enabled", "coreMemory", "relevantDurableMemory"]);
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
    value:
      enabled !== undefined || coreMemory !== undefined || relevantDurableMemory !== undefined
        ? {
            ...(enabled !== undefined ? { enabled } : {}),
            ...(coreMemory !== undefined ? { coreMemory } : {}),
            ...(relevantDurableMemory !== undefined ? { relevantDurableMemory } : {}),
          }
        : undefined,
  };
}

/**
 * Validates and normalizes before-turn overrides nested under `memoryPolicy`.
 *
 * @param value - Raw nested config value.
 * @returns Normalized before-turn overrides or stable validation errors.
 */
function normalizeBeforeTurnMemoryPolicyConfig(
  value: unknown,
): { ok: true; value: PluginInjectionMemoryPolicyConfig["beforeTurn"] | undefined } | { ok: false; errors: string[] } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  if (!isRecord(value)) {
    return { ok: false, errors: ["memoryPolicy.beforeTurn must be an object when provided"] };
  }

  const errors: string[] = [];
  const enabled = normalizeOptionalBoolean(value.enabled, "memoryPolicy.beforeTurn.enabled", errors);
  const procedureSuggestion = normalizeOptionalBoolean(value.procedureSuggestion, "memoryPolicy.beforeTurn.procedureSuggestion", errors);
  const maxDurableEntries = normalizeOptionalPositiveInteger(value.maxDurableEntries, "memoryPolicy.beforeTurn.maxDurableEntries", errors);
  const recallThreshold = normalizeOptionalUnitInterval(value.recallThreshold, "memoryPolicy.beforeTurn.recallThreshold", errors);
  const highConfidenceRecallThreshold = normalizeOptionalUnitInterval(
    value.highConfidenceRecallThreshold,
    "memoryPolicy.beforeTurn.highConfidenceRecallThreshold",
    errors,
  );
  const procedureThreshold = normalizeOptionalUnitInterval(value.procedureThreshold, "memoryPolicy.beforeTurn.procedureThreshold", errors);

  const allowedKeys = new Set([
    "enabled",
    "procedureSuggestion",
    "maxDurableEntries",
    "recallThreshold",
    "highConfidenceRecallThreshold",
    "procedureThreshold",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      errors.push(`unknown config field: memoryPolicy.beforeTurn.${key}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value:
      enabled !== undefined ||
      procedureSuggestion !== undefined ||
      maxDurableEntries !== undefined ||
      recallThreshold !== undefined ||
      highConfidenceRecallThreshold !== undefined ||
      procedureThreshold !== undefined
        ? {
            ...(enabled !== undefined ? { enabled } : {}),
            ...(procedureSuggestion !== undefined ? { procedureSuggestion } : {}),
            ...(maxDurableEntries !== undefined ? { maxDurableEntries } : {}),
            ...(recallThreshold !== undefined ? { recallThreshold } : {}),
            ...(highConfidenceRecallThreshold !== undefined ? { highConfidenceRecallThreshold } : {}),
            ...(procedureThreshold !== undefined ? { procedureThreshold } : {}),
          }
        : undefined,
  };
}

/**
 * Validates and normalizes slot-policy overrides nested under `memoryPolicy`.
 *
 * @param value - Raw nested config value.
 * @returns Normalized slot-policy config or stable validation errors.
 */
function normalizeClaimSlotPolicyConfig(value: unknown): { ok: true; value: PluginClaimSlotPolicyConfig | undefined } | { ok: false; errors: string[] } {
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
 * Checks whether a raw value is a string-keyed object.
 *
 * @param value - Candidate value to inspect.
 * @returns True when the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
