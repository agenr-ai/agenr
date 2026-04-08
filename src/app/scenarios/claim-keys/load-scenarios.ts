import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { requireClaimKeySource, requireClaimKeyStatus, requireClaimSupportMode } from "../../../core/claim-key-lifecycle.js";
import type { EntryType, StoreEntryInput } from "../../../core/types.js";
import type {
  ClaimKeyIngestScenarioInput,
  ClaimKeyScenario,
  ClaimKeyScenarioExpectations,
  ClaimKeyScenarioKind,
  ClaimKeyScenarioModelFixtures,
  ClaimKeyScenarioProposalAssert,
  ClaimKeyScenarioProposalMatch,
  ClaimKeyScenarioRowAssert,
  ClaimKeyScenarioRowMatch,
  ClaimKeyScenarioSeedEntry,
  ClaimKeyScenarioSetup,
  ClaimKeyScenarioStoreOptions,
  ClaimKeyScenarioSurgeonOptions,
  ClaimKeyScenarioWarningExpectation,
  ClaimKeyStoreScenarioInput,
  ClaimKeySurgeonScenarioInput,
} from "./types.js";

const SCENARIO_ROOT_SEGMENTS = ["tests", "scenarios", "claim-keys"] as const;
const SUPPORTED_KINDS: ClaimKeyScenarioKind[] = ["ingest", "store", "surgeon"];
const SUPPORTED_ENTRY_TYPES: EntryType[] = ["fact", "decision", "preference", "lesson", "relationship", "milestone"];

/**
 * Returns the default repo-local claim-key scenario root.
 *
 * @param options - Optional cwd and module URL overrides used by tests.
 * @returns Absolute path to the default scenario directory.
 */
export function getDefaultClaimKeyScenarioRoot(
  options: {
    cwd?: string;
    moduleUrl?: string;
  } = {},
): string {
  const moduleDirectory = path.dirname(fileURLToPath(options.moduleUrl ?? import.meta.url));
  const startDirectories = Array.from(new Set([path.resolve(options.cwd ?? process.cwd()), moduleDirectory]));

  for (const startDirectory of startDirectories) {
    const discovered = findScenarioRootFrom(startDirectory);
    if (discovered) {
      return discovered;
    }
  }

  throw new Error(`Unable to locate ${SCENARIO_ROOT_SEGMENTS.join("/")} from cwd "${options.cwd ?? process.cwd()}" or module "${moduleDirectory}".`);
}

/**
 * Discovers, parses, and validates all claim-key scenario files under one root.
 *
 * @param rootDir - Root directory containing `ingest`, `store`, and `surgeon` subdirectories.
 * @returns Sorted loaded scenarios ready for listing or execution.
 */
export async function loadClaimKeyScenarios(rootDir = getDefaultClaimKeyScenarioRoot()): Promise<ClaimKeyScenario[]> {
  const discoveredFiles = await discoverScenarioFiles(rootDir);
  const loaded = await Promise.all(discoveredFiles.map((filePath) => loadClaimKeyScenarioFile(filePath, rootDir)));
  return loaded.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Loads one scenario file and validates it into the canonical runtime shape.
 *
 * @param filePath - Absolute path to the scenario JSON file.
 * @param rootDir - Scenario root used for relative fixture resolution checks.
 * @returns Validated scenario object.
 */
export async function loadClaimKeyScenarioFile(filePath: string, rootDir = getDefaultClaimKeyScenarioRoot()): Promise<ClaimKeyScenario> {
  const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  return validateClaimKeyScenario(raw, filePath, rootDir);
}

/**
 * Validates one raw scenario JSON payload.
 *
 * @param input - Raw parsed JSON value.
 * @param filePath - Source file path used in validation messages.
 * @param rootDir - Scenario root used for relative fixture resolution checks.
 * @returns Canonical validated scenario object.
 */
export function validateClaimKeyScenario(input: unknown, filePath: string, rootDir = getDefaultClaimKeyScenarioRoot()): ClaimKeyScenario {
  const record = asRecord(input, "Scenario root payload", filePath);
  const id = readRequiredString(record.id, "id", filePath);
  const kind = readScenarioKind(record.kind, filePath);
  const expect = readExpectations(record.expect, filePath);
  const sandbox = readSandboxConfig(record.sandbox, filePath);
  const setup = readSetup(record.setup, filePath);
  const description = readOptionalString(record.description, "description", filePath);
  const tags = readOptionalStringArray(record.tags, "tags", filePath);
  const notes = readOptionalNotes(record.notes, filePath);

  if (id !== id.toLowerCase()) {
    throw new Error(`Invalid scenario ${filePath}: id must be lowercase.`);
  }

  const base = {
    id,
    kind,
    filePath,
    expect,
    ...(description ? { description } : {}),
    ...(tags ? { tags } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(setup ? { setup } : {}),
    ...(notes ? { notes } : {}),
  };

  switch (kind) {
    case "ingest":
      return {
        ...base,
        kind,
        input: readIngestInput(record.input, filePath, rootDir),
      };
    case "store":
      return {
        ...base,
        kind,
        input: readStoreInput(record.input, filePath, rootDir),
      };
    case "surgeon":
      return {
        ...base,
        kind,
        input: readSurgeonInput(record.input, filePath, rootDir),
      };
  }
}

/**
 * Discovers all scenario JSON files under the supported kind directories.
 *
 * @param rootDir - Scenario root to scan.
 * @returns Absolute file paths for all discovered scenario files.
 */
async function discoverScenarioFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];

  for (const kind of SUPPORTED_KINDS) {
    const directory = path.join(rootDir, kind);
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      files.push(path.join(directory, entry.name));
    }
  }

  return files.sort();
}

/**
 * Reads and validates one ingest input block.
 *
 * @param value - Raw input payload.
 * @param filePath - Source scenario path for error messages.
 * @param rootDir - Scenario root used for relative fixture resolution.
 * @returns Validated ingest input.
 */
function readIngestInput(value: unknown, filePath: string, rootDir: string): ClaimKeyIngestScenarioInput {
  const record = asRecord(value, "Scenario input", filePath);
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
function readStoreInput(value: unknown, filePath: string, rootDir: string): ClaimKeyStoreScenarioInput {
  const record = asRecord(value, "Scenario input", filePath);
  const entries = readStoreEntries(record.entries, filePath);
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
 * Reads and validates one surgeon input block.
 *
 * @param value - Raw input payload.
 * @param filePath - Source scenario path for error messages.
 * @param rootDir - Scenario root used for relative fixture resolution.
 * @returns Validated surgeon input.
 */
function readSurgeonInput(value: unknown, filePath: string, rootDir: string): ClaimKeySurgeonScenarioInput {
  const record = asRecord(value, "Scenario input", filePath);
  const pass = readRequiredString(record.pass, "input.pass", filePath);
  const surgeonOptions = readSurgeonOptions(record.surgeonOptions, filePath);
  const modelFixtures = readModelFixtures(record.modelFixtures, filePath, rootDir, "surgeon");

  if (pass !== "claim_key_quality") {
    throw new Error(`Invalid scenario ${filePath}: surgeon scenarios only support pass = "claim_key_quality".`);
  }

  return {
    pass: "claim_key_quality",
    ...(surgeonOptions ? { surgeonOptions } : {}),
    ...(modelFixtures ? { modelFixtures } : {}),
  };
}

/**
 * Reads and validates one expectation block.
 *
 * @param value - Raw expectation payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Validated expectation object.
 */
function readExpectations(value: unknown, filePath: string): ClaimKeyScenarioExpectations {
  const record = asRecord(value, "Scenario expect", filePath);
  const warnings = readWarningExpectation(record.warnings, filePath);
  const rows = readRowExpectations(record.rows, filePath);
  const rowCount = readRowCountExpectation(record.rowCount, filePath);
  const proposals = readProposalExpectations(record.proposals, filePath);
  const storeResult = readStoreResultExpectation(record.storeResult, filePath);
  const surgeonSummary = readSurgeonSummaryExpectation(record.surgeonSummary, filePath);

  return {
    ...(warnings ? { warnings } : {}),
    ...(rows ? { rows } : {}),
    ...(rowCount ? { rowCount } : {}),
    ...(proposals ? { proposals } : {}),
    ...(storeResult !== undefined ? { storeResult } : {}),
    ...(surgeonSummary !== undefined ? { surgeonSummary } : {}),
  };
}

/**
 * Reads and validates one optional setup block.
 *
 * @param value - Raw setup payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Validated setup block, when present.
 */
function readSetup(value: unknown, filePath: string): ClaimKeyScenarioSetup | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value, "Scenario setup", filePath);
  if (record.preRunSurgeon !== undefined) {
    throw new Error(`Invalid scenario ${filePath}: setup.preRunSurgeon is not supported in v1.`);
  }

  const seedEntries = readSeedEntries(record.seedEntries, filePath);
  const seedFixtureFile = readOptionalRelativeFixturePath(record.seedFixtureFile, "setup.seedFixtureFile", filePath);

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
 * @returns Validated sandbox config, when present.
 */
function readSandboxConfig(value: unknown, filePath: string): ClaimKeyScenario["sandbox"] {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value, "Scenario sandbox", filePath);
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
 * Reads one optional model-fixture block.
 *
 * @param value - Raw model-fixture payload.
 * @param filePath - Source scenario path for error messages.
 * @param rootDir - Scenario root used for relative fixture resolution.
 * @param kind - Scenario kind being validated.
 * @returns Validated model-fixture block, when present.
 */
function readModelFixtures(value: unknown, filePath: string, rootDir: string, kind: ClaimKeyScenarioKind): ClaimKeyScenarioModelFixtures | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value, "Scenario modelFixtures", filePath);
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
 * @returns Validated ingest options, when present.
 */
function readIngestOptions(value: unknown, filePath: string): ClaimKeyIngestScenarioInput["ingestOptions"] {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value, "Scenario ingestOptions", filePath);
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
 * @returns Validated store options, when present.
 */
function readStoreOptions(value: unknown, filePath: string): ClaimKeyScenarioStoreOptions | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value, "Scenario storeOptions", filePath);
  const claimExtraction = readOptionalBoolean(record.claimExtraction, "input.storeOptions.claimExtraction", filePath);
  const verbose = readOptionalBoolean(record.verbose, "input.storeOptions.verbose", filePath);

  return {
    ...(claimExtraction !== undefined ? { claimExtraction } : {}),
    ...(verbose !== undefined ? { verbose } : {}),
  };
}

/**
 * Reads one narrow surgeon-options block.
 *
 * @param value - Raw surgeon-options payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Validated surgeon options, when present.
 */
function readSurgeonOptions(value: unknown, filePath: string): ClaimKeyScenarioSurgeonOptions | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value, "Scenario surgeonOptions", filePath);
  const apply = readOptionalBoolean(record.apply, "input.surgeonOptions.apply", filePath);
  const verbose = readOptionalBoolean(record.verbose, "input.surgeonOptions.verbose", filePath);
  const project = readOptionalNullableString(record.project, "input.surgeonOptions.project", filePath);
  const entryIds = readOptionalStringArray(record.entryIds, "input.surgeonOptions.entryIds", filePath);
  const claimKeyPrefix = readOptionalString(record.claimKeyPrefix, "input.surgeonOptions.claimKeyPrefix", filePath);
  const type = readOptionalString(record.type, "input.surgeonOptions.type", filePath);
  const includeInactive = readOptionalBoolean(record.includeInactive, "input.surgeonOptions.includeInactive", filePath);

  return {
    ...(apply !== undefined ? { apply } : {}),
    ...(verbose !== undefined ? { verbose } : {}),
    ...(project !== undefined ? { project } : {}),
    ...(entryIds ? { entryIds } : {}),
    ...(claimKeyPrefix ? { claimKeyPrefix } : {}),
    ...(type ? { type } : {}),
    ...(includeInactive !== undefined ? { includeInactive } : {}),
  };
}

/**
 * Reads one optional warning-expectation block.
 *
 * @param value - Raw warnings payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Validated warning expectation, when present.
 */
function readWarningExpectation(value: unknown, filePath: string): ClaimKeyScenarioWarningExpectation | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value, "Scenario expect.warnings", filePath);
  const contains = readOptionalStringArray(record.contains, "expect.warnings.contains", filePath);
  const absent = readOptionalStringArray(record.absent, "expect.warnings.absent", filePath);

  return {
    ...(contains ? { contains } : {}),
    ...(absent ? { absent } : {}),
  };
}

/**
 * Reads entry-row expectations.
 *
 * @param value - Raw rows payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Validated row expectations, when present.
 */
function readRowExpectations(value: unknown, filePath: string): ClaimKeyScenarioExpectations["rows"] {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`Invalid scenario ${filePath}: expect.rows must be an array.`);
  }

  return value.map((row, index) => {
    const record = asRecord(row, `expect.rows[${index}]`, filePath);
    return {
      match: readRowMatch(record.match, `${filePath} expect.rows[${index}]`),
      assert: readRowAssert(record.assert, `${filePath} expect.rows[${index}]`),
    };
  });
}

/**
 * Reads proposal expectations.
 *
 * @param value - Raw proposal payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Validated proposal expectations, when present.
 */
function readProposalExpectations(value: unknown, filePath: string): ClaimKeyScenarioExpectations["proposals"] {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`Invalid scenario ${filePath}: expect.proposals must be an array.`);
  }

  return value.map((proposal, index) => {
    const record = asRecord(proposal, `expect.proposals[${index}]`, filePath);
    return {
      match: readProposalMatch(record.match, `${filePath} expect.proposals[${index}]`),
      assert: readProposalAssert(record.assert, `${filePath} expect.proposals[${index}]`),
    };
  });
}

/**
 * Reads row-count expectations.
 *
 * @param value - Raw row-count payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Validated row-count expectations, when present.
 */
function readRowCountExpectation(value: unknown, filePath: string): ClaimKeyScenarioExpectations["rowCount"] {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value, "Scenario expect.rowCount", filePath);

  return {
    ...(record.entries !== undefined ? { entries: readRequiredInteger(record.entries, "expect.rowCount.entries", filePath) } : {}),
    ...(record.activeEntries !== undefined ? { activeEntries: readRequiredInteger(record.activeEntries, "expect.rowCount.activeEntries", filePath) } : {}),
    ...(record.entriesWithClaimKey !== undefined
      ? { entriesWithClaimKey: readRequiredInteger(record.entriesWithClaimKey, "expect.rowCount.entriesWithClaimKey", filePath) }
      : {}),
    ...(record.proposals !== undefined ? { proposals: readRequiredInteger(record.proposals, "expect.rowCount.proposals", filePath) } : {}),
  };
}

/**
 * Reads store-result expectations.
 *
 * @param value - Raw store-result payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Partial store-result expectation, null, or undefined when absent.
 */
function readStoreResultExpectation(value: unknown, filePath: string): ClaimKeyScenarioExpectations["storeResult"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const record = asRecord(value, "Scenario expect.storeResult", filePath);
  return {
    ...(record.stored !== undefined ? { stored: readRequiredInteger(record.stored, "expect.storeResult.stored", filePath) } : {}),
    ...(record.skipped !== undefined ? { skipped: readRequiredInteger(record.skipped, "expect.storeResult.skipped", filePath) } : {}),
    ...(record.rejected !== undefined ? { rejected: readRequiredInteger(record.rejected, "expect.storeResult.rejected", filePath) } : {}),
  };
}

/**
 * Reads surgeon-summary expectations.
 *
 * @param value - Raw surgeon-summary payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Surgeon-summary expectation, null, or undefined when absent.
 */
function readSurgeonSummaryExpectation(value: unknown, filePath: string): ClaimKeyScenarioExpectations["surgeonSummary"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const record = asRecord(value, "Scenario expect.surgeonSummary", filePath);
  const status = record.status === undefined ? undefined : readRequiredString(record.status, "expect.surgeonSummary.status", filePath);
  const summary = record.summary === undefined ? undefined : (record.summary as ClaimKeyScenarioExpectations["surgeonSummary"]);

  return {
    ...(status ? { status: status as never } : {}),
    ...(summary !== undefined ? { summary: summary as never } : {}),
  };
}

/**
 * Reads one store entry array from a raw scenario payload.
 *
 * @param value - Raw entries payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Validated store entry array.
 */
function readStoreEntries(value: unknown, filePath: string): StoreEntryInput[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid scenario ${filePath}: input.entries must be an array.`);
  }

  return value.map((entry, index) => readStoreEntryInput(entry, `${filePath} input.entries[${index}]`));
}

/**
 * Reads one scenario seed-entry array from a raw setup payload.
 *
 * @param value - Raw seed-entry payload.
 * @param filePath - Source scenario path for error messages.
 * @returns Validated seed-entry array, when present.
 */
function readSeedEntries(value: unknown, filePath: string): ClaimKeyScenarioSeedEntry[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`Invalid scenario ${filePath}: setup.seedEntries must be an array.`);
  }

  return value.map((entry, index) => readSeedEntry(entry, `${filePath} setup.seedEntries[${index}]`));
}

/**
 * Reads one raw store entry into the supported store-input shape.
 *
 * @param value - Raw entry payload.
 * @param label - Human-readable label used in validation messages.
 * @returns Validated store entry input.
 */
function readStoreEntryInput(value: unknown, label: string): StoreEntryInput {
  const record = asRecord(value, label, label);
  const type = readRequiredString(record.type, `${label}.type`, label) as EntryType;
  const subject = readRequiredString(record.subject, `${label}.subject`, label);
  const content = readRequiredString(record.content, `${label}.content`, label);
  validateEntryType(type, label);

  return {
    type,
    subject,
    content,
    ...(record.importance !== undefined ? { importance: readRequiredInteger(record.importance, `${label}.importance`, label) } : {}),
    ...(record.expiry !== undefined ? { expiry: readRequiredString(record.expiry, `${label}.expiry`, label) as StoreEntryInput["expiry"] } : {}),
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
 * @param label - Human-readable label used in validation messages.
 * @returns Validated seed entry.
 */
function readSeedEntry(value: unknown, label: string): ClaimKeyScenarioSeedEntry {
  const record = asRecord(value, label, label);
  const type = readRequiredString(record.type, `${label}.type`, label) as EntryType;
  const subject = readRequiredString(record.subject, `${label}.subject`, label);
  const content = readRequiredString(record.content, `${label}.content`, label);
  validateEntryType(type, label);

  return {
    type,
    subject,
    content,
    ...(record.id !== undefined ? { id: readRequiredString(record.id, `${label}.id`, label) } : {}),
    ...(record.importance !== undefined ? { importance: readRequiredInteger(record.importance, `${label}.importance`, label) } : {}),
    ...(record.expiry !== undefined ? { expiry: readRequiredString(record.expiry, `${label}.expiry`, label) as ClaimKeyScenarioSeedEntry["expiry"] } : {}),
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
    ...(record.retired !== undefined ? { retired: readRequiredBoolean(record.retired, `${label}.retired`, label) } : {}),
    ...(record.retired_at !== undefined ? { retired_at: readRequiredString(record.retired_at, `${label}.retired_at`, label) } : {}),
    ...(record.retired_reason !== undefined ? { retired_reason: readRequiredString(record.retired_reason, `${label}.retired_reason`, label) } : {}),
    ...(record.created_at !== undefined ? { created_at: readRequiredString(record.created_at, `${label}.created_at`, label) } : {}),
    ...(record.updated_at !== undefined ? { updated_at: readRequiredString(record.updated_at, `${label}.updated_at`, label) } : {}),
  };
}

/**
 * Reads one row-match block and ensures at least one key is present.
 *
 * @param value - Raw row-match payload.
 * @param label - Human-readable label used in validation messages.
 * @returns Validated row match.
 */
function readRowMatch(value: unknown, label: string): ClaimKeyScenarioRowMatch {
  const record = asRecord(value, `${label} match`, label);
  const match: ClaimKeyScenarioRowMatch = {
    ...(record.id !== undefined ? { id: readRequiredString(record.id, `${label}.match.id`, label) } : {}),
    ...(record.subject !== undefined ? { subject: readRequiredString(record.subject, `${label}.match.subject`, label) } : {}),
    ...(record.content !== undefined ? { content: readRequiredString(record.content, `${label}.match.content`, label) } : {}),
    ...(record.claim_key !== undefined ? { claim_key: readRequiredString(record.claim_key, `${label}.match.claim_key`, label) } : {}),
  };

  if (Object.keys(match).length === 0) {
    throw new Error(`Invalid scenario ${label}: row match must define at least one key.`);
  }

  return match;
}

/**
 * Reads one row-assert block.
 *
 * @param value - Raw row-assert payload.
 * @param label - Human-readable label used in validation messages.
 * @returns Validated row assertions.
 */
function readRowAssert(value: unknown, label: string): ClaimKeyScenarioRowAssert {
  const record = asRecord(value, `${label} assert`, label);
  return {
    ...(record.claim_key !== undefined ? { claim_key: readNullableString(record.claim_key, `${label}.assert.claim_key`, label) } : {}),
    ...(record.claim_key_raw !== undefined ? { claim_key_raw: readNullableString(record.claim_key_raw, `${label}.assert.claim_key_raw`, label) } : {}),
    ...(record.claim_key_status !== undefined
      ? { claim_key_status: readNullableClaimKeyStatus(record.claim_key_status, `${label}.assert.claim_key_status`, label) }
      : {}),
    ...(record.claim_key_source !== undefined
      ? { claim_key_source: readNullableClaimKeySource(record.claim_key_source, `${label}.assert.claim_key_source`, label) }
      : {}),
    ...(record.claim_key_confidence !== undefined
      ? { claim_key_confidence: readNullableNumber(record.claim_key_confidence, `${label}.assert.claim_key_confidence`, label) }
      : {}),
    ...(record.claim_key_rationale !== undefined
      ? { claim_key_rationale: readNullableString(record.claim_key_rationale, `${label}.assert.claim_key_rationale`, label) }
      : {}),
    ...(record.claim_support_source_kind !== undefined
      ? { claim_support_source_kind: readNullableString(record.claim_support_source_kind, `${label}.assert.claim_support_source_kind`, label) }
      : {}),
    ...(record.claim_support_locator !== undefined
      ? { claim_support_locator: readNullableString(record.claim_support_locator, `${label}.assert.claim_support_locator`, label) }
      : {}),
    ...(record.claim_support_observed_at !== undefined
      ? { claim_support_observed_at: readNullableString(record.claim_support_observed_at, `${label}.assert.claim_support_observed_at`, label) }
      : {}),
    ...(record.claim_support_mode !== undefined
      ? { claim_support_mode: readNullableClaimSupportMode(record.claim_support_mode, `${label}.assert.claim_support_mode`, label) }
      : {}),
    ...(record.superseded_by !== undefined ? { superseded_by: readNullableString(record.superseded_by, `${label}.assert.superseded_by`, label) } : {}),
    ...(record.retired !== undefined ? { retired: readRequiredBoolean(record.retired, `${label}.assert.retired`, label) } : {}),
    ...(record.retired_reason !== undefined ? { retired_reason: readNullableString(record.retired_reason, `${label}.assert.retired_reason`, label) } : {}),
    ...(record.subject !== undefined ? { subject: readRequiredString(record.subject, `${label}.assert.subject`, label) } : {}),
    ...(record.content !== undefined ? { content: readRequiredString(record.content, `${label}.assert.content`, label) } : {}),
  };
}

/**
 * Reads one proposal-match block and ensures at least one key is present.
 *
 * @param value - Raw proposal-match payload.
 * @param label - Human-readable label used in validation messages.
 * @returns Validated proposal match.
 */
function readProposalMatch(value: unknown, label: string): ClaimKeyScenarioProposalMatch {
  const record = asRecord(value, `${label} match`, label);
  const match: ClaimKeyScenarioProposalMatch = {
    ...(record.id !== undefined ? { id: readRequiredString(record.id, `${label}.match.id`, label) } : {}),
    ...(record.groupId !== undefined ? { groupId: readRequiredString(record.groupId, `${label}.match.groupId`, label) } : {}),
    ...(record.issueKind !== undefined ? { issueKind: readRequiredString(record.issueKind, `${label}.match.issueKind`, label) } : {}),
    ...(record.source !== undefined ? { source: readRequiredString(record.source, `${label}.match.source`, label) } : {}),
  };

  if (Object.keys(match).length === 0) {
    throw new Error(`Invalid scenario ${label}: proposal match must define at least one key.`);
  }

  return match;
}

/**
 * Reads one proposal-assert block.
 *
 * @param value - Raw proposal-assert payload.
 * @param label - Human-readable label used in validation messages.
 * @returns Validated proposal assertions.
 */
function readProposalAssert(value: unknown, label: string): ClaimKeyScenarioProposalAssert {
  const record = asRecord(value, `${label} assert`, label);
  return {
    ...(record.issueKind !== undefined ? { issueKind: readRequiredString(record.issueKind, `${label}.assert.issueKind`, label) } : {}),
    ...(record.scope !== undefined ? { scope: readRequiredString(record.scope, `${label}.assert.scope`, label) as never } : {}),
    ...(record.source !== undefined ? { source: readRequiredString(record.source, `${label}.assert.source`, label) } : {}),
    ...(record.eligibleForApply !== undefined
      ? { eligibleForApply: readRequiredBoolean(record.eligibleForApply, `${label}.assert.eligibleForApply`, label) }
      : {}),
    ...(record.confidence !== undefined ? { confidence: readNullableNumber(record.confidence, `${label}.assert.confidence`, label) } : {}),
  };
}

/**
 * Resolves a relative fixture path and returns it in root-relative form.
 *
 * @param value - Raw fixture path value.
 * @param label - Human-readable label used in validation messages.
 * @param filePath - Source scenario path for error messages.
 * @param rootDir - Scenario root used for path normalization.
 * @returns Root-relative fixture path.
 */
function readRelativeFixturePath(value: unknown, label: string, filePath: string, rootDir = getDefaultClaimKeyScenarioRoot()): string {
  const normalized = readRequiredString(value, label, filePath);
  return normalizeFixturePath(normalized, rootDir, filePath, label);
}

/**
 * Resolves an optional relative fixture path and returns it in root-relative form.
 *
 * @param value - Raw fixture path value.
 * @param label - Human-readable label used in validation messages.
 * @param filePath - Source scenario path for error messages.
 * @param rootDir - Scenario root used for path normalization.
 * @returns Root-relative fixture path, when present.
 */
function readOptionalRelativeFixturePath(value: unknown, label: string, filePath: string, rootDir = getDefaultClaimKeyScenarioRoot()): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readRelativeFixturePath(value, label, filePath, rootDir);
}

/**
 * Normalizes one fixture path and ensures it stays inside the scenario root.
 *
 * @param relativePath - Raw fixture path from the scenario file.
 * @param rootDir - Scenario root used for normalization.
 * @param filePath - Source scenario path for error messages.
 * @param label - Human-readable label used in validation messages.
 * @returns Normalized root-relative path.
 */
function normalizeFixturePath(relativePath: string, rootDir: string, filePath: string, label: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Invalid scenario ${filePath}: ${label} must be relative to the scenario root.`);
  }

  const resolved = path.resolve(rootDir, relativePath);
  const relative = path.relative(rootDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Invalid scenario ${filePath}: ${label} must stay inside the scenario root.`);
  }

  return relative.split(path.sep).join("/");
}

/**
 * Walks upward from one start directory and returns the first repo-local scenario root that exists.
 *
 * @param startDirectory - Directory to begin searching from.
 * @returns Absolute scenario root path when found.
 */
function findScenarioRootFrom(startDirectory: string): string | undefined {
  let currentDirectory = path.resolve(startDirectory);

  while (true) {
    const candidate = path.join(currentDirectory, ...SCENARIO_ROOT_SEGMENTS);
    if (existsSync(candidate)) {
      return candidate;
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}

/**
 * Checks that one raw value is a supported scenario kind.
 *
 * @param value - Raw scenario kind value.
 * @param filePath - Source scenario path for error messages.
 * @returns Validated scenario kind.
 */
function readScenarioKind(value: unknown, filePath: string): ClaimKeyScenarioKind {
  const kind = readRequiredString(value, "kind", filePath);
  if (!SUPPORTED_KINDS.includes(kind as ClaimKeyScenarioKind)) {
    throw new Error(`Invalid scenario ${filePath}: unsupported kind "${kind}".`);
  }

  return kind as ClaimKeyScenarioKind;
}

/**
 * Verifies that one parsed entry type is supported.
 *
 * @param value - Parsed entry type.
 * @param label - Human-readable label used in validation messages.
 */
function validateEntryType(value: string, label: string): void {
  if (!SUPPORTED_ENTRY_TYPES.includes(value as EntryType)) {
    throw new Error(`Invalid scenario ${label}: unsupported entry type "${value}".`);
  }
}

/**
 * Reads one required string from a raw JSON field.
 *
 * @param value - Raw field value.
 * @param label - Human-readable label used in validation messages.
 * @param filePath - Source scenario path for error messages.
 * @returns Trimmed non-empty string value.
 */
function readRequiredString(value: unknown, label: string, filePath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid scenario ${filePath}: ${label} must be a non-empty string.`);
  }

  return value.trim();
}

/**
 * Reads one optional string from a raw JSON field.
 *
 * @param value - Raw field value.
 * @param label - Human-readable label used in validation messages.
 * @param filePath - Source scenario path for error messages.
 * @returns Trimmed string value, when present.
 */
function readOptionalString(value: unknown, label: string, filePath: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readRequiredString(value, label, filePath);
}

/**
 * Reads one optional string-or-null field.
 *
 * @param value - Raw field value.
 * @param label - Human-readable label used in validation messages.
 * @param filePath - Source scenario path for error messages.
 * @returns Trimmed string, null, or undefined when absent.
 */
function readOptionalNullableString(value: unknown, label: string, filePath: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  return readRequiredString(value, label, filePath);
}

/**
 * Reads one required integer from a raw JSON field.
 *
 * @param value - Raw field value.
 * @param label - Human-readable label used in validation messages.
 * @param filePath - Source scenario path for error messages.
 * @returns Parsed integer.
 */
function readRequiredInteger(value: unknown, label: string, filePath: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Invalid scenario ${filePath}: ${label} must be an integer.`);
  }

  return value;
}

/**
 * Reads one required numeric field.
 *
 * @param value - Raw field value.
 * @param label - Human-readable label used in validation messages.
 * @param filePath - Source scenario path for error messages.
 * @returns Parsed finite number.
 */
function readRequiredNumber(value: unknown, label: string, filePath: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid scenario ${filePath}: ${label} must be a finite number.`);
  }

  return value;
}

/**
 * Reads one required boolean field.
 *
 * @param value - Raw field value.
 * @param label - Human-readable label used in validation messages.
 * @param filePath - Source scenario path for error messages.
 * @returns Parsed boolean.
 */
function readRequiredBoolean(value: unknown, label: string, filePath: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Invalid scenario ${filePath}: ${label} must be a boolean.`);
  }

  return value;
}

/**
 * Reads one optional boolean field.
 *
 * @param value - Raw field value.
 * @param label - Human-readable label used in validation messages.
 * @param filePath - Source scenario path for error messages.
 * @returns Parsed boolean, when present.
 */
function readOptionalBoolean(value: unknown, label: string, filePath: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readRequiredBoolean(value, label, filePath);
}

/**
 * Reads one nullable string field used by equality-only assertions.
 *
 * @param value - Raw field value.
 * @param label - Human-readable label used in validation messages.
 * @param filePath - Source scenario path for error messages.
 * @returns Parsed string or null.
 */
function readNullableString(value: unknown, label: string, filePath: string): string | null {
  if (value === null) {
    return null;
  }

  return readRequiredString(value, label, filePath);
}

/**
 * Reads one nullable claim-key lifecycle status used by scenario assertions.
 *
 * @param value - Raw field value.
 * @param label - Human-readable label used in validation messages.
 * @param filePath - Source scenario path for error messages.
 * @returns Parsed claim-key status or null.
 */
function readNullableClaimKeyStatus(value: unknown, label: string, filePath: string): string | null {
  if (value === null) {
    return null;
  }

  return requireClaimKeyStatus(value, `${filePath}: ${label}`);
}

/**
 * Reads one nullable claim-key lifecycle source used by scenario assertions.
 *
 * @param value - Raw field value.
 * @param label - Human-readable label used in validation messages.
 * @param filePath - Source scenario path for error messages.
 * @returns Parsed claim-key source or null.
 */
function readNullableClaimKeySource(value: unknown, label: string, filePath: string): string | null {
  if (value === null) {
    return null;
  }

  return requireClaimKeySource(value, `${filePath}: ${label}`);
}

/**
 * Reads one nullable claim-support mode used by scenario assertions.
 *
 * @param value - Raw field value.
 * @param label - Human-readable label used in validation messages.
 * @param filePath - Source scenario path for error messages.
 * @returns Parsed claim-support mode or null.
 */
function readNullableClaimSupportMode(value: unknown, label: string, filePath: string): string | null {
  if (value === null) {
    return null;
  }

  return requireClaimSupportMode(value, `${filePath}: ${label}`);
}

/**
 * Reads one nullable numeric field used by equality-only assertions.
 *
 * @param value - Raw field value.
 * @param label - Human-readable label used in validation messages.
 * @param filePath - Source scenario path for error messages.
 * @returns Parsed finite number or null.
 */
function readNullableNumber(value: unknown, label: string, filePath: string): number | null {
  if (value === null) {
    return null;
  }

  return readRequiredNumber(value, label, filePath);
}

/**
 * Reads one required string array field.
 *
 * @param value - Raw field value.
 * @param label - Human-readable label used in validation messages.
 * @param filePath - Source scenario path for error messages.
 * @returns Parsed string array.
 */
function readRequiredStringArray(value: unknown, label: string, filePath: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid scenario ${filePath}: ${label} must be an array of strings.`);
  }

  return value.map((item, index) => readRequiredString(item, `${label}[${index}]`, filePath));
}

/**
 * Reads one optional string array field.
 *
 * @param value - Raw field value.
 * @param label - Human-readable label used in validation messages.
 * @param filePath - Source scenario path for error messages.
 * @returns Parsed string array, when present.
 */
function readOptionalStringArray(value: unknown, label: string, filePath: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readRequiredStringArray(value, label, filePath);
}

/**
 * Reads one optional notes field as either a string or string array.
 *
 * @param value - Raw field value.
 * @param filePath - Source scenario path for error messages.
 * @returns Parsed notes payload, when present.
 */
function readOptionalNotes(value: unknown, filePath: string): string | string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return readRequiredString(value, "notes", filePath);
  }

  return readRequiredStringArray(value, "notes", filePath);
}

/**
 * Verifies that one raw JSON value is an object.
 *
 * @param value - Raw JSON value.
 * @param label - Human-readable label used in validation messages.
 * @param filePath - Source scenario path for error messages.
 * @returns Raw object record.
 */
function asRecord(value: unknown, label: string, filePath: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid scenario ${filePath}: ${label} must be an object.`);
  }

  return value as Record<string, unknown>;
}
