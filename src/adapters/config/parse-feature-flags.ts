import { AGENR_FEATURE_FLAG_KEYS, DEFAULT_AGENR_FEATURE_FLAGS, type AgenrFeatureFlagConfig, type AgenrFeatureFlags } from "../../app/features/types.js";
import { parseOptionalBoolean, pushIssue, pushUnexpectedFields, isRecord, type ValidationIssue } from "../shared/validation.js";

/**
 * Parses the nested feature-flag block.
 *
 * @param value - Raw nested value.
 * @param path - Stable issue path.
 * @param issues - Mutable issue collection.
 * @returns Canonical persisted values plus the resolved runtime block.
 */
export function parseFeatureFlags(value: unknown, path: string, issues: ValidationIssue[]): { input?: AgenrFeatureFlagConfig; resolved: AgenrFeatureFlags } {
  const defaults = DEFAULT_AGENR_FEATURE_FLAGS;
  if (value === undefined) {
    return {
      resolved: { ...defaults },
    };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return {
      resolved: { ...defaults },
    };
  }

  const startIndex = issues.length;
  pushUnexpectedFields(value, new Set(AGENR_FEATURE_FLAG_KEYS), path, issues);

  const workingMemory = parseOptionalBoolean(value.workingMemory, `${path}.workingMemory`, issues);
  const sessionTreeLineage = parseOptionalBoolean(value.sessionTreeLineage, `${path}.sessionTreeLineage`, issues);
  const sessionTreeCompaction = parseOptionalBoolean(value.sessionTreeCompaction, `${path}.sessionTreeCompaction`, issues);
  const goalContinuation = parseOptionalBoolean(value.goalContinuation, `${path}.goalContinuation`, issues);

  if (issues.length > startIndex) {
    return {
      resolved: { ...defaults },
    };
  }

  const input: AgenrFeatureFlagConfig = {
    ...(workingMemory === true ? { workingMemory } : {}),
    ...(sessionTreeLineage === true ? { sessionTreeLineage } : {}),
    ...(sessionTreeCompaction === true ? { sessionTreeCompaction } : {}),
    ...(goalContinuation === true ? { goalContinuation } : {}),
  };

  return {
    ...(Object.keys(input).length > 0 ? { input } : {}),
    resolved: {
      workingMemory: workingMemory ?? defaults.workingMemory,
      sessionTreeLineage: sessionTreeLineage ?? defaults.sessionTreeLineage,
      sessionTreeCompaction: sessionTreeCompaction ?? defaults.sessionTreeCompaction,
      goalContinuation: goalContinuation ?? defaults.goalContinuation,
    },
  };
}

/**
 * Converts resolved feature flags back into the sparse persisted shape.
 *
 * @param value - Resolved feature flags.
 * @returns Sparse persisted shape, or undefined when all flags are false.
 */
export function toFeatureFlagInput(value: AgenrFeatureFlags | undefined): AgenrFeatureFlagConfig | undefined {
  if (!value) {
    return undefined;
  }

  const input: AgenrFeatureFlagConfig = {
    ...(value.workingMemory ? { workingMemory: true } : {}),
    ...(value.sessionTreeLineage ? { sessionTreeLineage: true } : {}),
    ...(value.sessionTreeCompaction ? { sessionTreeCompaction: true } : {}),
    ...(value.goalContinuation ? { goalContinuation: true } : {}),
  };

  return Object.keys(input).length > 0 ? input : undefined;
}
