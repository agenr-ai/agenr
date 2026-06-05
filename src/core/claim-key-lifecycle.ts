import { describeClaimKeyNormalizationFailure, normalizeClaimKey } from "./claim-key.js";
import {
  CLAIM_KEY_SOURCES,
  CLAIM_KEY_STATUSES,
  CLAIM_SUPPORT_MODES,
  type ClaimKeyLifecycleMetadata,
  type ClaimKeySource,
  type ClaimKeyStatus,
  type ClaimSupportMode,
  type DurableUpdateInput,
  type StoreDurableInput,
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
 * Canonical manual claim-key update derived from raw caller input.
 */
export interface NormalizedManualClaimKeyUpdate {
  claimKey: string;
  updateFields: DurableLifecycleUpdateFields;
}

/**
 * Partial metadata preserved when an explicit claim key is replayed from a trusted source.
 */
export type PreservedClaimKeyMetadata = Pick<
  StoreDurableInput,
  "claim_key_raw" | "claim_support_source_kind" | "claim_support_locator" | "claim_support_observed_at" | "claim_support_mode"
>;

/**
 * Lifecycle fields that may be mutated through direct entry updates.
 */
export type DurableLifecycleUpdateFields = Pick<
  DurableUpdateInput,
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
  acceptanceRationale?: string | null;
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
 * Best-effort transcript provenance that can support one inferred ingest claim key.
 */
export type InferredIngestClaimKeySupportInput = Pick<
  StoreDurableInput,
  "source_file" | "source_context" | "created_at" | "claim_support_source_kind" | "claim_support_locator" | "claim_support_observed_at" | "claim_support_mode"
>;

/**
 * Narrow support signal needed by reconcile lifecycle derivation.
 */
export interface ReconcileClaimKeySupportSignal {
  autoApplyClass?: string | null;
}

/**
 * Narrow compaction metadata needed by reconcile lifecycle derivation.
 */
export interface ClaimKeyCompactnessSignal {
  compactedFrom?: string | null;
}

/**
 * Persisted lifecycle metadata when dreaming reconcile will apply a concrete replacement.
 */
export interface AppliedClaimKeyLifecycleMetadata {
  rawClaimKey?: string;
  status: ClaimKeyStatus;
  source: ClaimKeySource;
}

/**
 * Deferred lifecycle metadata recorded for unresolved dreaming proposals.
 */
export interface ProposalClaimKeyLifecycleMetadata {
  deferredUntilReview: true;
  proposedStatus: ClaimKeyStatus;
  proposedSource?: ClaimKeySource;
  proposedRawClaimKey?: string;
}

/**
 * Structured lifecycle details recorded on dreaming run actions for applied writes.
 */
export interface ClaimKeyLifecycleAuditDetails {
  claim_key_raw?: string;
  claim_key_status: ClaimKeyStatus;
  claim_key_source: ClaimKeySource;
  claim_key_confidence: number;
  claim_key_rationale: string;
}

/**
 * Structured lifecycle details recorded on dreaming run actions for deferred proposals.
 */
export interface ProposalClaimKeyLifecycleAuditDetails {
  proposal_deferred_until_review: true;
  proposal_claim_key_status: ClaimKeyStatus;
  proposal_claim_key_source?: ClaimKeySource;
  proposal_claim_key_raw?: string;
}

const PRECOMPUTED_LIFECYCLE_FIELDS = ["claim_key_status", "claim_key_source", "claim_key_confidence", "claim_key_rationale"] as const satisfies ReadonlyArray<
  keyof Pick<StoreDurableInput, "claim_key_status" | "claim_key_source" | "claim_key_confidence" | "claim_key_rationale">
>;

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
 * Parses one optional bounded claim-key confidence score.
 *
 * @param value - Raw boundary value.
 * @returns Confidence in the inclusive [0, 1] range, or undefined when absent or invalid.
 */
export function parseClaimKeyConfidence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
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
 * Returns whether a store input already carries explicit lifecycle bundle fields.
 *
 * Support metadata does not count as an explicit lifecycle bundle because
 * callers may preserve transcript or tool provenance for manual claim keys
 * without precomputing lifecycle semantics.
 *
 * @param input - Candidate store input.
 * @returns True when any explicit lifecycle bundle field is present.
 */
export function hasPrecomputedClaimKeyLifecycleFields(
  input: Pick<StoreDurableInput, "claim_key_status" | "claim_key_source" | "claim_key_confidence" | "claim_key_rationale">,
): boolean {
  return PRECOMPUTED_LIFECYCLE_FIELDS.some((field) => input[field] !== undefined);
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
 * Normalizes raw manual claim-key update input into canonical update fields.
 *
 * @param params - Raw or canonical claim key plus optional preserved support metadata.
 * @returns Canonical claim key plus validated lifecycle update fields.
 */
export function normalizeManualClaimKeyUpdate(params: {
  claimKey: string;
  rawClaimKey?: string;
  supportSourceKind?: string;
  supportLocator?: string;
  supportObservedAt?: string;
  supportMode?: ClaimSupportMode;
}): NormalizedManualClaimKeyUpdate {
  const normalized = normalizeLifecycleClaimKeyInput(params.claimKey, params.rawClaimKey, "claim_key");
  return {
    claimKey: normalized.claimKey,
    updateFields: lifecycleToUpdateFields(
      buildManualClaimKeyLifecycle({
        claimKey: normalized.claimKey,
        rawClaimKey: normalized.rawClaimKey,
        supportSourceKind: params.supportSourceKind,
        supportLocator: params.supportLocator,
        supportObservedAt: params.supportObservedAt,
        supportMode: params.supportMode,
      }),
    ),
  };
}

/**
 * Builds one full replacement-style direct-update payload for a manual claim key.
 *
 * @param params - Raw or canonical claim key plus optional preserved support metadata.
 * @returns Validated direct-update fields that replace the stored lifecycle bundle.
 */
export function buildManualClaimKeyUpdateFields(params: {
  claimKey: string;
  rawClaimKey?: string;
  supportSourceKind?: string;
  supportLocator?: string;
  supportObservedAt?: string;
  supportMode?: ClaimSupportMode;
}): DurableLifecycleUpdateFields {
  return normalizeManualClaimKeyUpdate(params).updateFields;
}

/**
 * Converts one canonical lifecycle bundle into the direct-update field shape.
 *
 * @param lifecycle - Canonical lifecycle payload.
 * @returns Direct-update lifecycle field bundle.
 */
export function buildClaimKeyLifecycleUpdateFields(lifecycle: ResolvedClaimKeyLifecycle): DurableLifecycleUpdateFields {
  return lifecycleToUpdateFields(lifecycle);
}

/**
 * Converts one canonical lifecycle bundle into structured audit details.
 *
 * @param lifecycle - Canonical lifecycle payload.
 * @returns Structured lifecycle fields for run-action logging.
 */
export function buildClaimKeyLifecycleAuditDetails(lifecycle: ResolvedClaimKeyLifecycle): ClaimKeyLifecycleAuditDetails {
  return {
    claim_key_raw: lifecycle.claim_key_raw,
    claim_key_status: lifecycle.claim_key_status,
    claim_key_source: lifecycle.claim_key_source,
    claim_key_confidence: lifecycle.claim_key_confidence,
    claim_key_rationale: lifecycle.claim_key_rationale,
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
    StoreDurableInput,
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
  const confidence = parseClaimKeyConfidence(input.claim_key_confidence);
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
 * Validates one direct-update lifecycle payload and normalizes it into the canonical persisted bundle.
 *
 * Direct update lifecycle writes are replacement-style. If any lifecycle field is
 * present, callers must provide the full required lifecycle payload. Optional
 * raw/support metadata may be included; omitted optional lifecycle metadata is
 * cleared by the update layer.
 *
 * @param fields - Candidate direct-update mutation payload.
 * @returns Canonical lifecycle bundle when the payload includes lifecycle fields.
 */
export function validateDirectClaimKeyLifecycleUpdate(fields: DurableUpdateInput): ResolvedClaimKeyLifecycle | undefined {
  if (!hasDirectLifecycleFields(fields)) {
    return undefined;
  }

  const missingRequired = REQUIRED_DIRECT_LIFECYCLE_FIELDS.filter((field) => fields[field] === undefined);
  if (missingRequired.length > 0) {
    throw new Error(`Direct claim-key lifecycle updates require a complete lifecycle payload. Missing: ${missingRequired.join(", ")}.`);
  }

  const normalizedClaimKey = normalizeLifecycleClaimKeyInput(fields.claim_key, fields.claim_key_raw, "claim_key");
  const claimSupportObservedAt = normalizeOptionalString(fields.claim_support_observed_at);
  if (claimSupportObservedAt !== undefined && Number.isNaN(Date.parse(claimSupportObservedAt))) {
    throw new Error("Invalid claim_support_observed_at: expected an ISO 8601 timestamp.");
  }

  const lifecycle = buildPrecomputedClaimKeyLifecycle({
    claim_key: normalizedClaimKey.claimKey,
    claim_key_raw: normalizedClaimKey.rawClaimKey,
    claim_key_status: requireClaimKeyStatus(fields.claim_key_status, "claim_key_status"),
    claim_key_source: requireClaimKeySource(fields.claim_key_source, "claim_key_source"),
    claim_key_confidence: requireClaimKeyConfidence(fields.claim_key_confidence, "claim_key_confidence"),
    claim_key_rationale: requireNonEmptyString(fields.claim_key_rationale, "claim_key_rationale"),
    claim_support_source_kind: normalizeOptionalString(fields.claim_support_source_kind),
    claim_support_locator: normalizeOptionalString(fields.claim_support_locator),
    claim_support_observed_at: claimSupportObservedAt,
    claim_support_mode:
      normalizeOptionalString(fields.claim_support_mode) === undefined ? undefined : requireClaimSupportMode(fields.claim_support_mode, "claim_support_mode"),
  });
  if (!lifecycle) {
    throw new Error("Direct claim-key lifecycle update could not be normalized.");
  }

  return lifecycle;
}

/**
 * Builds the canonical lifecycle payload for one extracted claim key.
 *
 * @param extracted - Successful extracted claim-key result.
 * @returns Accepted lifecycle payload when a canonical key exists.
 */
export function buildExtractedClaimKeyLifecycle(
  extracted: ExtractedClaimKeyLifecycleInput,
  supportContext: ClaimKeySupportContext = {},
): ResolvedClaimKeyLifecycle | undefined {
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
    claim_key_rationale: [rationalePrefix, extracted.compactionReason, extracted.acceptanceRationale]
      .filter((value): value is string => Boolean(value))
      .join("; "),
    claim_support_source_kind: normalizeOptionalString(supportContext.sourceKind),
    claim_support_locator: normalizeOptionalString(supportContext.locator),
    claim_support_observed_at: normalizeOptionalString(supportContext.observedAt),
    claim_support_mode: supportContext.mode,
  };
}

/**
 * Applies one accepted lifecycle payload onto a mutable store entry input.
 *
 * @param entry - Entry input that should receive canonical lifecycle fields.
 * @param lifecycle - Canonical lifecycle payload to apply.
 */
export function applyClaimKeyLifecycle(entry: StoreDurableInput, lifecycle: ResolvedClaimKeyLifecycle): void {
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
 * Builds conservative inferred support metadata for one ingest-produced claim key.
 *
 * This helper only fills support metadata when transcript-file provenance is
 * already available on the entry. It intentionally does not invent explicit or
 * manual semantics for generic store-time extraction paths.
 *
 * @param entry - Store input that may already carry transcript ingest metadata.
 * @returns Best-effort inferred support metadata for the accepted claim key.
 */
export function buildInferredIngestClaimKeySupportContext(entry: InferredIngestClaimKeySupportInput): ClaimKeySupportContext {
  const sourceFile = normalizeOptionalString(entry.source_file);
  const sourceContext = normalizeOptionalString(entry.source_context);
  const observedAt = normalizeOptionalString(entry.claim_support_observed_at ?? entry.created_at);
  if (!sourceFile) {
    return {};
  }

  return {
    sourceKind: normalizeOptionalString(entry.claim_support_source_kind) ?? "transcript_ingest",
    locator: normalizeOptionalString(entry.claim_support_locator) ?? buildInferredIngestSupportLocator(sourceFile, observedAt, sourceContext),
    observedAt,
    mode: entry.claim_support_mode ?? "inferred",
  };
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
    StoreDurableInput,
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
  entry: StoreDurableInput,
  candidate: Pick<
    StoreDurableInput,
    "claim_key" | "claim_key_raw" | "claim_support_source_kind" | "claim_support_locator" | "claim_support_observed_at" | "claim_support_mode" | "created_at"
  >,
): StoreDurableInput {
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
 * Builds reconcile-applied lifecycle metadata for an in-place claim-key rewrite.
 *
 * @param input - Target claim key, prior metadata, and proposal provenance.
 * @returns Canonical lifecycle metadata that dreaming reconcile should persist.
 */
export function buildReconcileAppliedClaimKeyLifecycle(input: {
  targetClaimKey: string;
  priorClaimKey: string | null;
  priorClaimKeyRaw?: string;
  rawClaimKey?: string | null;
  source: string;
  support?: ReconcileClaimKeySupportSignal;
  compactness?: ClaimKeyCompactnessSignal;
}): AppliedClaimKeyLifecycleMetadata {
  const source = resolveReconcileClaimKeySource(input.source, input.compactness) ?? "dreaming_reconcile";
  return {
    rawClaimKey: resolveLifecycleRawClaimKey({
      targetClaimKey: input.targetClaimKey,
      priorClaimKeyRaw: input.priorClaimKeyRaw,
      rawClaimKey: input.rawClaimKey,
      priorClaimKey: input.priorClaimKey,
    }),
    status: resolveReconcileClaimKeyStatus({
      proposedClaimKeys: [input.targetClaimKey],
      source: input.source,
      support: input.support,
      compactness: input.compactness,
    }),
    source,
  };
}

/**
 * Builds the full canonical lifecycle bundle dreaming reconcile should persist for one applied rewrite.
 *
 * @param input - Target claim key, provenance, and persisted confidence/rationale fields.
 * @returns Canonical lifecycle payload ready for persistence and audit logging.
 */
export function buildReconcileAppliedClaimKeyLifecycleBundle(input: {
  targetClaimKey: string;
  priorClaimKey: string | null;
  priorClaimKeyRaw?: string;
  rawClaimKey?: string | null;
  source: string;
  confidence: number;
  rationale: string;
  support?: ReconcileClaimKeySupportSignal;
  compactness?: ClaimKeyCompactnessSignal;
}): ResolvedClaimKeyLifecycle {
  const lifecycle = buildReconcileAppliedClaimKeyLifecycle(input);
  return {
    claim_key: input.targetClaimKey,
    claim_key_raw: lifecycle.rawClaimKey,
    claim_key_status: lifecycle.status,
    claim_key_source: lifecycle.source,
    claim_key_confidence: input.confidence,
    claim_key_rationale: input.rationale,
  };
}

/**
 * Builds deferred lifecycle metadata for an unresolved dreaming proposal.
 *
 * @param input - Proposed claim keys, provenance, and any raw-key preservation signal.
 * @returns Deferred lifecycle payload recorded with the proposal audit trail.
 */
export function buildReconcileProposalClaimKeyLifecycle(input: {
  proposedClaimKeys: string[];
  source: string;
  rawClaimKey?: string | null;
  support?: ReconcileClaimKeySupportSignal;
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
    proposedStatus: resolveReconcileClaimKeyStatus({
      proposedClaimKeys,
      source: input.source,
      support: input.support,
      compactness: input.compactness,
    }),
    proposedSource: resolveReconcileClaimKeySource(input.source, input.compactness),
    proposedRawClaimKey: resolveLifecycleRawClaimKey({
      targetClaimKey,
      rawClaimKey: input.rawClaimKey,
    }),
  };
}

/**
 * Converts deferred reconcile lifecycle metadata into structured proposal audit details.
 *
 * @param lifecycle - Deferred lifecycle payload recorded with the proposal.
 * @returns Structured lifecycle fields for run-action logging.
 */
export function buildReconcileProposalClaimKeyAuditDetails(
  lifecycle: ProposalClaimKeyLifecycleMetadata | undefined,
): ProposalClaimKeyLifecycleAuditDetails | Record<string, never> {
  if (!lifecycle) {
    return {};
  }

  return {
    proposal_deferred_until_review: lifecycle.deferredUntilReview,
    proposal_claim_key_status: lifecycle.proposedStatus,
    proposal_claim_key_source: lifecycle.proposedSource,
    proposal_claim_key_raw: lifecycle.proposedRawClaimKey,
  };
}

/**
 * Resolves the canonical persisted claim-key source for one dreaming reconcile rewrite or proposal.
 *
 * @param source - Surgeon-local provenance label.
 * @param compactness - Optional compaction metadata derived during normalization.
 * @returns Canonical stored lifecycle source when one exists.
 */
export function resolveReconcileClaimKeySource(source: string, compactness?: ClaimKeyCompactnessSignal): ClaimKeySource | undefined {
  if (source === "metadata_backfill_rewrite" || source === "metadata_rewrite") {
    return "dreaming_reconcile";
  }

  if (
    source === "trusted_group_reuse" ||
    source === "mixed_group_consensus" ||
    source === "entity_family_auto_convergence" ||
    source === "entity_family_canonical_candidate" ||
    source === "entity_family_collision"
  ) {
    return "dreaming_reconcile";
  }

  if (source === "normalize" || compactness?.compactedFrom) {
    return "dreaming_reconcile";
  }

  return parseClaimKeySource(source);
}

/**
 * Resolves the canonical persisted claim-key status for one dreaming reconcile rewrite or proposal.
 *
 * @param input - Proposed claim-key set plus provenance and support signals.
 * @returns Canonical stored lifecycle status.
 */
export function resolveReconcileClaimKeyStatus(input: {
  proposedClaimKeys: string[];
  source: string;
  support?: ReconcileClaimKeySupportSignal;
  compactness?: ClaimKeyCompactnessSignal;
}): ClaimKeyStatus {
  if (normalizeStringArray(input.proposedClaimKeys).length === 0) {
    return "unresolved";
  }

  const lifecycleSource = resolveReconcileClaimKeySource(input.source, input.compactness);
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
 * Builds the deferred rationale sentence used by dreaming proposal logging.
 *
 * @param baseRationale - Existing explanation of why the proposal exists.
 * @param lifecycle - Deferred lifecycle metadata attached to the proposal.
 * @returns Combined rationale string.
 */
export function buildReconcileProposalLifecycleRationale(baseRationale: string, lifecycle: ProposalClaimKeyLifecycleMetadata): string {
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
 * Resolves the raw claim-key text dreaming reconcile should preserve, preferring existing human-entered forms.
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

const DIRECT_LIFECYCLE_FIELDS = [
  "claim_key",
  "claim_key_raw",
  "claim_key_status",
  "claim_key_source",
  "claim_key_confidence",
  "claim_key_rationale",
  "claim_support_source_kind",
  "claim_support_locator",
  "claim_support_observed_at",
  "claim_support_mode",
] as const satisfies ReadonlyArray<keyof DurableLifecycleUpdateFields>;

const REQUIRED_DIRECT_LIFECYCLE_FIELDS = [
  "claim_key",
  "claim_key_status",
  "claim_key_source",
  "claim_key_confidence",
  "claim_key_rationale",
] as const satisfies ReadonlyArray<keyof DurableLifecycleUpdateFields>;

/**
 * Returns whether one direct-update payload touches any lifecycle field.
 *
 * @param fields - Candidate direct-update mutation payload.
 * @returns True when lifecycle validation should run.
 */
function hasDirectLifecycleFields(fields: DurableUpdateInput): boolean {
  return DIRECT_LIFECYCLE_FIELDS.some((field) => fields[field] !== undefined);
}

/**
 * Normalizes one direct-update claim key into canonical storage form.
 *
 * @param claimKey - Candidate canonical or raw claim-key string.
 * @param rawClaimKey - Optional explicit raw claim-key text to preserve.
 * @param label - Human-readable label for error messages.
 * @returns Canonical claim key plus any preserved raw variant.
 */
function normalizeLifecycleClaimKeyInput(
  claimKey: string | undefined,
  rawClaimKey: string | undefined,
  label: string,
): { claimKey: string; rawClaimKey?: string } {
  const normalizedClaimKeyInput = requireNonEmptyString(claimKey, label);
  const normalizedClaimKey = normalizeClaimKey(normalizedClaimKeyInput);
  if (!normalizedClaimKey.ok) {
    throw new Error(`Invalid ${label}: ${describeClaimKeyNormalizationFailure(normalizedClaimKey.reason)}. Use canonical entity/attribute format.`);
  }

  return {
    claimKey: normalizedClaimKey.value.claimKey,
    rawClaimKey: buildClaimKeyRaw(rawClaimKey ?? normalizedClaimKeyInput, normalizedClaimKey.value.claimKey),
  };
}

/**
 * Converts one canonical lifecycle bundle into the direct-update field shape.
 *
 * @param lifecycle - Canonical lifecycle payload.
 * @returns Direct-update lifecycle field bundle.
 */
function lifecycleToUpdateFields(lifecycle: ResolvedClaimKeyLifecycle): DurableLifecycleUpdateFields {
  return {
    claim_key: lifecycle.claim_key,
    claim_key_raw: lifecycle.claim_key_raw,
    claim_key_status: lifecycle.claim_key_status,
    claim_key_source: lifecycle.claim_key_source,
    claim_key_confidence: lifecycle.claim_key_confidence,
    claim_key_rationale: lifecycle.claim_key_rationale,
    claim_support_source_kind: lifecycle.claim_support_source_kind,
    claim_support_locator: lifecycle.claim_support_locator,
    claim_support_observed_at: lifecycle.claim_support_observed_at,
    claim_support_mode: lifecycle.claim_support_mode,
  };
}

/**
 * Builds one compact locator for inferred transcript-ingest support.
 *
 * @param sourceFile - Transcript file path that produced the entry.
 * @param observedAt - Best-effort observation time for the extracted claim.
 * @param sourceContext - Optional one-line ingest context summary.
 * @returns Opaque locator string that points back to the ingest surface.
 */
function buildInferredIngestSupportLocator(sourceFile: string, observedAt?: string, sourceContext?: string): string {
  if (observedAt && sourceContext) {
    return `${sourceFile}#observed_at:${observedAt}#context:${encodeURIComponent(sourceContext)}`;
  }

  if (observedAt) {
    return `${sourceFile}#observed_at:${observedAt}`;
  }

  if (sourceContext) {
    return `${sourceFile}#context:${encodeURIComponent(sourceContext)}`;
  }

  return sourceFile;
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
 * Requires one optional string field to be present and non-empty.
 *
 * @param value - Raw string boundary value.
 * @param label - Human-readable field label for error messages.
 * @returns Trimmed string value.
 */
function requireNonEmptyString(value: string | undefined, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`Invalid ${label}: expected a non-empty string.`);
  }

  return normalized;
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
 * Requires one lifecycle confidence score to be finite and bounded.
 *
 * @param value - Raw numeric boundary value.
 * @param label - Human-readable field label for error messages.
 * @returns Validated lifecycle confidence.
 */
function requireClaimKeyConfidence(value: number | undefined, label: string): number {
  const parsed = parseClaimKeyConfidence(value);
  if (parsed !== undefined) {
    return parsed;
  }

  throw new Error(`Invalid ${label}: expected a finite number between 0 and 1.`);
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
