import { requireClaimKeySource, requireClaimKeyStatus, requireClaimSupportMode } from "../../../../core/claim-key-lifecycle.js";
import type { DurableKind, Expiry, StoreDurableInput } from "../../../../core/types.js";
import type {
  ClaimKeyIngestScenarioInput,
  ClaimKeyScenario,
  ClaimKeyScenarioKind,
  ClaimKeyScenarioModelFixtures,
  ClaimKeyScenarioSeedEntry,
  ClaimKeyScenarioSetup,
  ClaimKeyScenarioStoreOptions,
  ClaimKeyScenarioDreamingOptions,
  ClaimKeyStoreScenarioInput,
  ClaimKeyDreamingScenarioInput,
} from "../types.js";
import {
  readObject,
  readOptionalBoolean,
  readOptionalNullableString,
  readOptionalString,
  readOptionalStringArray,
  readRequiredBoolean,
  readRequiredEnum,
  readRequiredNumber,
  readRequiredString,
  readRequiredStringArray,
} from "./shared.js";
import { readOptionalRelativeFixturePath, readRelativeFixturePath } from "./scenario-root.js";

const ROOT_KEYS = new Set(["id", "kind", "input", "expect", "description", "tags", "sandbox", "setup", "notes"]);
const SETUP_KEYS = new Set(["seedEntries", "seedFixtureFile", "preRunSurgeon"]);
const SANDBOX_KEYS = new Set(["reset", "preserveOnFailure", "preserveAlways", "name"]);
const INGEST_INPUT_KEYS = new Set(["transcriptFile", "ingestOptions", "modelFixtures"]);
const STORE_INPUT_KEYS = new Set(["durables", "storeOptions", "modelFixtures"]);
const DREAMING_INPUT_KEYS = new Set(["pass", "dreamingOptions", "modelFixtures"]);
const MODEL_FIXTURE_KEYS = new Set(["extractionResponsesFile", "claimExtractionResponsesFile"]);
const INGEST_OPTIONS_KEYS = new Set(["verbose", "surface", "project"]);
const STORE_OPTIONS_KEYS = new Set(["claimExtraction", "verbose"]);
const DREAMING_OPTIONS_KEYS = new Set(["apply", "verbose", "project", "durableIds", "claimKeyPrefix", "type", "includeInactive"]);
const STORE_ENTRY_KEYS = new Set([
  "type",
  "subject",
  "content",
  "importance",
  "expiry",
  "tags",
  "source_file",
  "source_context",
  "user_id",
  "project",
  "created_at",
  "supersedes",
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
  "valid_from",
  "valid_to",
]);
const SEED_ENTRY_KEYS = new Set([
  "id",
  "type",
  "subject",
  "content",
  "importance",
  "expiry",
  "tags",
  "source_file",
  "source_context",
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
  "superseded_by",
  "valid_from",
  "valid_to",
  "user_id",
  "project",
  "created_at",
  "updated_at",
]);
const SUPPORTED_KINDS = ["ingest", "store", "dreaming"] as const;
const SUPPORTED_DURABLE_KINDS = ["fact", "decision", "preference", "lesson", "relationship", "milestone"] as const satisfies readonly DurableKind[];
const SUPPORTED_EXPIRY_VALUES = ["core", "permanent", "temporary"] as const satisfies readonly Expiry[];

/**
 * Reads the root scenario object and rejects unsupported top-level fields.
 *
 * @param value - Raw parsed scenario payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Root scenario object.
 */
export function readScenarioRoot(value: unknown, filePath: string): Record<string, unknown> {
  return readObject(value, "Scenario root payload", filePath, ROOT_KEYS);
}

/**
 * Reads one supported scenario kind.
 *
 * @param value - Raw kind field.
 * @param filePath - Source scenario path for error messages.
 * @returns Parsed scenario kind.
 */
export function readScenarioKind(value: unknown, filePath: string): ClaimKeyScenarioKind {
  return readRequiredEnum(value, "kind", filePath, SUPPORTED_KINDS);
}

/**
 * Reads and validates one ingest input block.
 *
 * @param value - Raw input payload.
 * @param filePath - Source scenario path for error messages.
 * @param rootDir - Scenario root used for relative fixture resolution.
 * @returns Validated ingest input.
 */
export function readIngestInput(value: unknown, filePath: string, rootDir: string): ClaimKeyIngestScenarioInput {
  const record = readObject(value, "Scenario input", filePath, INGEST_INPUT_KEYS);
  const transcriptFile = readRelativeFixturePath(record.transcriptFile, "input.transcriptFile", filePath, rootDir);
  const modelFixtures = readModelFixtures(record.modelFixtures, filePath, rootDir, "ingest");
  const ingestOptions = readIngestOptions(record.ingestOptions, filePath);

  if (!modelFixtures?.extractionResponsesFile) {
    throw new Error(`Invalid scenario ${filePath}: ingest scenarios require input.modelFixtures.extractionResponsesFile.`);
  }

  return {
    transcriptFile,
    ...(ingestOptions ? { ingestOptions } : {}),
    ...(modelFixtures ? { modelFixtures } : {}),
  };
}

/**
 * Reads and validates one store input block.
 *
 * @param value - Raw input payload.
 * @param filePath - Source scenario path for error messages.
 * @param rootDir - Scenario root used for relative fixture resolution.
 * @returns Validated store input.
 */
export function readStoreInput(value: unknown, filePath: string, rootDir: string): ClaimKeyStoreScenarioInput {
  const record = readObject(value, "Scenario input", filePath, STORE_INPUT_KEYS);
  const entries = readStoreEntries(record.durables, filePath);
  const storeOptions = readStoreOptions(record.storeOptions, filePath);
  const modelFixtures = readModelFixtures(record.modelFixtures, filePath, rootDir, "store");

  if (storeOptions?.claimExtraction === true && !modelFixtures?.claimExtractionResponsesFile) {
    throw new Error(`Invalid scenario ${filePath}: store claim extraction requires input.modelFixtures.claimExtractionResponsesFile.`);
  }

  return {
    entries,
    ...(storeOptions ? { storeOptions } : {}),
    ...(modelFixtures ? { modelFixtures } : {}),
  };
}

/**
 * Reads and validates one dreaming input block.
 *
 * @param value - Raw input payload.
 * @param filePath - Source scenario path for error messages.
 * @param rootDir - Scenario root used for relative fixture resolution.
 * @returns Validated dreaming input.
 */
export function readDreamingInput(value: unknown, filePath: string, rootDir: string): ClaimKeyDreamingScenarioInput {
  const record = readObject(value, "Scenario input", filePath, DREAMING_INPUT_KEYS);
  const pass = readRequiredString(record.pass, "input.pass", filePath);
  const dreamingOptions = readDreamingOptions(record.dreamingOptions, filePath);
  const modelFixtures = readModelFixtures(record.modelFixtures, filePath, rootDir, "dreaming");

  if (pass !== "claim_key_quality") {
    throw new Error(`Invalid scenario ${filePath}: dreaming scenarios only support pass = "claim_key_quality".`);
  }

  return {
    pass: "claim_key_quality",
    ...(dreamingOptions ? { dreamingOptions } : {}),
    ...(modelFixtures ? { modelFixtures } : {}),
  };
}

/**
 * Reads and validates one optional setup block.
 *
 * @param value - Raw setup payload.
 * @param filePath - Source scenario path for error messages.
 * @param rootDir - Scenario root used for fixture resolution.
 * @returns Validated setup block when present.
 */
export function readSetup(value: unknown, filePath: string, rootDir: string): ClaimKeyScenarioSetup | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = readObject(value, "Scenario setup", filePath, SETUP_KEYS);
  if (record.preRunSurgeon !== undefined) {
    throw new Error(`Invalid scenario ${filePath}: setup.preRunSurgeon is not supported in v1.`);
  }

  const seedEntries = readSeedEntries(record.seedEntries, filePath);
  const seedFixtureFile = readOptionalRelativeFixturePath(record.seedFixtureFile, "setup.seedFixtureFile", filePath, rootDir);

  return {
    ...(seedEntries ? { seedEntries } : {}),
    ...(seedFixtureFile ? { seedFixtureFile } : {}),
  };
}

/**
 * Reads and validates one optional sandbox configuration block.
 *
 * @param value - Raw sandbox payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Validated sandbox config when present.
 */
export function readSandboxConfig(value: unknown, filePath: string): ClaimKeyScenario["sandbox"] {
  if (value === undefined) {
    return undefined;
  }

  const record = readObject(value, "Scenario sandbox", filePath, SANDBOX_KEYS);
  const reset = readOptionalBoolean(record.reset, "sandbox.reset", filePath);
  const preserveOnFailure = readOptionalBoolean(record.preserveOnFailure, "sandbox.preserveOnFailure", filePath);
  const preserveAlways = readOptionalBoolean(record.preserveAlways, "sandbox.preserveAlways", filePath);
  const name = readOptionalString(record.name, "sandbox.name", filePath);

  if (reset === false) {
    throw new Error(`Invalid scenario ${filePath}: sandbox.reset=false is not supported in v1.`);
  }

  return {
    ...(reset !== undefined ? { reset } : {}),
    ...(preserveOnFailure !== undefined ? { preserveOnFailure } : {}),
    ...(preserveAlways !== undefined ? { preserveAlways } : {}),
    ...(name ? { name } : {}),
  };
}

/**
 * Reads one scenario seed-entry array from raw JSON.
 *
 * @param value - Raw seed-entry payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Validated seed-entry array when present.
 */
export function readSeedEntries(value: unknown, filePath: string): ClaimKeyScenarioSeedEntry[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`Invalid scenario ${filePath}: setup.seedEntries must be an array.`);
  }

  return value.map((entry, index) => readSeedEntry(entry, `${filePath} setup.seedEntries[${index}]`));
}

/**
 * Reads one optional model-fixture block for deterministic scenario execution.
 *
 * @param value - Raw model-fixture payload.
 * @param filePath - Source scenario path for error messages.
 * @param rootDir - Scenario root used for fixture resolution.
 * @param kind - Scenario kind being validated.
 * @returns Validated model-fixture block when present.
 */
function readModelFixtures(value: unknown, filePath: string, rootDir: string, kind: ClaimKeyScenarioKind): ClaimKeyScenarioModelFixtures | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = readObject(value, "Scenario modelFixtures", filePath, MODEL_FIXTURE_KEYS);
  const extractionResponsesFile = readOptionalRelativeFixturePath(
    record.extractionResponsesFile,
    "input.modelFixtures.extractionResponsesFile",
    filePath,
    rootDir,
  );
  const claimExtractionResponsesFile = readOptionalRelativeFixturePath(
    record.claimExtractionResponsesFile,
    "input.modelFixtures.claimExtractionResponsesFile",
    filePath,
    rootDir,
  );

  if (kind !== "ingest" && extractionResponsesFile) {
    throw new Error(`Invalid scenario ${filePath}: extractionResponsesFile is only supported for ingest scenarios.`);
  }

  return {
    ...(extractionResponsesFile ? { extractionResponsesFile } : {}),
    ...(claimExtractionResponsesFile ? { claimExtractionResponsesFile } : {}),
  };
}

/**
 * Reads one narrow ingest-options block.
 *
 * @param value - Raw ingest-options payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Validated ingest options when present.
 */
function readIngestOptions(value: unknown, filePath: string): ClaimKeyIngestScenarioInput["ingestOptions"] {
  if (value === undefined) {
    return undefined;
  }

  const record = readObject(value, "Scenario ingestOptions", filePath, INGEST_OPTIONS_KEYS);
  const verbose = readOptionalBoolean(record.verbose, "input.ingestOptions.verbose", filePath);
  const surface = readOptionalString(record.surface, "input.ingestOptions.surface", filePath);
  const project = readOptionalString(record.project, "input.ingestOptions.project", filePath);

  return {
    ...(verbose !== undefined ? { verbose } : {}),
    ...(surface ? { surface } : {}),
    ...(project ? { project } : {}),
  };
}

/**
 * Reads one narrow store-options block.
 *
 * @param value - Raw store-options payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Validated store options when present.
 */
function readStoreOptions(value: unknown, filePath: string): ClaimKeyScenarioStoreOptions | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = readObject(value, "Scenario storeOptions", filePath, STORE_OPTIONS_KEYS);
  const claimExtraction = readOptionalBoolean(record.claimExtraction, "input.storeOptions.claimExtraction", filePath);
  const verbose = readOptionalBoolean(record.verbose, "input.storeOptions.verbose", filePath);

  return {
    ...(claimExtraction !== undefined ? { claimExtraction } : {}),
    ...(verbose !== undefined ? { verbose } : {}),
  };
}

/**
 * Reads one narrow dreaming-options block.
 *
 * @param value - Raw dreaming-options payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Validated dreaming options when present.
 */
function readDreamingOptions(value: unknown, filePath: string): ClaimKeyScenarioDreamingOptions | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = readObject(value, "Scenario dreamingOptions", filePath, DREAMING_OPTIONS_KEYS);
  const apply = readOptionalBoolean(record.apply, "input.dreamingOptions.apply", filePath);
  const verbose = readOptionalBoolean(record.verbose, "input.dreamingOptions.verbose", filePath);
  const project = readOptionalNullableString(record.project, "input.dreamingOptions.project", filePath);
  const durableIds = readOptionalStringArray(record.durableIds, "input.dreamingOptions.durableIds", filePath);
  const claimKeyPrefix = readOptionalString(record.claimKeyPrefix, "input.dreamingOptions.claimKeyPrefix", filePath);
  const type = readOptionalString(record.type, "input.dreamingOptions.type", filePath);
  const includeInactive = readOptionalBoolean(record.includeInactive, "input.dreamingOptions.includeInactive", filePath);

  return {
    ...(apply !== undefined ? { apply } : {}),
    ...(verbose !== undefined ? { verbose } : {}),
    ...(project !== undefined ? { project } : {}),
    ...(durableIds ? { durableIds } : {}),
    ...(claimKeyPrefix ? { claimKeyPrefix } : {}),
    ...(type ? { type } : {}),
    ...(includeInactive !== undefined ? { includeInactive } : {}),
  };
}

/**
 * Reads one store-entry array from a raw scenario payload.
 *
 * @param value - Raw entries payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Validated store-entry array.
 */
function readStoreEntries(value: unknown, filePath: string): StoreDurableInput[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid scenario ${filePath}: input.durables must be an array.`);
  }

  return value.map((entry, index) => readStoreDurableInput(entry, `${filePath} input.durables[${index}]`));
}

/**
 * Reads one raw store entry into the supported store-input shape.
 *
 * @param value - Raw entry payload.
 * @param label - Human-readable validation label.
 * @returns Validated store entry input.
 */
function readStoreDurableInput(value: unknown, label: string): StoreDurableInput {
  const record = readObject(value, label, label, STORE_ENTRY_KEYS);
  const type = readRequiredEnum(record.type, `${label}.type`, label, SUPPORTED_DURABLE_KINDS);
  const subject = readRequiredString(record.subject, `${label}.subject`, label);
  const content = readRequiredString(record.content, `${label}.content`, label);

  return {
    type,
    subject,
    content,
    ...(record.importance !== undefined ? { importance: readRequiredNumber(record.importance, `${label}.importance`, label) } : {}),
    ...(record.expiry !== undefined ? { expiry: readRequiredEnum(record.expiry, `${label}.expiry`, label, SUPPORTED_EXPIRY_VALUES) } : {}),
    ...(record.tags !== undefined ? { tags: readRequiredStringArray(record.tags, `${label}.tags`, label) } : {}),
    ...(record.source_file !== undefined ? { source_file: readRequiredString(record.source_file, `${label}.source_file`, label) } : {}),
    ...(record.source_context !== undefined ? { source_context: readRequiredString(record.source_context, `${label}.source_context`, label) } : {}),
    ...(record.user_id !== undefined ? { user_id: readRequiredString(record.user_id, `${label}.user_id`, label) } : {}),
    ...(record.project !== undefined ? { project: readRequiredString(record.project, `${label}.project`, label) } : {}),
    ...(record.created_at !== undefined ? { created_at: readRequiredString(record.created_at, `${label}.created_at`, label) } : {}),
    ...(record.supersedes !== undefined ? { supersedes: readRequiredString(record.supersedes, `${label}.supersedes`, label) } : {}),
    ...(record.claim_key !== undefined ? { claim_key: readRequiredString(record.claim_key, `${label}.claim_key`, label) } : {}),
    ...(record.claim_key_raw !== undefined ? { claim_key_raw: readRequiredString(record.claim_key_raw, `${label}.claim_key_raw`, label) } : {}),
    ...(record.claim_key_status !== undefined ? { claim_key_status: requireClaimKeyStatus(record.claim_key_status, `${label}.claim_key_status`) } : {}),
    ...(record.claim_key_source !== undefined ? { claim_key_source: requireClaimKeySource(record.claim_key_source, `${label}.claim_key_source`) } : {}),
    ...(record.claim_key_confidence !== undefined
      ? { claim_key_confidence: readRequiredNumber(record.claim_key_confidence, `${label}.claim_key_confidence`, label) }
      : {}),
    ...(record.claim_key_rationale !== undefined
      ? { claim_key_rationale: readRequiredString(record.claim_key_rationale, `${label}.claim_key_rationale`, label) }
      : {}),
    ...(record.claim_support_source_kind !== undefined
      ? { claim_support_source_kind: readRequiredString(record.claim_support_source_kind, `${label}.claim_support_source_kind`, label) }
      : {}),
    ...(record.claim_support_locator !== undefined
      ? { claim_support_locator: readRequiredString(record.claim_support_locator, `${label}.claim_support_locator`, label) }
      : {}),
    ...(record.claim_support_observed_at !== undefined
      ? { claim_support_observed_at: readRequiredString(record.claim_support_observed_at, `${label}.claim_support_observed_at`, label) }
      : {}),
    ...(record.claim_support_mode !== undefined
      ? { claim_support_mode: requireClaimSupportMode(record.claim_support_mode, `${label}.claim_support_mode`) }
      : {}),
    ...(record.valid_from !== undefined ? { valid_from: readRequiredString(record.valid_from, `${label}.valid_from`, label) } : {}),
    ...(record.valid_to !== undefined ? { valid_to: readRequiredString(record.valid_to, `${label}.valid_to`, label) } : {}),
  };
}

/**
 * Reads one raw seed entry into the supported setup shape.
 *
 * @param value - Raw seed entry payload.
 * @param label - Human-readable validation label.
 * @returns Validated seed entry.
 */
function readSeedEntry(value: unknown, label: string): ClaimKeyScenarioSeedEntry {
  const record = readObject(value, label, label, SEED_ENTRY_KEYS);
  const type = readRequiredEnum(record.type, `${label}.type`, label, SUPPORTED_DURABLE_KINDS);
  const subject = readRequiredString(record.subject, `${label}.subject`, label);
  const content = readRequiredString(record.content, `${label}.content`, label);

  return {
    type,
    subject,
    content,
    ...(record.id !== undefined ? { id: readRequiredString(record.id, `${label}.id`, label) } : {}),
    ...(record.importance !== undefined ? { importance: readRequiredNumber(record.importance, `${label}.importance`, label) } : {}),
    ...(record.expiry !== undefined ? { expiry: readRequiredEnum(record.expiry, `${label}.expiry`, label, SUPPORTED_EXPIRY_VALUES) } : {}),
    ...(record.tags !== undefined ? { tags: readRequiredStringArray(record.tags, `${label}.tags`, label) } : {}),
    ...(record.source_file !== undefined ? { source_file: readRequiredString(record.source_file, `${label}.source_file`, label) } : {}),
    ...(record.source_context !== undefined ? { source_context: readRequiredString(record.source_context, `${label}.source_context`, label) } : {}),
    ...(record.claim_key !== undefined ? { claim_key: readRequiredString(record.claim_key, `${label}.claim_key`, label) } : {}),
    ...(record.claim_key_raw !== undefined ? { claim_key_raw: readRequiredString(record.claim_key_raw, `${label}.claim_key_raw`, label) } : {}),
    ...(record.claim_key_status !== undefined ? { claim_key_status: requireClaimKeyStatus(record.claim_key_status, `${label}.claim_key_status`) } : {}),
    ...(record.claim_key_source !== undefined ? { claim_key_source: requireClaimKeySource(record.claim_key_source, `${label}.claim_key_source`) } : {}),
    ...(record.claim_key_confidence !== undefined
      ? { claim_key_confidence: readRequiredNumber(record.claim_key_confidence, `${label}.claim_key_confidence`, label) }
      : {}),
    ...(record.claim_key_rationale !== undefined
      ? { claim_key_rationale: readRequiredString(record.claim_key_rationale, `${label}.claim_key_rationale`, label) }
      : {}),
    ...(record.claim_support_source_kind !== undefined
      ? { claim_support_source_kind: readRequiredString(record.claim_support_source_kind, `${label}.claim_support_source_kind`, label) }
      : {}),
    ...(record.claim_support_locator !== undefined
      ? { claim_support_locator: readRequiredString(record.claim_support_locator, `${label}.claim_support_locator`, label) }
      : {}),
    ...(record.claim_support_observed_at !== undefined
      ? { claim_support_observed_at: readRequiredString(record.claim_support_observed_at, `${label}.claim_support_observed_at`, label) }
      : {}),
    ...(record.claim_support_mode !== undefined
      ? { claim_support_mode: requireClaimSupportMode(record.claim_support_mode, `${label}.claim_support_mode`) }
      : {}),
    ...(record.superseded_by !== undefined ? { superseded_by: readRequiredString(record.superseded_by, `${label}.superseded_by`, label) } : {}),
    ...(record.valid_from !== undefined ? { valid_from: readRequiredString(record.valid_from, `${label}.valid_from`, label) } : {}),
    ...(record.valid_to !== undefined ? { valid_to: readRequiredString(record.valid_to, `${label}.valid_to`, label) } : {}),
    ...(record.user_id !== undefined ? { user_id: readRequiredString(record.user_id, `${label}.user_id`, label) } : {}),
    ...(record.project !== undefined ? { project: readRequiredString(record.project, `${label}.project`, label) } : {}),
    ...(record.created_at !== undefined ? { created_at: readRequiredString(record.created_at, `${label}.created_at`, label) } : {}),
    ...(record.updated_at !== undefined ? { updated_at: readRequiredString(record.updated_at, `${label}.updated_at`, label) } : {}),
  };
}
