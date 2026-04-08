import {
  CLAIM_KEY_SOURCES,
  CLAIM_KEY_STATUSES,
  CLAIM_SUPPORT_MODES,
  type ClaimKeyLifecycleMetadata,
  type ClaimKeySource,
  type ClaimKeyStatus,
  type ClaimSupportMode,
  type StoreEntryInput,
} from "./types.js";

/**
 * Canonical persisted lifecycle payload for one accepted claim key.
 */
export interface ResolvedClaimKeyLifecycle extends ClaimKeyLifecycleMetadata {
  claim_key: string;
  claim_key_status: ClaimKeyStatus;
  claim_key_source: ClaimKeySource;
  claim_key_confidence: number;
  claim_key_rationale: string;
}

/**
 * Partial metadata preserved when an explicit claim key is replayed from a trusted source.
 */
export type PreservedClaimKeyMetadata = Pick<
  StoreEntryInput,
  "claim_key_raw" | "claim_support_source_kind" | "claim_support_locator" | "claim_support_observed_at" | "claim_support_mode"
>;

/**
 * Minimal extracted-claim result shape accepted by the shared lifecycle helpers.
 */
export interface ExtractedClaimKeyLifecycleInput {
  claimKey: string | null;
  confidence: number;
  rawEntity: string;
  rawAttribute: string;
  path: "model" | "json_retry" | "deterministic_repair";
  compactedFrom?: string | null;
  compactionReason?: string | null;
}

/**
 * Optional support metadata observed when preserving an explicit claim key.
 */
export interface ClaimKeySupportContext {
  sourceKind?: string;
  locator?: string;
  observedAt?: string;
  mode?: ClaimSupportMode;
}

/**
 * Narrow support signal needed by surgeon lifecycle derivation.
 */
export interface SurgeonClaimKeySupportSignal {
  autoApplyClass?: string | null;
}

/**
 * Narrow compaction metadata needed by surgeon lifecycle derivation.
 */
export interface ClaimKeyCompactnessSignal {
  compactedFrom?: string | null;
}

/**
 * Persisted lifecycle metadata when surgeon will apply a concrete replacement.
 */
export interface AppliedClaimKeyLifecycleMetadata {
  rawClaimKey?: string;
  status: ClaimKeyStatus;
  source: ClaimKeySource;
}

/**
 * Deferred lifecycle metadata recorded for unresolved surgeon proposals.
 */
export interface ProposalClaimKeyLifecycleMetadata {
  deferredUntilReview: true;
  proposedStatus: ClaimKeyStatus;
  proposedSource?: ClaimKeySource;
  proposedRawClaimKey?: string;
}

/**
 * Parses one optional claim-key lifecycle status.
 *
 * @param value - Raw boundary value.
 * @returns Parsed status, or undefined when the value is absent or invalid.
 */
export function parseClaimKeyStatus(value: unknown): ClaimKeyStatus | undefined {
  return parseStringEnum(value, CLAIM_KEY_STATUSES);
}

/**
 * Parses one optional claim-key lifecycle source.
 *
 * @param value - Raw boundary value.
 * @returns Parsed source, or undefined when the value is absent or invalid.
 */
export function parseClaimKeySource(value: unknown): ClaimKeySource | undefined {
  return parseStringEnum(value, CLAIM_KEY_SOURCES);
}

/**
 * Parses one optional claim-support mode.
 *
 * @param value - Raw boundary value.
 * @returns Parsed support mode, or undefined when the value is absent or invalid.
 */
export function parseClaimSupportMode(value: unknown): ClaimSupportMode | undefined {
  return parseStringEnum(value, CLAIM_SUPPORT_MODES);
}

/**
 * Requires one claim-key lifecycle status to be valid.
 *
 * @param value - Raw boundary value.
 * @param label - Human-readable field label for error messages.
 * @returns Parsed lifecycle status.
 */
export function requireClaimKeyStatus(value: unknown, label: string): ClaimKeyStatus {
  const parsed = parseClaimKeyStatus(value);
  if (!parsed) {
    throw new Error(`Invalid ${label}: expected one of ${CLAIM_KEY_STATUSES.join(", ")}.`);
  }

  return parsed;
}

/**
 * Requires one claim-key lifecycle source to be valid.
 *
 * @param value - Raw boundary value.
 * @param label - Human-readable field label for error messages.
 * @returns Parsed lifecycle source.
 */
export function requireClaimKeySource(value: unknown, label: string): ClaimKeySource {
  const parsed = parseClaimKeySource(value);
  if (!parsed) {
    throw new Error(`Invalid ${label}: expected one of ${CLAIM_KEY_SOURCES.join(", ")}.`);
  }

  return parsed;
}

/**
 * Requires one claim-support mode to be valid.
 *
 * @param value - Raw boundary value.
 * @param label - Human-readable field label for error messages.
 * @returns Parsed support mode.
 */
export function requireClaimSupportMode(value: unknown, label: string): ClaimSupportMode {
  const parsed = parseClaimSupportMode(value);
  if (!parsed) {
    throw new Error(`Invalid ${label}: expected one of ${CLAIM_SUPPORT_MODES.join(", ")}.`);
  }

  return parsed;
}

/**
 * Builds the canonical lifecycle payload for an explicit manual claim key.
 *
 * @param params - Canonical claim key plus any preserved raw and support metadata.
 * @returns Accepted lifecycle payload ready for persistence.
 */
export function buildManualClaimKeyLifecycle(params: {
  claimKey: string;
  rawClaimKey?: string;
  supportSourceKind?: string;
  supportLocator?: string;
  supportObservedAt?: string;
  supportMode?: ClaimSupportMode;
}): ResolvedClaimKeyLifecycle {
  return {
    claim_key: params.claimKey,
    claim_key_raw: buildClaimKeyRaw(params.rawClaimKey, params.claimKey),
    claim_key_status: "trusted",
    claim_key_source: "manual",
    claim_key_confidence: 1,
    claim_key_rationale: "manual claim key supplied by caller",
    claim_support_source_kind: normalizeOptionalString(params.supportSourceKind),
    claim_support_locator: normalizeOptionalString(params.supportLocator),
    claim_support_observed_at: normalizeOptionalString(params.supportObservedAt),
    claim_support_mode: params.supportMode,
  };
}

/**
 * Rehydrates an already-derived lifecycle payload when upstream code precomputed it.
 *
 * @param input - Store input carrying a canonical claim key plus lifecycle fields.
 * @returns Accepted lifecycle payload when all required fields are present and valid.
 */
export function buildPrecomputedClaimKeyLifecycle(
  input: Pick<
    StoreEntryInput,
    | "claim_key"
    | "claim_key_raw"
    | "claim_key_status"
    | "claim_key_source"
    | "claim_key_confidence"
    | "claim_key_rationale"
    | "claim_support_source_kind"
    | "claim_support_locator"
    | "claim_support_observed_at"
    | "claim_support_mode"
  >,
): ResolvedClaimKeyLifecycle | undefined {
  const claimKey = normalizeOptionalString(input.claim_key);
  const status = parseClaimKeyStatus(input.claim_key_status);
  const source = parseClaimKeySource(input.claim_key_source);
  const confidence = normalizeOptionalNumber(input.claim_key_confidence);
  const rationale = normalizeOptionalString(input.claim_key_rationale);
  const supportMode = parseClaimSupportMode(input.claim_support_mode);
  if (!claimKey || !status || !source || confidence === undefined || !rationale) {
    return undefined;
  }

  return {
    claim_key: claimKey,
    claim_key_raw: buildClaimKeyRaw(input.claim_key_raw, claimKey),
    claim_key_status: status,
    claim_key_source: source,
    claim_key_confidence: confidence,
    claim_key_rationale: rationale,
    claim_support_source_kind: normalizeOptionalString(input.claim_support_source_kind),
    claim_support_locator: normalizeOptionalString(input.claim_support_locator),
    claim_support_observed_at: normalizeOptionalString(input.claim_support_observed_at),
    claim_support_mode: supportMode,
  };
}

/**
 * Builds the canonical lifecycle payload for one extracted claim key.
 *
 * @param extracted - Successful extracted claim-key result.
 * @returns Accepted lifecycle payload when a canonical key exists.
 */
export function buildExtractedClaimKeyLifecycle(extracted: ExtractedClaimKeyLifecycleInput): ResolvedClaimKeyLifecycle | undefined {
  if (!extracted.claimKey) {
    return undefined;
  }

  const source = extracted.path;
  const rationalePrefix =
    source === "deterministic_repair" ? "claim key inferred by deterministic possessive-slot repair" : `claim key extracted from ${source} output`;

  return {
    claim_key: extracted.claimKey,
    claim_key_raw: buildClaimKeyRaw(formatExtractedRawClaimKey(extracted), extracted.claimKey),
    claim_key_status: source === "deterministic_repair" ? "tentative" : "trusted",
    claim_key_source: source,
    claim_key_confidence: extracted.confidence,
    claim_key_rationale: extracted.compactionReason ? `${rationalePrefix}; ${extracted.compactionReason}` : rationalePrefix,
  };
}

/**
 * Applies one accepted lifecycle payload onto a mutable store entry input.
 *
 * @param entry - Entry input that should receive canonical lifecycle fields.
 * @param lifecycle - Canonical lifecycle payload to apply.
 */
export function applyClaimKeyLifecycle(entry: StoreEntryInput, lifecycle: ResolvedClaimKeyLifecycle): void {
  entry.claim_key = lifecycle.claim_key;
  entry.claim_key_raw = lifecycle.claim_key_raw;
  entry.claim_key_status = lifecycle.claim_key_status;
  entry.claim_key_source = lifecycle.claim_key_source;
  entry.claim_key_confidence = lifecycle.claim_key_confidence;
  entry.claim_key_rationale = lifecycle.claim_key_rationale;
  entry.claim_support_source_kind = lifecycle.claim_support_source_kind;
  entry.claim_support_locator = lifecycle.claim_support_locator;
  entry.claim_support_observed_at = lifecycle.claim_support_observed_at;
  entry.claim_support_mode = lifecycle.claim_support_mode;
}

/**
 * Shapes explicit claim-key preservation metadata without assigning lifecycle ownership.
 *
 * The store pipeline remains the canonical path for assigning manual lifecycle
 * status, source, confidence, and rationale.
 *
 * @param entry - Entry that already carries an explicit claim key.
 * @param context - Best-effort provenance visible at the preservation site.
 * @returns Narrow explicit-key metadata to merge onto the entry.
 */
export function buildExplicitClaimKeyPreservationMetadata(
  entry: Pick<
    StoreEntryInput,
    "claim_key" | "claim_key_raw" | "claim_support_source_kind" | "claim_support_locator" | "claim_support_observed_at" | "claim_support_mode" | "created_at"
  >,
  context: ClaimKeySupportContext,
): PreservedClaimKeyMetadata {
  if (!entry.claim_key) {
    return {};
  }

  const claimSupportObservedAt = normalizeOptionalString(entry.claim_support_observed_at ?? context.observedAt ?? entry.created_at);
  return {
    ...(buildClaimKeyRaw(entry.claim_key_raw ?? entry.claim_key, entry.claim_key) !== undefined
      ? { claim_key_raw: buildClaimKeyRaw(entry.claim_key_raw ?? entry.claim_key, entry.claim_key) }
      : {}),
    ...(normalizeOptionalString(entry.claim_support_source_kind ?? context.sourceKind) !== undefined
      ? { claim_support_source_kind: normalizeOptionalString(entry.claim_support_source_kind ?? context.sourceKind) }
      : {}),
    ...(normalizeOptionalString(entry.claim_support_locator ?? context.locator) !== undefined
      ? { claim_support_locator: normalizeOptionalString(entry.claim_support_locator ?? context.locator) }
      : {}),
    ...(claimSupportObservedAt !== undefined ? { claim_support_observed_at: claimSupportObservedAt } : {}),
    ...((entry.claim_support_mode ?? context.mode) !== undefined ? { claim_support_mode: entry.claim_support_mode ?? context.mode } : {}),
  };
}

/**
 * Merges preserved explicit-claim metadata into one survivor without inventing new lifecycle state.
 *
 * @param entry - Survivor entry that may need its explicit claim metadata restored.
 * @param candidate - Candidate explicit entry whose claim metadata should be preserved.
 * @returns Survivor with explicit claim metadata merged when the keys agree.
 */
export function mergeExplicitClaimKeyMetadata(
  entry: StoreEntryInput,
  candidate: Pick<
    StoreEntryInput,
    "claim_key" | "claim_key_raw" | "claim_support_source_kind" | "claim_support_locator" | "claim_support_observed_at" | "claim_support_mode" | "created_at"
  >,
): StoreEntryInput {
  if (!candidate.claim_key) {
    return entry;
  }

  if (entry.claim_key && entry.claim_key !== candidate.claim_key) {
    return entry;
  }

  const preserved = buildExplicitClaimKeyPreservationMetadata(candidate, {});
  return {
    ...entry,
    claim_key: entry.claim_key ?? candidate.claim_key,
    claim_key_raw: entry.claim_key_raw ?? preserved.claim_key_raw,
    claim_support_source_kind: entry.claim_support_source_kind ?? preserved.claim_support_source_kind,
    claim_support_locator: entry.claim_support_locator ?? preserved.claim_support_locator,
    claim_support_observed_at: entry.claim_support_observed_at ?? preserved.claim_support_observed_at,
    claim_support_mode: entry.claim_support_mode ?? preserved.claim_support_mode,
  };
}

/**
 * Builds surgeon-applied lifecycle metadata for an in-place claim-key rewrite.
 *
 * @param input - Target claim key, prior metadata, and proposal provenance.
 * @returns Canonical lifecycle metadata that surgeon should persist.
 */
export function buildSurgeonAppliedClaimKeyLifecycle(input: {
  targetClaimKey: string;
  priorClaimKey: string | null;
  priorClaimKeyRaw?: string;
  rawClaimKey?: string | null;
  source: string;
  support?: SurgeonClaimKeySupportSignal;
  compactness?: ClaimKeyCompactnessSignal;
}): AppliedClaimKeyLifecycleMetadata {
  const source = resolveSurgeonClaimKeySource(input.source, input.compactness) ?? "surgeon_compaction";
  return {
    rawClaimKey: resolveLifecycleRawClaimKey({
      targetClaimKey: input.targetClaimKey,
      priorClaimKeyRaw: input.priorClaimKeyRaw,
      rawClaimKey: input.rawClaimKey,
      priorClaimKey: input.priorClaimKey,
    }),
    status: resolveSurgeonClaimKeyStatus({
      proposedClaimKeys: [input.targetClaimKey],
      source: input.source,
      support: input.support,
      compactness: input.compactness,
    }),
    source,
  };
}

/**
 * Builds deferred lifecycle metadata for an unresolved surgeon proposal.
 *
 * @param input - Proposed claim keys, provenance, and any raw-key preservation signal.
 * @returns Deferred lifecycle payload recorded with the proposal audit trail.
 */
export function buildSurgeonProposalClaimKeyLifecycle(input: {
  proposedClaimKeys: string[];
  source: string;
  rawClaimKey?: string | null;
  support?: SurgeonClaimKeySupportSignal;
  compactness?: ClaimKeyCompactnessSignal;
}): ProposalClaimKeyLifecycleMetadata {
  const proposedClaimKeys = normalizeStringArray(input.proposedClaimKeys);
  const targetClaimKey = proposedClaimKeys[0];
  if (!targetClaimKey) {
    return {
      deferredUntilReview: true,
      proposedStatus: "unresolved",
    };
  }

  return {
    deferredUntilReview: true,
    proposedStatus: resolveSurgeonClaimKeyStatus({
      proposedClaimKeys,
      source: input.source,
      support: input.support,
      compactness: input.compactness,
    }),
    proposedSource: resolveSurgeonClaimKeySource(input.source, input.compactness),
    proposedRawClaimKey: resolveLifecycleRawClaimKey({
      targetClaimKey,
      rawClaimKey: input.rawClaimKey,
    }),
  };
}

/**
 * Resolves the canonical persisted claim-key source for one surgeon rewrite or proposal.
 *
 * @param source - Surgeon-local provenance label.
 * @param compactness - Optional compaction metadata derived during normalization.
 * @returns Canonical stored lifecycle source when one exists.
 */
export function resolveSurgeonClaimKeySource(source: string, compactness?: ClaimKeyCompactnessSignal): ClaimKeySource | undefined {
  if (source === "metadata_backfill_rewrite" || source === "metadata_rewrite") {
    return "surgeon_metadata_rewrite";
  }

  if (
    source === "trusted_group_reuse" ||
    source === "mixed_group_consensus" ||
    source === "entity_family_auto_convergence" ||
    source === "entity_family_canonical_candidate" ||
    source === "entity_family_collision"
  ) {
    return "surgeon_family_reuse";
  }

  if (source === "normalize" || compactness?.compactedFrom) {
    return "surgeon_compaction";
  }

  return parseClaimKeySource(source);
}

/**
 * Resolves the canonical persisted claim-key status for one surgeon rewrite or proposal.
 *
 * @param input - Proposed claim-key set plus provenance and support signals.
 * @returns Canonical stored lifecycle status.
 */
export function resolveSurgeonClaimKeyStatus(input: {
  proposedClaimKeys: string[];
  source: string;
  support?: SurgeonClaimKeySupportSignal;
  compactness?: ClaimKeyCompactnessSignal;
}): ClaimKeyStatus {
  if (normalizeStringArray(input.proposedClaimKeys).length === 0) {
    return "unresolved";
  }

  const lifecycleSource = resolveSurgeonClaimKeySource(input.source, input.compactness);
  if (lifecycleSource === "deterministic_repair" && !input.support?.autoApplyClass) {
    return "tentative";
  }

  return "trusted";
}

/**
 * Builds the stored raw claim key only when it differs from the canonical key.
 *
 * @param rawClaimKey - Raw or human-entered claim key representation.
 * @param canonicalClaimKey - Canonical stored claim key.
 * @returns Raw claim key when it differs from canonical storage.
 */
export function buildClaimKeyRaw(rawClaimKey: string | null | undefined, canonicalClaimKey: string): string | undefined {
  const normalizedRawClaimKey = normalizeOptionalString(rawClaimKey);
  if (!normalizedRawClaimKey || normalizedRawClaimKey === canonicalClaimKey) {
    return undefined;
  }

  return normalizedRawClaimKey;
}

/**
 * Builds the deferred rationale sentence used by surgeon proposal logging.
 *
 * @param baseRationale - Existing explanation of why the proposal exists.
 * @param lifecycle - Deferred lifecycle metadata attached to the proposal.
 * @returns Combined rationale string.
 */
export function buildSurgeonProposalLifecycleRationale(baseRationale: string, lifecycle: ProposalClaimKeyLifecycleMetadata): string {
  const normalizedBase = baseRationale.trim();
  if (lifecycle.proposedStatus === "unresolved" || !lifecycle.proposedSource) {
    return `${normalizedBase} The entry stays unchanged until review because no safe lifecycle write is ready yet.`;
  }

  const rawText = lifecycle.proposedRawClaimKey ? ` and claim_key_raw "${lifecycle.proposedRawClaimKey}"` : "";
  return (
    `${normalizedBase} The entry stays unchanged until review. ` +
    `If approved, the replacement would persist claim_key_status "${lifecycle.proposedStatus}" ` +
    `with claim_key_source "${lifecycle.proposedSource}"${rawText}.`
  );
}

/**
 * Formats one extracted entity and attribute pair into a comparable raw claim-key string.
 *
 * @param extracted - Extracted-claim metadata before canonical persistence.
 * @returns Raw claim-key representation, when present.
 */
function formatExtractedRawClaimKey(extracted: ExtractedClaimKeyLifecycleInput): string | undefined {
  const rawEntity = normalizeOptionalString(extracted.rawEntity);
  const rawAttribute = normalizeOptionalString(extracted.rawAttribute);
  if (!rawEntity || !rawAttribute) {
    return extracted.compactedFrom ?? undefined;
  }

  return `${rawEntity}/${rawAttribute}`;
}

/**
 * Resolves the raw claim-key text surgeon should preserve, preferring existing human-entered forms.
 *
 * @param input - Canonical target key plus prior raw and canonical variants.
 * @returns Raw claim-key representation when it differs from the canonical replacement.
 */
function resolveLifecycleRawClaimKey(input: {
  targetClaimKey: string;
  priorClaimKeyRaw?: string;
  rawClaimKey?: string | null;
  priorClaimKey?: string | null;
}): string | undefined {
  const candidates = [input.priorClaimKeyRaw, input.rawClaimKey ?? undefined, input.priorClaimKey ?? undefined];
  for (const candidate of candidates) {
    const rawClaimKey = buildClaimKeyRaw(candidate, input.targetClaimKey);
    if (rawClaimKey) {
      return rawClaimKey;
    }
  }

  return undefined;
}

/**
 * Parses one optional string enum from a trusted constant list.
 *
 * @param value - Raw boundary value.
 * @param values - Allowed literal values.
 * @returns Parsed enum value, or undefined when invalid.
 */
function parseStringEnum<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === "string" && values.includes(value as T) ? (value as T) : undefined;
}

/**
 * Trims optional strings and drops empty values.
 *
 * @param value - Raw optional string.
 * @returns Trimmed string, or undefined when empty.
 */
function normalizeOptionalString(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

/**
 * Normalizes one optional numeric field used by lifecycle metadata.
 *
 * @param value - Raw numeric boundary value.
 * @returns Finite number, or undefined when invalid.
 */
function normalizeOptionalNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Normalizes and deduplicates one string array while preserving order.
 *
 * @param values - Raw string array.
 * @returns Trimmed distinct string values.
 */
function normalizeStringArray(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}
