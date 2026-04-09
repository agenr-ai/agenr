import type {
  ClaimKeyQualityPassSummary,
  ClaimKeyQualityRepairCounts,
  ClaimKeyQualityShadowBucket,
  ClaimKeyQualityShadowBucketSummary,
} from "../../../../core/surgeon/types.js";

/**
 * Recursive deep-partial helper used by scenario expectations.
 */
export type DeepPartial<T> = T extends readonly (infer U)[]
  ? Array<DeepPartial<U>>
  : T extends object
    ? {
        [K in keyof T]?: DeepPartial<T[K]>;
      }
    : T;

const SUPPORTED_PROPOSAL_SCOPES = ["single_entry", "cluster"] as const;
const SURGEON_RUN_STATUSES = ["running", "completed", "failed", "aborted", "budget_exhausted", "cost_capped"] as const;
const CLAIM_KEY_QUALITY_EXECUTION_STYLES = ["autonomous", "targeted"] as const;
const CLAIM_KEY_QUALITY_SUPPORT_CLASSES = ["trusted_family_grounded_alignment"] as const;
const CLAIM_KEY_QUALITY_SHADOW_BUCKETS = [
  "high_density_grounded_family",
  "large_grounding_diluted_grounded_family",
  "thin_grounded_family_tail",
  "relaxed_one_sibling_stable_slot",
  "other_grounded_family_alignment",
] as const satisfies readonly ClaimKeyQualityShadowBucket[];

/**
 * Reads one raw JSON value as a string-keyed object and rejects unexpected fields.
 *
 * @param value - Raw JSON value.
 * @param label - Human-readable label used in error messages.
 * @param filePath - Source scenario path for error messages.
 * @param allowedKeys - Exact field names accepted for the object.
 * @returns Parsed string-keyed object.
 */
export function readObject(value: unknown, label: string, filePath: string, allowedKeys: ReadonlySet<string>): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid scenario ${filePath}: ${label} must be an object.`);
  }

  const record = value as Record<string, unknown>;
  rejectUnexpectedFields(record, allowedKeys, filePath, label);
  return record;
}

/**
 * Rejects unsupported fields on one parsed object.
 *
 * @param record - Parsed object to inspect.
 * @param allowedKeys - Exact field names accepted for the object.
 * @param filePath - Source scenario path for error messages.
 * @param label - Human-readable label used in error messages.
 */
export function rejectUnexpectedFields(record: Record<string, unknown>, allowedKeys: ReadonlySet<string>, filePath: string, label: string): void {
  const unexpected = Object.keys(record).filter((key) => !allowedKeys.has(key));
  if (unexpected.length === 0) {
    return;
  }

  throw new Error(`Invalid scenario ${filePath}: ${label} contains unsupported field "${unexpected[0]}".`);
}

/**
 * Reads one required non-empty string.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Trimmed non-empty string.
 */
export function readRequiredString(value: unknown, label: string, filePath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid scenario ${filePath}: ${label} must be a non-empty string.`);
  }

  return value.trim();
}

/**
 * Reads one optional non-empty string.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Trimmed string when present.
 */
export function readOptionalString(value: unknown, label: string, filePath: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readRequiredString(value, label, filePath);
}

/**
 * Reads one optional string-or-null field.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Trimmed string, null, or undefined.
 */
export function readOptionalNullableString(value: unknown, label: string, filePath: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  return readRequiredString(value, label, filePath);
}

/**
 * Reads one required integer field.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Integer value.
 */
export function readRequiredInteger(value: unknown, label: string, filePath: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Invalid scenario ${filePath}: ${label} must be an integer.`);
  }

  return value;
}

/**
 * Reads one required finite numeric field.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Finite number.
 */
export function readRequiredNumber(value: unknown, label: string, filePath: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid scenario ${filePath}: ${label} must be a finite number.`);
  }

  return value;
}

/**
 * Reads one required boolean field.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Boolean value.
 */
export function readRequiredBoolean(value: unknown, label: string, filePath: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Invalid scenario ${filePath}: ${label} must be a boolean.`);
  }

  return value;
}

/**
 * Reads one optional boolean field.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Boolean value when present.
 */
export function readOptionalBoolean(value: unknown, label: string, filePath: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readRequiredBoolean(value, label, filePath);
}

/**
 * Reads one nullable string field.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Trimmed string or null.
 */
export function readNullableString(value: unknown, label: string, filePath: string): string | null {
  if (value === null) {
    return null;
  }

  return readRequiredString(value, label, filePath);
}

/**
 * Reads one nullable finite numeric field.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Finite number or null.
 */
export function readNullableNumber(value: unknown, label: string, filePath: string): number | null {
  if (value === null) {
    return null;
  }

  return readRequiredNumber(value, label, filePath);
}

/**
 * Reads one required string array.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Trimmed string array.
 */
export function readRequiredStringArray(value: unknown, label: string, filePath: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid scenario ${filePath}: ${label} must be an array of strings.`);
  }

  return value.map((item, index) => readRequiredString(item, `${label}[${index}]`, filePath));
}

/**
 * Reads one optional string array.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Trimmed string array when present.
 */
export function readOptionalStringArray(value: unknown, label: string, filePath: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readRequiredStringArray(value, label, filePath);
}

/**
 * Reads one notes field as either a string or string array.
 *
 * @param value - Raw field value.
 * @param filePath - Source scenario path for error messages.
 * @returns Normalized notes value when present.
 */
export function readOptionalNotes(value: unknown, filePath: string): string | string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return readRequiredString(value, "notes", filePath);
  }

  return readRequiredStringArray(value, "notes", filePath);
}

/**
 * Reads one required string enum value.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @param allowedValues - Supported string values.
 * @returns Parsed enum value.
 */
export function readRequiredEnum<T extends string>(value: unknown, label: string, filePath: string, allowedValues: readonly T[]): T {
  const normalized = readRequiredString(value, label, filePath);
  if (!isOneOf(normalized, allowedValues)) {
    throw new Error(`Invalid scenario ${filePath}: unsupported ${label} "${normalized}".`);
  }

  return normalized;
}

/**
 * Reads one optional string enum value.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @param allowedValues - Supported string values.
 * @returns Parsed enum value when present.
 */
export function readOptionalEnum<T extends string>(value: unknown, label: string, filePath: string, allowedValues: readonly T[]): T | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readRequiredEnum(value, label, filePath, allowedValues);
}

/**
 * Reads one optional nullable summary expectation using a deep-partial shape.
 *
 * @param value - Raw summary payload.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Deep-partial summary expectation, null, or undefined.
 */
export function readOptionalClaimKeyQualitySummary(
  value: unknown,
  label: string,
  filePath: string,
): DeepPartial<ClaimKeyQualityPassSummary> | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const summaryKeys = new Set(["executionStyle", "workingSet", "before", "after", "projectedAfter", "counts", "shadowSiblingSlotResonance", "circuitBreaker"]);
  const record = readObject(value, label, filePath, summaryKeys);

  return {
    ...(record.executionStyle !== undefined
      ? {
          executionStyle: readRequiredEnum(record.executionStyle, `${label}.executionStyle`, filePath, CLAIM_KEY_QUALITY_EXECUTION_STYLES),
        }
      : {}),
    ...(record.workingSet !== undefined ? { workingSet: readClaimKeyWorkingSet(record.workingSet, `${label}.workingSet`, filePath) } : {}),
    ...(record.before !== undefined ? { before: readClaimKeyHealthSnapshot(record.before, `${label}.before`, filePath) } : {}),
    ...(record.after !== undefined ? { after: readClaimKeyHealthSnapshot(record.after, `${label}.after`, filePath) } : {}),
    ...(record.projectedAfter !== undefined ? { projectedAfter: readClaimKeyHealthSnapshot(record.projectedAfter, `${label}.projectedAfter`, filePath) } : {}),
    ...(record.counts !== undefined ? { counts: readClaimKeyRepairCounts(record.counts, `${label}.counts`, filePath) } : {}),
    ...(record.shadowSiblingSlotResonance !== undefined
      ? {
          shadowSiblingSlotResonance:
            record.shadowSiblingSlotResonance === null
              ? null
              : readShadowSiblingSlotResonance(record.shadowSiblingSlotResonance, `${label}.shadowSiblingSlotResonance`, filePath),
        }
      : {}),
    ...(record.circuitBreaker !== undefined
      ? {
          circuitBreaker: record.circuitBreaker === null ? null : readCircuitBreaker(record.circuitBreaker, `${label}.circuitBreaker`, filePath),
        }
      : {}),
  };
}

/**
 * Reads one optional surgeon run status enum.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Parsed surgeon run status when present.
 */
export function readOptionalSurgeonRunStatus(value: unknown, label: string, filePath: string): (typeof SURGEON_RUN_STATUSES)[number] | undefined {
  return readOptionalEnum(value, label, filePath, SURGEON_RUN_STATUSES);
}

/**
 * Reads one supported surgeon proposal scope.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Parsed proposal scope.
 */
export function readProposalScope(value: unknown, label: string, filePath: string): (typeof SUPPORTED_PROPOSAL_SCOPES)[number] {
  return readRequiredEnum(value, label, filePath, SUPPORTED_PROPOSAL_SCOPES);
}

/**
 * Reads a deep-partial working-set expectation.
 *
 * @param value - Raw working-set payload.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Deep-partial working-set expectation.
 */
function readClaimKeyWorkingSet(value: unknown, label: string, filePath: string): DeepPartial<ClaimKeyQualityPassSummary["workingSet"]> {
  const workingSetKeys = new Set(["includeInactive", "project", "type", "claimKeyPrefix", "entryIds"]);
  const record = readObject(value, label, filePath, workingSetKeys);

  return {
    ...(record.includeInactive !== undefined ? { includeInactive: readRequiredBoolean(record.includeInactive, `${label}.includeInactive`, filePath) } : {}),
    ...(record.project !== undefined ? { project: readNullableString(record.project, `${label}.project`, filePath) } : {}),
    ...(record.type !== undefined ? { type: readNullableString(record.type, `${label}.type`, filePath) } : {}),
    ...(record.claimKeyPrefix !== undefined ? { claimKeyPrefix: readNullableString(record.claimKeyPrefix, `${label}.claimKeyPrefix`, filePath) } : {}),
    ...(record.entryIds !== undefined ? { entryIds: readRequiredStringArray(record.entryIds, `${label}.entryIds`, filePath) } : {}),
  };
}

/**
 * Reads a deep-partial claim-key-health snapshot expectation.
 *
 * @param value - Raw health-snapshot payload.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Deep-partial health-snapshot expectation.
 */
function readClaimKeyHealthSnapshot(value: unknown, label: string, filePath: string): DeepPartial<ClaimKeyQualityPassSummary["before"]> {
  const snapshotKeys = new Set([
    "totalEntries",
    "activeEntries",
    "coverageCount",
    "coveragePct",
    "missingCount",
    "eligibleMissingCount",
    "malformedOrNoncanonicalCount",
    "suspectCanonicalCount",
    "entityFamilyGroupCount",
    "suspiciousSingletonAliasCount",
    "mixedGroupCount",
    "exactKeyMultiActiveClusterCount",
  ]);
  const record = readObject(value, label, filePath, snapshotKeys);

  return {
    ...(record.totalEntries !== undefined ? { totalEntries: readRequiredInteger(record.totalEntries, `${label}.totalEntries`, filePath) } : {}),
    ...(record.activeEntries !== undefined ? { activeEntries: readRequiredInteger(record.activeEntries, `${label}.activeEntries`, filePath) } : {}),
    ...(record.coverageCount !== undefined ? { coverageCount: readRequiredInteger(record.coverageCount, `${label}.coverageCount`, filePath) } : {}),
    ...(record.coveragePct !== undefined ? { coveragePct: readRequiredNumber(record.coveragePct, `${label}.coveragePct`, filePath) } : {}),
    ...(record.missingCount !== undefined ? { missingCount: readRequiredInteger(record.missingCount, `${label}.missingCount`, filePath) } : {}),
    ...(record.eligibleMissingCount !== undefined
      ? { eligibleMissingCount: readRequiredInteger(record.eligibleMissingCount, `${label}.eligibleMissingCount`, filePath) }
      : {}),
    ...(record.malformedOrNoncanonicalCount !== undefined
      ? {
          malformedOrNoncanonicalCount: readRequiredInteger(record.malformedOrNoncanonicalCount, `${label}.malformedOrNoncanonicalCount`, filePath),
        }
      : {}),
    ...(record.suspectCanonicalCount !== undefined
      ? { suspectCanonicalCount: readRequiredInteger(record.suspectCanonicalCount, `${label}.suspectCanonicalCount`, filePath) }
      : {}),
    ...(record.entityFamilyGroupCount !== undefined
      ? { entityFamilyGroupCount: readRequiredInteger(record.entityFamilyGroupCount, `${label}.entityFamilyGroupCount`, filePath) }
      : {}),
    ...(record.suspiciousSingletonAliasCount !== undefined
      ? {
          suspiciousSingletonAliasCount: readRequiredInteger(record.suspiciousSingletonAliasCount, `${label}.suspiciousSingletonAliasCount`, filePath),
        }
      : {}),
    ...(record.mixedGroupCount !== undefined ? { mixedGroupCount: readRequiredInteger(record.mixedGroupCount, `${label}.mixedGroupCount`, filePath) } : {}),
    ...(record.exactKeyMultiActiveClusterCount !== undefined
      ? {
          exactKeyMultiActiveClusterCount: readRequiredInteger(record.exactKeyMultiActiveClusterCount, `${label}.exactKeyMultiActiveClusterCount`, filePath),
        }
      : {}),
  };
}

/**
 * Reads a deep-partial claim-key repair-count expectation.
 *
 * @param value - Raw repair-count payload.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Deep-partial repair-count expectation.
 */
function readClaimKeyRepairCounts(value: unknown, label: string, filePath: string): DeepPartial<ClaimKeyQualityRepairCounts> {
  const countKeys = new Set([
    "identifiedNormalizations",
    "appliedNormalizations",
    "identifiedBackfills",
    "appliedBackfills",
    "identifiedMetadataRewrites",
    "appliedMetadataRewrites",
    "identifiedEntityFamilyConvergences",
    "appliedEntityFamilyConvergences",
    "proposalsEmitted",
    "skippedNoClaim",
    "skippedLowConfidence",
    "skippedCollision",
    "skippedAmbiguous",
  ]);
  const record = readObject(value, label, filePath, countKeys);

  return {
    ...(record.identifiedNormalizations !== undefined
      ? { identifiedNormalizations: readRequiredInteger(record.identifiedNormalizations, `${label}.identifiedNormalizations`, filePath) }
      : {}),
    ...(record.appliedNormalizations !== undefined
      ? { appliedNormalizations: readRequiredInteger(record.appliedNormalizations, `${label}.appliedNormalizations`, filePath) }
      : {}),
    ...(record.identifiedBackfills !== undefined
      ? { identifiedBackfills: readRequiredInteger(record.identifiedBackfills, `${label}.identifiedBackfills`, filePath) }
      : {}),
    ...(record.appliedBackfills !== undefined ? { appliedBackfills: readRequiredInteger(record.appliedBackfills, `${label}.appliedBackfills`, filePath) } : {}),
    ...(record.identifiedMetadataRewrites !== undefined
      ? {
          identifiedMetadataRewrites: readRequiredInteger(record.identifiedMetadataRewrites, `${label}.identifiedMetadataRewrites`, filePath),
        }
      : {}),
    ...(record.appliedMetadataRewrites !== undefined
      ? {
          appliedMetadataRewrites: readRequiredInteger(record.appliedMetadataRewrites, `${label}.appliedMetadataRewrites`, filePath),
        }
      : {}),
    ...(record.identifiedEntityFamilyConvergences !== undefined
      ? {
          identifiedEntityFamilyConvergences: readRequiredInteger(
            record.identifiedEntityFamilyConvergences,
            `${label}.identifiedEntityFamilyConvergences`,
            filePath,
          ),
        }
      : {}),
    ...(record.appliedEntityFamilyConvergences !== undefined
      ? {
          appliedEntityFamilyConvergences: readRequiredInteger(record.appliedEntityFamilyConvergences, `${label}.appliedEntityFamilyConvergences`, filePath),
        }
      : {}),
    ...(record.proposalsEmitted !== undefined ? { proposalsEmitted: readRequiredInteger(record.proposalsEmitted, `${label}.proposalsEmitted`, filePath) } : {}),
    ...(record.skippedNoClaim !== undefined ? { skippedNoClaim: readRequiredInteger(record.skippedNoClaim, `${label}.skippedNoClaim`, filePath) } : {}),
    ...(record.skippedLowConfidence !== undefined
      ? { skippedLowConfidence: readRequiredInteger(record.skippedLowConfidence, `${label}.skippedLowConfidence`, filePath) }
      : {}),
    ...(record.skippedCollision !== undefined ? { skippedCollision: readRequiredInteger(record.skippedCollision, `${label}.skippedCollision`, filePath) } : {}),
    ...(record.skippedAmbiguous !== undefined ? { skippedAmbiguous: readRequiredInteger(record.skippedAmbiguous, `${label}.skippedAmbiguous`, filePath) } : {}),
  };
}

/**
 * Reads a deep-partial shadow sibling-slot-resonance expectation.
 *
 * @param value - Raw shadow-summary payload.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Deep-partial shadow-summary expectation.
 */
function readShadowSiblingSlotResonance(
  value: unknown,
  label: string,
  filePath: string,
): DeepPartial<NonNullable<ClaimKeyQualityPassSummary["shadowSiblingSlotResonance"]>> {
  const shadowKeys = new Set([
    "rule",
    "thresholdOnlyCandidateCount",
    "resonanceApplicableCount",
    "resonanceFiredCount",
    "shadowQualifiedCount",
    "resonanceFiredClaimKeys",
    "shadowQualifiedClaimKeys",
    "buckets",
  ]);
  const record = readObject(value, label, filePath, shadowKeys);

  return {
    ...(record.rule !== undefined ? { rule: readShadowRule(record.rule, `${label}.rule`, filePath) } : {}),
    ...(record.thresholdOnlyCandidateCount !== undefined
      ? {
          thresholdOnlyCandidateCount: readRequiredInteger(record.thresholdOnlyCandidateCount, `${label}.thresholdOnlyCandidateCount`, filePath),
        }
      : {}),
    ...(record.resonanceApplicableCount !== undefined
      ? {
          resonanceApplicableCount: readRequiredInteger(record.resonanceApplicableCount, `${label}.resonanceApplicableCount`, filePath),
        }
      : {}),
    ...(record.resonanceFiredCount !== undefined
      ? { resonanceFiredCount: readRequiredInteger(record.resonanceFiredCount, `${label}.resonanceFiredCount`, filePath) }
      : {}),
    ...(record.shadowQualifiedCount !== undefined
      ? { shadowQualifiedCount: readRequiredInteger(record.shadowQualifiedCount, `${label}.shadowQualifiedCount`, filePath) }
      : {}),
    ...(record.resonanceFiredClaimKeys !== undefined
      ? { resonanceFiredClaimKeys: readRequiredStringArray(record.resonanceFiredClaimKeys, `${label}.resonanceFiredClaimKeys`, filePath) }
      : {}),
    ...(record.shadowQualifiedClaimKeys !== undefined
      ? { shadowQualifiedClaimKeys: readRequiredStringArray(record.shadowQualifiedClaimKeys, `${label}.shadowQualifiedClaimKeys`, filePath) }
      : {}),
    ...(record.buckets !== undefined ? { buckets: readShadowBuckets(record.buckets, `${label}.buckets`, filePath) } : {}),
  };
}

/**
 * Reads a deep-partial shadow-rule expectation.
 *
 * @param value - Raw shadow-rule payload.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Deep-partial shadow-rule expectation.
 */
function readShadowRule(
  value: unknown,
  label: string,
  filePath: string,
): DeepPartial<NonNullable<ClaimKeyQualityPassSummary["shadowSiblingSlotResonance"]>["rule"]> {
  const ruleKeys = new Set(["supportClass", "minFamilyReuseCount", "minGroundedRatio", "minConfidence", "requiresSiblingSlotResonance"]);
  const record = readObject(value, label, filePath, ruleKeys);

  return {
    ...(record.supportClass !== undefined
      ? { supportClass: readRequiredEnum(record.supportClass, `${label}.supportClass`, filePath, CLAIM_KEY_QUALITY_SUPPORT_CLASSES) }
      : {}),
    ...(record.minFamilyReuseCount !== undefined
      ? { minFamilyReuseCount: readRequiredInteger(record.minFamilyReuseCount, `${label}.minFamilyReuseCount`, filePath) }
      : {}),
    ...(record.minGroundedRatio !== undefined ? { minGroundedRatio: readRequiredNumber(record.minGroundedRatio, `${label}.minGroundedRatio`, filePath) } : {}),
    ...(record.minConfidence !== undefined ? { minConfidence: readRequiredNumber(record.minConfidence, `${label}.minConfidence`, filePath) } : {}),
    ...(record.requiresSiblingSlotResonance !== undefined
      ? {
          requiresSiblingSlotResonance: readRequiredTrue(record.requiresSiblingSlotResonance, `${label}.requiresSiblingSlotResonance`, filePath),
        }
      : {}),
  };
}

/**
 * Reads one shadow-bucket array expectation.
 *
 * @param value - Raw shadow-bucket payload.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Deep-partial shadow-bucket expectations.
 */
function readShadowBuckets(value: unknown, label: string, filePath: string): DeepPartial<ClaimKeyQualityShadowBucketSummary[]> {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid scenario ${filePath}: ${label} must be an array.`);
  }

  return value.map((item, index) => readShadowBucket(item, `${label}[${index}]`, filePath));
}

/**
 * Reads one shadow-bucket expectation.
 *
 * @param value - Raw shadow-bucket payload.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Deep-partial shadow-bucket expectation.
 */
function readShadowBucket(value: unknown, label: string, filePath: string): DeepPartial<ClaimKeyQualityShadowBucketSummary> {
  const bucketKeys = new Set(["bucket", "candidateCount", "resonanceApplicableCount", "resonanceFiredCount", "shadowQualifiedCount"]);
  const record = readObject(value, label, filePath, bucketKeys);

  return {
    ...(record.bucket !== undefined ? { bucket: readRequiredEnum(record.bucket, `${label}.bucket`, filePath, CLAIM_KEY_QUALITY_SHADOW_BUCKETS) } : {}),
    ...(record.candidateCount !== undefined ? { candidateCount: readRequiredInteger(record.candidateCount, `${label}.candidateCount`, filePath) } : {}),
    ...(record.resonanceApplicableCount !== undefined
      ? {
          resonanceApplicableCount: readRequiredInteger(record.resonanceApplicableCount, `${label}.resonanceApplicableCount`, filePath),
        }
      : {}),
    ...(record.resonanceFiredCount !== undefined
      ? { resonanceFiredCount: readRequiredInteger(record.resonanceFiredCount, `${label}.resonanceFiredCount`, filePath) }
      : {}),
    ...(record.shadowQualifiedCount !== undefined
      ? { shadowQualifiedCount: readRequiredInteger(record.shadowQualifiedCount, `${label}.shadowQualifiedCount`, filePath) }
      : {}),
  };
}

/**
 * Reads one circuit-breaker expectation.
 *
 * @param value - Raw circuit-breaker payload.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Deep-partial circuit-breaker expectation.
 */
function readCircuitBreaker(value: unknown, label: string, filePath: string): DeepPartial<NonNullable<ClaimKeyQualityPassSummary["circuitBreaker"]>> {
  const circuitBreakerKeys = new Set(["kind", "message"]);
  const record = readObject(value, label, filePath, circuitBreakerKeys);

  return {
    ...(record.kind !== undefined ? { kind: readRequiredString(record.kind, `${label}.kind`, filePath) } : {}),
    ...(record.message !== undefined ? { message: readRequiredString(record.message, `${label}.message`, filePath) } : {}),
  };
}

/**
 * Checks whether one string belongs to an allowed literal set.
 *
 * @param value - Normalized candidate value.
 * @param allowedValues - Supported literal values.
 * @returns True when the candidate is in the allowed set.
 */
function isOneOf<T extends string>(value: string, allowedValues: readonly T[]): value is T {
  return allowedValues.includes(value as T);
}

/**
 * Reads one boolean field that must be true.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @returns Literal true when valid.
 */
function readRequiredTrue(value: unknown, label: string, filePath: string): true {
  const parsed = readRequiredBoolean(value, label, filePath);
  if (parsed !== true) {
    throw new Error(`Invalid scenario ${filePath}: ${label} must be true.`);
  }

  return true;
}
