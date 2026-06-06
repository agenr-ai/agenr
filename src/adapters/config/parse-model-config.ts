import { parseOptionalTrimmedString, pushIssue, pushUnexpectedFields, isRecord, type ValidationIssue } from "../shared/validation.js";
import { isAgenrProvider, type ModelConfig } from "./types.js";

/**
 * Parses one optional provider field.
 *
 * @param value - Raw field value.
 * @param path - Stable issue path.
 * @param issues - Mutable issue collection.
 * @returns Normalized provider when valid.
 */
export function parseProvider(value: unknown, path: string, issues: ValidationIssue[]): string | undefined {
  const normalized = parseOptionalTrimmedString(value, path, issues);
  if (!normalized) {
    return undefined;
  }

  if (!isAgenrProvider(normalized)) {
    pushIssue(issues, path, "Expected a supported provider.");
    return undefined;
  }

  return normalized;
}

/**
 * Parses one optional provider/model override block.
 *
 * @param value - Raw nested value.
 * @param path - Stable issue path.
 * @param issues - Mutable issue collection.
 * @returns Canonical model override when valid.
 */
export function parseModelConfig(value: unknown, path: string, issues: ValidationIssue[]): ModelConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return undefined;
  }

  const startIndex = issues.length;
  pushUnexpectedFields(value, new Set(["provider", "model"]), path, issues);

  const provider = parseProvider(value.provider, `${path}.provider`, issues);
  const model = parseOptionalTrimmedString(value.model, `${path}.model`, issues);

  if (!provider && !model) {
    pushIssue(issues, path, "Expected at least one of provider or model.");
  }

  if (issues.length > startIndex) {
    return undefined;
  }

  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}

/**
 * Returns whether a model override contains at least one field.
 *
 * @param value - Candidate model override.
 * @returns True when the override should be persisted.
 */
export function hasModelConfig(value: ModelConfig | undefined): value is ModelConfig {
  return Boolean(value?.provider || value?.model);
}
