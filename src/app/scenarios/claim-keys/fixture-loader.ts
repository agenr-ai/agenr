import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ClaimKeyScenarioSeedEntry } from "./types.js";
import { readSeedEntries } from "./validation/input.js";
import { readObject, readOptionalBoolean, readOptionalString, readRequiredNumber, readRequiredString, readRequiredStringArray } from "./validation/shared.js";

/**
 * Typed raw extraction-entry fixture accepted by the ingestion fixture LLM.
 */
export interface ClaimKeyScenarioExtractionFixtureEntry {
  type?: string;
  subject?: string;
  content?: string;
  importance?: number | string;
  expiry?: string;
  tags?: string[];
  source_file?: string;
  sourceFile?: string;
  source_context?: string;
  sourceContext?: string;
  claim_key?: string;
  claimKey?: string;
  user_id?: string;
  userId?: string;
  project?: string;
}

/**
 * Typed raw extraction-response fixture accepted by the ingestion fixture LLM.
 */
export interface ClaimKeyScenarioExtractionFixtureResponse {
  entries: ClaimKeyScenarioExtractionFixtureEntry[];
}

/**
 * Typed claim-extraction fixture response accepted by deterministic scenario LLMs.
 */
export interface ClaimKeyScenarioClaimExtractionFixtureResponse {
  entity?: string;
  attribute?: string;
  confidence?: number;
  no_claim?: boolean;
  __error?: string;
}

const CLAIM_EXTRACTION_FIXTURE_KEYS = new Set(["entity", "attribute", "confidence", "no_claim", "__error"]);
const EXTRACTION_RESPONSE_KEYS = new Set(["durables"]);
const EXTRACTION_ENTRY_KEYS = new Set([
  "type",
  "subject",
  "content",
  "importance",
  "expiry",
  "tags",
  "source_file",
  "sourceFile",
  "source_context",
  "sourceContext",
  "claim_key",
  "claimKey",
  "user_id",
  "userId",
  "project",
]);

/**
 * Loads one seed-entry fixture file and validates it into canonical seed entries.
 *
 * @param rootDir - Scenario root used for path resolution.
 * @param relativePath - Root-relative seed fixture path.
 * @returns Validated seed entries, or null when no file was declared.
 */
export async function loadSeedFixtureEntries(rootDir: string, relativePath: string | undefined): Promise<ClaimKeyScenarioSeedEntry[] | null> {
  if (!relativePath) {
    return null;
  }

  const parsed = await readJsonFile(path.join(rootDir, relativePath));
  const seedEntries = readSeedEntries(parsed, relativePath);
  if (!seedEntries) {
    throw new Error(`Seed fixture ${relativePath} must contain an array.`);
  }

  return seedEntries;
}

/**
 * Loads one extraction-response fixture file and validates each response item.
 *
 * @param rootDir - Scenario root used for path resolution.
 * @param relativePath - Root-relative extraction fixture path.
 * @returns Typed raw extraction responses, or null when no file was declared.
 */
export async function loadExtractionFixtureResponses(
  rootDir: string,
  relativePath: string | undefined,
): Promise<ClaimKeyScenarioExtractionFixtureResponse[] | null> {
  const parsed = await readArrayFixture(rootDir, relativePath);
  if (!parsed) {
    return null;
  }

  return parsed.map((item, index) => readExtractionFixtureResponse(item, `${relativePath}[${index}]`));
}

/**
 * Loads one claim-extraction fixture file and validates each response item.
 *
 * @param rootDir - Scenario root used for path resolution.
 * @param relativePath - Root-relative claim-extraction fixture path.
 * @returns Typed claim-extraction responses, or null when no file was declared.
 */
export async function loadClaimExtractionFixtureResponses(
  rootDir: string,
  relativePath: string | undefined,
): Promise<ClaimKeyScenarioClaimExtractionFixtureResponse[] | null> {
  const parsed = await readArrayFixture(rootDir, relativePath);
  if (!parsed) {
    return null;
  }

  return parsed.map((item, index) => readClaimExtractionFixtureResponse(item, `${relativePath}[${index}]`));
}

/**
 * Reads one claim-extraction fixture response item.
 *
 * @param value - Raw fixture response.
 * @param label - Human-readable validation label.
 * @returns Typed claim-extraction fixture response.
 */
function readClaimExtractionFixtureResponse(value: unknown, label: string): ClaimKeyScenarioClaimExtractionFixtureResponse {
  const record = readObject(value, "Fixture response", label, CLAIM_EXTRACTION_FIXTURE_KEYS);
  const noClaim = readOptionalBoolean(record.no_claim, `${label}.no_claim`, label);
  const error = readOptionalString(record.__error, `${label}.__error`, label);
  if (error) {
    return { __error: error };
  }

  const entity = readOptionalClaimExtractionString(record.entity, `${label}.entity`, label, noClaim === true);
  const attribute = readOptionalClaimExtractionString(record.attribute, `${label}.attribute`, label, noClaim === true);
  const confidence = record.confidence === undefined ? undefined : readRequiredNumber(record.confidence, `${label}.confidence`, label);

  if (noClaim !== true && (entity === undefined || attribute === undefined || confidence === undefined)) {
    throw new Error(
      `Invalid scenario ${label}: claim-extraction fixtures must declare entity, attribute, and confidence unless no_claim=true or __error is set.`,
    );
  }

  return {
    ...(entity ? { entity } : {}),
    ...(attribute ? { attribute } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(noClaim !== undefined ? { no_claim: noClaim } : {}),
  };
}

/**
 * Reads one optional string field from a claim-extraction fixture response.
 *
 * @param value - Raw field value.
 * @param label - Human-readable field label.
 * @param filePath - Source fixture label used in error messages.
 * @param allowEmpty - Whether blank strings should collapse to undefined.
 * @returns Trimmed string when present.
 */
function readOptionalClaimExtractionString(value: unknown, label: string, filePath: string, allowEmpty: boolean): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`Invalid scenario ${filePath}: ${label} must be a non-empty string.`);
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    if (allowEmpty) {
      return undefined;
    }

    throw new Error(`Invalid scenario ${filePath}: ${label} must be a non-empty string.`);
  }

  return normalized;
}

/**
 * Loads one JSON-array fixture file when declared.
 *
 * @param rootDir - Scenario root used for path resolution.
 * @param relativePath - Root-relative fixture path.
 * @returns Parsed array fixture, or null when absent.
 */
async function readArrayFixture(rootDir: string, relativePath: string | undefined): Promise<unknown[] | null> {
  if (!relativePath) {
    return null;
  }

  const parsed = await readJsonFile(path.join(rootDir, relativePath));
  if (!Array.isArray(parsed)) {
    throw new Error(`Fixture file ${relativePath} must contain a JSON array.`);
  }

  return parsed;
}

/**
 * Reads and parses one JSON fixture file.
 *
 * @param filePath - Absolute fixture file path.
 * @returns Parsed JSON value.
 */
async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid fixture file ${filePath}: JSON parse failed - ${message}`, {
      cause: error,
    });
  }
}

/**
 * Reads one raw extraction-response fixture item.
 *
 * @param value - Raw fixture response.
 * @param label - Human-readable validation label.
 * @returns Typed raw extraction fixture response.
 */
function readExtractionFixtureResponse(value: unknown, label: string): ClaimKeyScenarioExtractionFixtureResponse {
  const record = readObject(value, "Fixture response", label, EXTRACTION_RESPONSE_KEYS);
  if (!Array.isArray(record.durables)) {
    throw new Error(`Invalid scenario ${label}: durables must be an array.`);
  }

  return {
    entries: record.durables.map((entry, index) => readExtractionFixtureEntry(entry, `${label}.durables[${index}]`)),
  };
}

/**
 * Reads one raw extraction-entry fixture item.
 *
 * @param value - Raw extraction entry.
 * @param label - Human-readable validation label.
 * @returns Typed raw extraction fixture entry.
 */
function readExtractionFixtureEntry(value: unknown, label: string): ClaimKeyScenarioExtractionFixtureEntry {
  const record = readObject(value, "Fixture entry", label, EXTRACTION_ENTRY_KEYS);

  return {
    ...(record.type !== undefined ? { type: readOptionalString(record.type, `${label}.type`, label) } : {}),
    ...(record.subject !== undefined ? { subject: readOptionalString(record.subject, `${label}.subject`, label) } : {}),
    ...(record.content !== undefined ? { content: readOptionalString(record.content, `${label}.content`, label) } : {}),
    ...(record.importance !== undefined ? { importance: readExtractionImportance(record.importance, `${label}.importance`, label) } : {}),
    ...(record.expiry !== undefined ? { expiry: readOptionalString(record.expiry, `${label}.expiry`, label) } : {}),
    ...(record.tags !== undefined ? { tags: readRequiredStringArray(record.tags, `${label}.tags`, label) } : {}),
    ...(record.source_file !== undefined ? { source_file: readOptionalString(record.source_file, `${label}.source_file`, label) } : {}),
    ...(record.sourceFile !== undefined ? { sourceFile: readOptionalString(record.sourceFile, `${label}.sourceFile`, label) } : {}),
    ...(record.source_context !== undefined ? { source_context: readOptionalString(record.source_context, `${label}.source_context`, label) } : {}),
    ...(record.sourceContext !== undefined ? { sourceContext: readOptionalString(record.sourceContext, `${label}.sourceContext`, label) } : {}),
    ...(record.claim_key !== undefined ? { claim_key: readOptionalString(record.claim_key, `${label}.claim_key`, label) } : {}),
    ...(record.claimKey !== undefined ? { claimKey: readOptionalString(record.claimKey, `${label}.claimKey`, label) } : {}),
    ...(record.user_id !== undefined ? { user_id: readOptionalString(record.user_id, `${label}.user_id`, label) } : {}),
    ...(record.userId !== undefined ? { userId: readOptionalString(record.userId, `${label}.userId`, label) } : {}),
    ...(record.project !== undefined ? { project: readOptionalString(record.project, `${label}.project`, label) } : {}),
  };
}

/**
 * Reads one raw extraction importance value while preserving number-or-string fixtures.
 *
 * @param value - Raw importance field.
 * @param label - Human-readable field label.
 * @param filePath - Source fixture label used in error messages.
 * @returns Numeric or string importance value.
 */
function readExtractionImportance(value: unknown, label: string, filePath: string): number | string {
  if (typeof value === "number") {
    return readRequiredNumber(value, label, filePath);
  }

  return readRequiredString(value, label, filePath);
}
