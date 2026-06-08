import { randomUUID } from "node:crypto";

import type { DatabasePort, EmbeddingPort, LlmPort } from "../ports.js";
import type { SupersessionRuleFailureReason } from "../supersession.js";
import type { Durable, StoreDurableInput, StoreResult } from "../types.js";
import {
  applyClaimKeyLifecycle,
  buildExtractedClaimKeyLifecycle,
  buildInferredIngestClaimKeySupportContext,
  buildManualClaimKeyLifecycle,
  buildPrecomputedClaimKeyLifecycle,
  hasPrecomputedClaimKeyLifecycleFields,
  type ResolvedClaimKeyLifecycle,
} from "../claim-key-lifecycle.js";
import { describeSupersessionRuleFailure, validateSupersessionRules } from "../supersession.js";
import { runBatchClaimExtraction, type ClaimExtractionConfig, type ClaimExtractionDiagnostic, type ClaimExtractionResult } from "./claim-extraction.js";
import { composeEmbeddingText } from "./embedding-text.js";
import { computeContentHash, computeNormContentHash } from "./hashing.js";
import { validateEntriesWithIndexes } from "./validation.js";

const AUTO_SUPERSESSION_MIN_EXTRACTED_CONFIDENCE = 0.9;
const AUTO_SUPERSESSION_ELIGIBLE_SOURCES = new Set<NonNullable<Durable["claim_key_source"]>>(["model", "json_retry"]);

/**
 * Runtime switches for the store pipeline.
 */
export interface StorePipelineOptions {
  dryRun?: boolean;
  verbose?: boolean;
}

/**
 * Runtime switches for batch store calls that can reuse precomputed embeddings.
 */
export interface StoreDurablesOptions extends StorePipelineOptions {
  /** Precomputed embeddings aligned with the original input array. */
  precomputedEmbeddings?: number[][];
  /** Optional best-effort claim-key extraction step. */
  claimExtraction?: {
    llm: LlmPort;
    db: DatabasePort;
    config: ClaimExtractionConfig;
  };
  /** Optional callback for non-fatal warnings encountered during the store pipeline. */
  onWarning?: (warning: string) => void;
  /** Optional callback for structured claim-extraction diagnostics. */
  onClaimExtractionDiagnostic?: (inputIndex: number, diagnostic: ClaimExtractionDiagnostic) => void;
}

/** Validated durable enriched with hashes needed by the store pipeline. */
interface PreparedDurable {
  input: StoreDurableInput;
  inputIndex: number;
  contentHash: string;
  normContentHash: string;
  claimKey?: ResolvedClaimKeyLifecycle;
}

/** Final pipeline outcome assigned to one store input. */
type StoreDurableOutcome = "stored" | "skipped" | "rejected" | "dry_run";
/** Reason code recorded for a skipped or rejected store input. */
type StoreDurableReason = "content_hash" | "norm_content_hash" | "validation" | "dry_run";

/**
 * Per-input store decision emitted by the store pipeline.
 */
export interface StoreDurableDetail {
  inputIndex: number;
  outcome: StoreDurableOutcome;
  reason?: StoreDurableReason;
  /** Persisted durable id when `outcome` is `stored`. */
  durableId?: string;
}

/**
 * Store result enriched with per-input decisions.
 */
export interface StoreDurablesDetailedResult extends StoreResult {
  details: StoreDurableDetail[];
}

/** Database port variant that can wrap multiple writes in one transaction. */
interface TransactionCapableDatabasePort extends DatabasePort {
  withTransaction<T>(fn: (db: DatabasePort) => Promise<T>): Promise<T>;
}

/**
 * Auto-supersession decisions derived before persistence begins.
 */
interface AutoSupersessionPlan {
  kind: "link" | "skip";
  oldDurableId?: string;
  warning?: string;
}

/**
 * Validates, deduplicates, embeds, and persists a batch of durables.
 *
 * @param inputs - Candidate durables to store.
 * @param db - Database port used for dedup checks and persistence.
 * @param embedding - Embedding port used for batch vector generation.
 * @param options - Optional pipeline execution flags.
 * @returns Aggregate store counts for stored, skipped, and rejected durables.
 */
export async function storeDurables(
  inputs: StoreDurableInput[],
  db: DatabasePort,
  embedding: EmbeddingPort,
  options: StoreDurablesOptions = {},
): Promise<StoreResult> {
  const result = await storeDurablesDetailed(inputs, db, embedding, options);
  return {
    stored: result.stored,
    skipped: result.skipped,
    rejected: result.rejected,
  };
}

/**
 * Validates, deduplicates, embeds, and persists a batch of durables while preserving per-input decisions.
 *
 * @param inputs - Candidate durables to store.
 * @param db - Database port used for dedup checks and persistence.
 * @param embedding - Embedding port used for batch vector generation.
 * @param options - Optional pipeline execution flags.
 * @returns Aggregate store counts plus per-input outcomes.
 */
export async function storeDurablesDetailed(
  inputs: StoreDurableInput[],
  db: DatabasePort,
  embedding: EmbeddingPort,
  options: StoreDurablesOptions = {},
): Promise<StoreDurablesDetailedResult> {
  if (inputs.length === 0) {
    return { stored: 0, skipped: 0, rejected: 0, details: [] };
  }

  const plan = await buildStorePlan(inputs, db);
  for (const warning of plan.warnings) {
    options.onWarning?.(warning);
  }

  if (plan.pendingEntries.length === 0) {
    return {
      stored: 0,
      skipped: plan.skipped,
      rejected: plan.rejected,
      details: sortStoreDetails(plan.details),
    };
  }

  if (options.dryRun === true) {
    return {
      stored: 0,
      skipped: plan.skipped,
      rejected: plan.rejected,
      details: sortStoreDetails([
        ...plan.details,
        ...plan.pendingEntries.map((entry) => ({
          inputIndex: entry.inputIndex,
          outcome: "dry_run" as const,
          reason: "dry_run" as const,
        })),
      ]),
    };
  }

  const pendingEntries = plan.pendingEntries;
  const extractedClaimKeys = await maybeExtractClaimKeys(pendingEntries, options);
  applyExtractedClaimKeyMetadata(pendingEntries, extractedClaimKeys);
  const embeddings = await resolvePendingEmbeddings(inputs, pendingEntries, embedding, options.precomputedEmbeddings);
  const storedIds = await persistDurables(db, pendingEntries, embeddings, extractedClaimKeys, options.claimExtraction?.config, options.onWarning);
  return {
    stored: pendingEntries.length,
    skipped: plan.skipped,
    rejected: plan.rejected,
    details: sortStoreDetails([
      ...plan.details,
      ...pendingEntries.map((entry) => ({
        inputIndex: entry.inputIndex,
        outcome: "stored" as const,
        durableId: storedIds.get(entry.inputIndex),
      })),
    ]),
  };
}

/** Resolves embeddings for pending durables from precomputed vectors or the embedding port. */
async function resolvePendingEmbeddings(
  inputs: StoreDurableInput[],
  durables: PreparedDurable[],
  embedding: EmbeddingPort,
  precomputedEmbeddings?: number[][],
): Promise<number[][]> {
  if (!precomputedEmbeddings) {
    return embedPendingDurables(durables, embedding);
  }

  if (precomputedEmbeddings.length !== inputs.length) {
    throw new Error(`Precomputed embedding length mismatch: expected ${inputs.length}, received ${precomputedEmbeddings.length}.`);
  }

  return durables.map((prepared) => {
    const vector = precomputedEmbeddings[prepared.inputIndex];
    if (!vector) {
      throw new Error(`Missing precomputed embedding for input index ${prepared.inputIndex}.`);
    }

    return vector;
  });
}

/** Embeds each pending durable using its canonical embedding text. */
async function embedPendingDurables(durables: PreparedDurable[], embedding: EmbeddingPort): Promise<number[][]> {
  const texts = durables.map(({ input }) => composeEmbeddingText(input));
  const vectors = await embedding.embed(texts);

  if (vectors.length !== durables.length) {
    throw new Error(`Embedding length mismatch: expected ${durables.length}, received ${vectors.length}.`);
  }

  return vectors;
}

/** Persists prepared durables, using a transaction when the adapter supports it. */
async function persistDurables(
  db: DatabasePort,
  preparedEntries: PreparedDurable[],
  embeddings: number[][],
  extractedClaimKeys: Map<number, ClaimExtractionResult>,
  claimExtractionConfig: ClaimExtractionConfig | undefined,
  onWarning?: (warning: string) => void,
): Promise<Map<number, string>> {
  const writeBatch = async (targetDb: DatabasePort): Promise<Map<number, string>> => {
    const storedIds = new Map<number, string>();
    const autoSupersessionPlans = await planAutoSupersession(targetDb, preparedEntries, extractedClaimKeys, claimExtractionConfig);
    const emittedWarnings = new Set<string>();

    for (const [index, preparedEntry] of preparedEntries.entries()) {
      const embedding = embeddings[index] ?? [];
      const entry = buildDurable(preparedEntry, embedding);
      const durableId = await targetDb.insertDurable(entry, embedding, preparedEntry.contentHash);
      storedIds.set(preparedEntry.inputIndex, durableId);
      const supersededEntryId = preparedEntry.input.supersedes;
      if (supersededEntryId) {
        const superseded = await targetDb.supersedeDurable(supersededEntryId, durableId, "update");
        if (!superseded) {
          onWarning?.(`Stored durable ${durableId} but could not supersede ${supersededEntryId} because the target was missing or inactive.`);
        }
      }

      const autoSupersessionPlan = autoSupersessionPlans.get(preparedEntry.inputIndex);
      if (autoSupersessionPlan?.kind === "link" && autoSupersessionPlan.oldDurableId) {
        const superseded = await targetDb.supersedeDurable(autoSupersessionPlan.oldDurableId, durableId, "update");
        if (!superseded) {
          onWarning?.(
            `Stored durable ${durableId} with claim_key "${preparedEntry.input.claim_key}" but could not auto-supersede ${autoSupersessionPlan.oldDurableId} because the target was missing or inactive.`,
          );
        }
      }

      if (autoSupersessionPlan?.warning && !emittedWarnings.has(autoSupersessionPlan.warning)) {
        emittedWarnings.add(autoSupersessionPlan.warning);
        onWarning?.(autoSupersessionPlan.warning);
      }
    }

    return storedIds;
  };

  if (hasTransactionSupport(db) && preparedEntries.some((entry) => entry.input.supersedes !== undefined || entry.input.claim_key !== undefined)) {
    return db.withTransaction(writeBatch);
  }

  if (hasTransactionSupport(db) && preparedEntries.length > 1) {
    return db.withTransaction(writeBatch);
  }

  return writeBatch(db);
}

/** Builds the canonical stored durable record for persistence. */
function buildDurable(preparedEntry: PreparedDurable, embedding: number[]): Durable {
  const now = new Date().toISOString();
  const acceptedClaimKey = preparedEntry.claimKey;

  return {
    id: randomUUID(),
    type: preparedEntry.input.type,
    subject: preparedEntry.input.subject,
    content: preparedEntry.input.content,
    importance: preparedEntry.input.importance ?? 7,
    expiry: preparedEntry.input.expiry ?? "temporary",
    tags: preparedEntry.input.tags ?? [],
    source_file: preparedEntry.input.source_file,
    source_context: preparedEntry.input.source_context,
    user_id: preparedEntry.input.user_id,
    project: preparedEntry.input.project,
    embedding,
    content_hash: preparedEntry.contentHash,
    norm_content_hash: preparedEntry.normContentHash,
    // Reserved neutral quality placeholder. Keep this constant unless a scored
    // quality signal is introduced behind recall evals/feature flags; production
    // recall must not treat this as an active ranking input while it is defaulted.
    quality_score: 0.5,
    recall_count: 0,
    valid_from: preparedEntry.input.valid_from,
    valid_to: preparedEntry.input.valid_to,
    directive_polarity: preparedEntry.input.directive_polarity,
    directive_trigger: preparedEntry.input.directive_trigger,
    claim_key: acceptedClaimKey?.claim_key ?? preparedEntry.input.claim_key,
    claim_key_raw: acceptedClaimKey?.claim_key_raw,
    claim_key_status: acceptedClaimKey?.claim_key_status,
    claim_key_source: acceptedClaimKey?.claim_key_source,
    claim_key_confidence: acceptedClaimKey?.claim_key_confidence,
    claim_key_rationale: acceptedClaimKey?.claim_key_rationale,
    claim_support_source_kind: acceptedClaimKey?.claim_support_source_kind,
    claim_support_locator: acceptedClaimKey?.claim_support_locator,
    claim_support_observed_at: acceptedClaimKey?.claim_support_observed_at,
    claim_support_mode: acceptedClaimKey?.claim_support_mode,
    created_at: preparedEntry.input.created_at ?? now,
    updated_at: now,
  };
}

/** Attempts best-effort claim-key extraction for pending durables before embedding. */
async function maybeExtractClaimKeys(preparedEntries: PreparedDurable[], options: StoreDurablesOptions): Promise<Map<number, ClaimExtractionResult>> {
  const claimExtraction = options.claimExtraction;
  if (!claimExtraction || preparedEntries.length === 0) {
    return new Map();
  }

  try {
    const extractedEntries = await runBatchClaimExtraction(
      [
        {
          durables: preparedEntries.map((preparedEntry) => preparedEntry.input),
        },
      ],
      {
        createLlm: () => claimExtraction.llm,
        db: claimExtraction.db,
      },
      claimExtraction.config,
      claimExtraction.config.concurrency ?? 10,
      options.onWarning,
      (entry, diagnostic) => {
        const preparedEntry = preparedEntries.find((candidate) => candidate.input === entry);
        if (preparedEntry) {
          options.onClaimExtractionDiagnostic?.(preparedEntry.inputIndex, diagnostic);
        }
      },
    );

    const extractedClaimKeys = new Map<number, ClaimExtractionResult>();
    for (const preparedEntry of preparedEntries) {
      const extracted = extractedEntries.get(preparedEntry.input);
      if (extracted) {
        extractedClaimKeys.set(preparedEntry.inputIndex, extracted);
      }
    }

    return extractedClaimKeys;
  } catch (error) {
    const subject = preparedEntries[0]?.input.subject ?? "batch";
    options.onWarning?.(`Claim extraction failed for "${subject}": ${formatPipelineError(error)}`);
    return new Map();
  }
}

/** Detects whether the database adapter exposes transactional batching support. */
function hasTransactionSupport(db: DatabasePort): db is TransactionCapableDatabasePort {
  return typeof (db as Partial<TransactionCapableDatabasePort>).withTransaction === "function";
}

/** Applies extracted claim-key lifecycle metadata to prepared durables after batch extraction. */
function applyExtractedClaimKeyMetadata(preparedEntries: PreparedDurable[], extractedClaimKeys: Map<number, ClaimExtractionResult>): void {
  for (const preparedEntry of preparedEntries) {
    if (preparedEntry.claimKey) {
      continue;
    }

    const extractedClaimKey = extractedClaimKeys.get(preparedEntry.inputIndex);
    const acceptedClaimKey =
      buildPrecomputedClaimKeyLifecycle(preparedEntry.input) ??
      (extractedClaimKey ? buildExtractedClaimKeyLifecycle(extractedClaimKey, buildInferredIngestClaimKeySupportContext(preparedEntry.input)) : undefined);
    if (!acceptedClaimKey) {
      continue;
    }

    preparedEntry.claimKey = acceptedClaimKey;
    applyClaimKeyLifecycle(preparedEntry.input, acceptedClaimKey);
  }
}

/**
 * Plans conservative claim-key-driven supersession links before persistence begins.
 *
 * The plan is computed before any inserts run so it only considers pre-existing
 * active siblings, not other durables in the current store batch.
 */
async function planAutoSupersession(
  db: DatabasePort,
  preparedEntries: PreparedDurable[],
  extractedClaimKeys: Map<number, ClaimExtractionResult>,
  claimExtractionConfig: ClaimExtractionConfig | undefined,
): Promise<Map<number, AutoSupersessionPlan>> {
  const plans = new Map<number, AutoSupersessionPlan>();
  const preparedEntriesByClaimKey = groupPreparedDurablesByClaimKey(preparedEntries);
  const siblingCache = new Map<string, Durable[]>();

  for (const preparedEntry of preparedEntries) {
    const claimKey = preparedEntry.claimKey?.claim_key ?? preparedEntry.input.claim_key;
    if (!claimKey || preparedEntry.input.supersedes) {
      continue;
    }

    const siblings = await getClaimKeySiblings(db, siblingCache, claimKey);
    if (siblings.length === 0) {
      continue;
    }

    const batchSiblingCount = preparedEntriesByClaimKey.get(claimKey)?.length ?? 0;
    if (batchSiblingCount > 1) {
      plans.set(preparedEntry.inputIndex, {
        kind: "skip",
        warning: `Skipped auto-supersession for claim_key "${claimKey}" because this store batch contains ${batchSiblingCount} durables for the same slot.`,
      });
      continue;
    }

    if (siblings.length > 1) {
      plans.set(preparedEntry.inputIndex, {
        kind: "skip",
        warning: `Skipped auto-supersession for claim_key "${claimKey}" because ${siblings.length} active siblings already exist for that slot.`,
      });
      continue;
    }

    const sibling = siblings[0];
    if (!sibling) {
      continue;
    }

    if (!isAutoSupersessionEligible(preparedEntry.claimKey, claimExtractionConfig)) {
      plans.set(preparedEntry.inputIndex, {
        kind: "skip",
        warning: buildAutoSupersessionEligibilityWarning(preparedEntry),
      });
      continue;
    }

    const supersessionValidation = validateSupersessionRules(sibling, {
      type: preparedEntry.input.type,
      expiry: preparedEntry.input.expiry ?? "temporary",
    });
    if (!supersessionValidation.ok) {
      plans.set(preparedEntry.inputIndex, {
        kind: "skip",
        warning: buildAutoSupersessionRuleWarning(preparedEntry, sibling, supersessionValidation.reason),
      });
      continue;
    }

    plans.set(preparedEntry.inputIndex, {
      kind: "link",
      oldDurableId: sibling.id,
    });
  }

  return plans;
}

/** Groups prepared durables by their canonical claim key. */
function groupPreparedDurablesByClaimKey(preparedEntries: PreparedDurable[]): Map<string, PreparedDurable[]> {
  const grouped = new Map<string, PreparedDurable[]>();

  for (const preparedEntry of preparedEntries) {
    const claimKey = preparedEntry.claimKey?.claim_key ?? preparedEntry.input.claim_key;
    if (!claimKey) {
      continue;
    }

    const existing = grouped.get(claimKey) ?? [];
    existing.push(preparedEntry);
    grouped.set(claimKey, existing);
  }

  return grouped;
}

/** Loads active same-claim-key siblings once per canonical key. */
async function getClaimKeySiblings(db: DatabasePort, cache: Map<string, Durable[]>, claimKey: string): Promise<Durable[]> {
  const cached = cache.get(claimKey);
  if (cached) {
    return cached;
  }

  const siblings = await db.findActiveDurablesByClaimKey(claimKey);
  cache.set(claimKey, siblings);
  return siblings;
}

/** Returns whether one prepared durable may auto-link through claim-key supersession. */
function isAutoSupersessionEligible(claimKey: ResolvedClaimKeyLifecycle | undefined, claimExtractionConfig: ClaimExtractionConfig | undefined): boolean {
  if (!claimKey || claimKey.claim_key_status !== "trusted") {
    return false;
  }

  if (claimKey.claim_key_source === "manual") {
    return true;
  }

  if (!AUTO_SUPERSESSION_ELIGIBLE_SOURCES.has(claimKey.claim_key_source) || !claimExtractionConfig) {
    return false;
  }

  return claimKey.claim_key_confidence >= Math.max(claimExtractionConfig.confidenceThreshold, AUTO_SUPERSESSION_MIN_EXTRACTED_CONFIDENCE);
}

/** Explains why one claim-key match stayed stored without an automatic link. */
function buildAutoSupersessionEligibilityWarning(preparedEntry: PreparedDurable): string {
  const acceptedClaimKey = preparedEntry.claimKey;
  const claimKey = acceptedClaimKey?.claim_key ?? preparedEntry.input.claim_key ?? "(missing)";
  if (!acceptedClaimKey) {
    return `Stored durable "${preparedEntry.input.subject}" with claim_key "${claimKey}" but skipped auto-supersession because the claim-key provenance was not explicit or a tracked high-confidence extraction.`;
  }

  if (acceptedClaimKey.claim_key_source === "manual") {
    return `Stored durable "${preparedEntry.input.subject}" with claim_key "${claimKey}" but skipped auto-supersession because the claim-key provenance was not eligible for automatic linking.`;
  }

  if (acceptedClaimKey.claim_key_status !== "trusted") {
    return (
      `Stored durable "${preparedEntry.input.subject}" with claim_key "${claimKey}" but skipped auto-supersession because the accepted claim key is ` +
      `${acceptedClaimKey.claim_key_status} from ${acceptedClaimKey.claim_key_source} at confidence ${acceptedClaimKey.claim_key_confidence.toFixed(2)}. Only explicit/manual claim keys or model-extracted keys at ` +
      `${AUTO_SUPERSESSION_MIN_EXTRACTED_CONFIDENCE.toFixed(2)}+ auto-link.`
    );
  }

  return (
    `Stored durable "${preparedEntry.input.subject}" with claim_key "${claimKey}" but skipped auto-supersession because the extracted claim key came from ` +
    `${acceptedClaimKey.claim_key_source} at confidence ${acceptedClaimKey.claim_key_confidence.toFixed(2)}. Only explicit/manual claim keys or model-extracted keys at ` +
    `${AUTO_SUPERSESSION_MIN_EXTRACTED_CONFIDENCE.toFixed(2)}+ auto-link.`
  );
}

/** Explains why a same-claim-key sibling failed the conservative type-policy checks. */
function buildAutoSupersessionRuleWarning(
  preparedEntry: PreparedDurable,
  sibling: Pick<Durable, "type" | "expiry">,
  reason: SupersessionRuleFailureReason,
): string {
  if (reason === "type_mismatch") {
    return (
      `Stored durable "${preparedEntry.input.subject}" with claim_key "${preparedEntry.input.claim_key}" but skipped auto-supersession because the matching ` +
      `active durable is type "${sibling.type}" and the new durable is type "${preparedEntry.input.type}". ${describeSupersessionRuleFailure(reason)}`
    );
  }

  return (
    `Stored durable "${preparedEntry.input.subject}" with claim_key "${preparedEntry.input.claim_key}" but skipped auto-supersession: ` +
    `${describeSupersessionRuleFailure(reason)}`
  );
}

/** Validates inputs and filters out durables that should not reach persistence. */
async function buildStorePlan(
  inputs: StoreDurableInput[],
  db: DatabasePort,
): Promise<{
  pendingEntries: PreparedDurable[];
  skipped: number;
  rejected: number;
  details: StoreDurableDetail[];
  warnings: string[];
}> {
  const validation = validateEntriesWithIndexes(inputs);
  const details: StoreDurableDetail[] = validation.rejectedInputIndexes.map((inputIndex) => ({
    inputIndex,
    outcome: "rejected",
    reason: "validation",
  }));
  const preparedEntries = validation.valid.map(({ input, inputIndex }) => ({
    input,
    inputIndex,
    contentHash: computeContentHash(input.content, input.source_file),
    normContentHash: computeNormContentHash(input.content),
    claimKey: buildManualAcceptedClaimKey(inputs[inputIndex], input),
  }));

  const afterBatchContentHash = dedupePreparedEntries(preparedEntries, "contentHash", "content_hash", details);
  const existingHashes = await db.findExistingHashes(afterBatchContentHash.map((entry) => entry.contentHash));
  const afterExistingContentHash = filterExistingPreparedEntries(afterBatchContentHash, existingHashes, "contentHash", "content_hash", details);

  const afterBatchNormHash = dedupePreparedEntries(afterExistingContentHash, "normContentHash", "norm_content_hash", details);
  const existingNormHashes = await db.findExistingNormHashes(afterBatchNormHash.map((entry) => entry.normContentHash));
  const pendingEntries = filterExistingPreparedEntries(afterBatchNormHash, existingNormHashes, "normContentHash", "norm_content_hash", details);

  return {
    pendingEntries,
    skipped: details.filter((detail) => detail.outcome === "skipped").length,
    rejected: validation.rejected,
    details,
    warnings: validation.warnings,
  };
}

/** Removes duplicate prepared durables within the current batch by hash field. */
function dedupePreparedEntries(
  durables: PreparedDurable[],
  field: "contentHash" | "normContentHash",
  reason: Exclude<StoreDurableReason, "validation" | "dry_run">,
  details: StoreDurableDetail[],
): PreparedDurable[] {
  const seen = new Set<string>();
  const deduped: PreparedDurable[] = [];

  for (const entry of durables) {
    const key = entry[field];
    if (seen.has(key)) {
      details.push({
        inputIndex: entry.inputIndex,
        outcome: "skipped",
        reason,
      });
      continue;
    }

    seen.add(key);
    deduped.push(entry);
  }

  return deduped;
}

/** Filters out prepared durables whose hash field already exists in storage. */
function filterExistingPreparedEntries(
  durables: PreparedDurable[],
  existing: Set<string>,
  field: "contentHash" | "normContentHash",
  reason: Exclude<StoreDurableReason, "validation" | "dry_run">,
  details: StoreDurableDetail[],
): PreparedDurable[] {
  return durables.filter((entry) => {
    if (!existing.has(entry[field])) {
      return true;
    }

    details.push({
      inputIndex: entry.inputIndex,
      outcome: "skipped",
      reason,
    });
    return false;
  });
}

/** Normalizes unknown pipeline errors into a compact warning string. */
function formatPipelineError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/** Sorts per-input store details back into original input order. */
function sortStoreDetails(details: StoreDurableDetail[]): StoreDurableDetail[] {
  return [...details].sort((left, right) => left.inputIndex - right.inputIndex);
}

/** Builds accepted manual claim-key metadata from raw caller input plus the normalized canonical key. */
function buildManualAcceptedClaimKey(rawInput: StoreDurableInput | undefined, normalizedInput: StoreDurableInput): ResolvedClaimKeyLifecycle | undefined {
  const canonicalClaimKey = normalizedInput.claim_key;
  if (!canonicalClaimKey) {
    return undefined;
  }

  const precomputedAcceptedClaimKey = buildPrecomputedClaimKeyLifecycle(normalizedInput);
  if (precomputedAcceptedClaimKey) {
    return precomputedAcceptedClaimKey;
  }

  if (rawInput && hasPrecomputedClaimKeyLifecycleFields(rawInput)) {
    throw new Error("Store inputs with claim-key lifecycle metadata must provide a complete valid lifecycle bundle.");
  }

  return buildManualClaimKeyLifecycle({
    claimKey: canonicalClaimKey,
    rawClaimKey: normalizedInput.claim_key_raw ?? normalizeOptionalString(rawInput?.claim_key),
    supportSourceKind: normalizedInput.claim_support_source_kind,
    supportLocator: normalizedInput.claim_support_locator,
    supportObservedAt: normalizedInput.claim_support_observed_at,
    supportMode: normalizedInput.claim_support_mode,
  });
}

/** Trims an optional string and drops the empty result. */
function normalizeOptionalString(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}
