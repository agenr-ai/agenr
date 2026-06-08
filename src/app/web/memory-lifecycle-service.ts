import { normalizeManualClaimKeyUpdate } from "../../core/claim-key-lifecycle.js";
import type { EmbeddingPort } from "../../core/ports.js";
import { storeDurablesDetailed, type StoreDurablesDetailedResult } from "../../core/store/pipeline.js";
import { validateTemporalValidityRange } from "../../core/temporal-validity.js";
import type { DurableUpdateInput, StoreDurableInput } from "../../core/types.js";
import { resolveLocalFilesystemPath } from "../../filesystem-path.js";
import { backupDatabaseFile } from "../dreaming/service.js";
import { withInstanceDatabase, type WebInstanceContext } from "./instance-context.js";

/** Provenance source-file label stamped on durables written from the console. */
const WEB_SOURCE_FILE = "agenr-web";

/**
 * Outcome of a console store or supersede operation.
 */
export interface WebStoreResult {
  /** Detailed store pipeline result with per-input outcomes. */
  result: StoreDurablesDetailedResult;
  /** Id of the stored durable, when one was created. */
  durableId: string | null;
  /** Database backup path created before the mutation, when applicable. */
  backupPath: string | null;
}

/**
 * Outcome of a console metadata update or validity close.
 */
export interface WebLifecycleMutationResult {
  /** True when the underlying lifecycle write applied. */
  updated: boolean;
  /** Database backup path created before the mutation, when applicable. */
  backupPath: string | null;
}

/**
 * Stores a brand-new durable through the shared store pipeline.
 *
 * Storing is additive and reversible through retire/supersede, so it does not
 * take a pre-write backup. Claim-key provenance is stamped with a console
 * locator so the lifecycle stays auditable.
 *
 * @param input - Durable fields, instance context, and embedding port.
 * @returns Store result plus the new durable id when one was created.
 */
export async function storeWebDurable(input: { durable: StoreDurableInput; context: WebInstanceContext; embedding: EmbeddingPort }): Promise<WebStoreResult> {
  return withInstanceDatabase(input.context, async (database) => {
    const prepared = stampProvenance(input.durable);
    const result = await storeDurablesDetailed([prepared], database, input.embedding);
    return { result, durableId: readStoredDurableId(result), backupPath: null };
  });
}

/**
 * Supersedes an existing durable by storing a successor that replaces it.
 *
 * Reuses the same store pipeline as a normal store but threads the `supersedes`
 * id so the pipeline links and closes the predecessor through existing
 * lifecycle semantics. A database backup is taken first.
 *
 * @param input - Successor durable fields, predecessor id, and instance binding.
 * @returns Store result, the successor id, and the backup path.
 */
export async function supersedeWebDurable(input: {
  durable: StoreDurableInput;
  supersedesId: string;
  context: WebInstanceContext;
  embedding: EmbeddingPort;
}): Promise<WebStoreResult> {
  const backupPath = await maybeBackup(input.context.dbPath);
  return withInstanceDatabase(input.context, async (database) => {
    const prepared = { ...stampProvenance(input.durable), supersedes: input.supersedesId };
    const result = await storeDurablesDetailed([prepared], database, input.embedding);
    return { result, durableId: readStoredDurableId(result), backupPath };
  });
}

/**
 * Updates metadata-only fields of an existing durable.
 *
 * Supports importance, expiry, claim key, valid-time range, and project. Claim
 * keys are normalized into a complete lifecycle bundle and the valid-time range
 * is validated before the write. A database backup is taken first.
 *
 * @param input - Target id, metadata fields, and instance context.
 * @returns Whether the update applied plus the backup path.
 * @throws Error When the claim key or valid-time range is invalid.
 */
export async function updateWebDurableMetadata(input: {
  id: string;
  fields: {
    importance?: number;
    expiry?: StoreDurableInput["expiry"];
    claimKey?: string;
    validFrom?: string;
    validTo?: string;
    project?: string;
  };
  context: WebInstanceContext;
}): Promise<WebLifecycleMutationResult> {
  const patch = buildMetadataPatch(input.fields);
  if (Object.keys(patch).length === 0) {
    throw new Error("Provide at least one field to update.");
  }

  const backupPath = await maybeBackup(input.context.dbPath);
  return withInstanceDatabase(input.context, async (database) => {
    const updated = await database.updateDurable(input.id, patch);
    return { updated, backupPath };
  });
}

/**
 * Retires a durable by closing its valid-time window.
 *
 * This sets `valid_to` to now rather than deleting the row, preserving the
 * historical record. A database backup is taken first.
 *
 * @param input - Target id, optional reason, and instance context.
 * @returns Whether the close applied plus the backup path.
 */
export async function closeWebDurableValidity(input: { id: string; reason?: string; context: WebInstanceContext }): Promise<WebLifecycleMutationResult> {
  const backupPath = await maybeBackup(input.context.dbPath);
  return withInstanceDatabase(input.context, async (database) => {
    const updated = await database.closeDurableValidity(input.id, input.reason);
    return { updated, backupPath };
  });
}

/** Reads the durable id recorded by the store pipeline for a single-input store. */
function readStoredDurableId(result: StoreDurablesDetailedResult, inputIndex = 0): string | null {
  return result.details.find((detail) => detail.inputIndex === inputIndex && detail.outcome === "stored")?.durableId ?? null;
}

/** Builds a validated metadata patch from console update fields. */
function buildMetadataPatch(fields: {
  importance?: number;
  expiry?: StoreDurableInput["expiry"];
  claimKey?: string;
  validFrom?: string;
  validTo?: string;
  project?: string;
}): DurableUpdateInput {
  const validity = validateTemporalValidityRange(fields.validFrom, fields.validTo);
  if (!validity.ok) {
    throw new Error(validity.message);
  }

  const claimKeyFields = fields.claimKey === undefined ? {} : resolveClaimKeyUpdate(fields.claimKey);

  return {
    ...(fields.importance !== undefined ? { importance: fields.importance } : {}),
    ...(fields.expiry !== undefined ? { expiry: fields.expiry } : {}),
    ...claimKeyFields,
    ...(fields.validFrom !== undefined ? { valid_from: validity.value.validFrom } : {}),
    ...(fields.validTo !== undefined ? { valid_to: validity.value.validTo } : {}),
    ...(fields.project !== undefined ? { project: fields.project } : {}),
  };
}

/** Normalizes a console-supplied claim key into a complete lifecycle bundle. */
function resolveClaimKeyUpdate(claimKey: string): DurableUpdateInput {
  try {
    const normalized = normalizeManualClaimKeyUpdate({
      claimKey,
      rawClaimKey: claimKey,
      supportSourceKind: "tool_call",
      supportLocator: `${WEB_SOURCE_FILE}#update`,
      supportObservedAt: new Date().toISOString(),
      supportMode: "explicit",
    });
    return normalized.updateFields;
  } catch {
    throw new Error("Claim key must use the canonical entity/attribute format.");
  }
}

/** Stamps console provenance onto a store input that lacks explicit source metadata. */
function stampProvenance(durable: StoreDurableInput): StoreDurableInput {
  const stamped: StoreDurableInput = {
    ...durable,
    source_file: durable.source_file ?? WEB_SOURCE_FILE,
  };

  if (durable.claim_key && durable.claim_support_source_kind === undefined) {
    return {
      ...stamped,
      claim_key_raw: durable.claim_key_raw ?? durable.claim_key,
      claim_support_source_kind: "tool_call",
      claim_support_locator: `${WEB_SOURCE_FILE}#store`,
      claim_support_observed_at: new Date().toISOString(),
      claim_support_mode: "explicit",
    };
  }

  return stamped;
}

/** Creates a database backup when the path is a real local file. */
async function maybeBackup(dbPath: string): Promise<string | null> {
  if (dbPath === ":memory:" || resolveLocalFilesystemPath(dbPath) === null) {
    return null;
  }

  return backupDatabaseFile(dbPath);
}
