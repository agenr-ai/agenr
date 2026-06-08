import type { WebProposalBacklogQuery } from "../../../app/web/proposal-service.js";
import type { RegisterInstanceInput } from "../../../app/web/instance-registry.js";
import { DREAM_TIERS, type DreamTier } from "../../../core/dreaming/types.js";
import {
  DURABLE_KINDS,
  EPISODE_ACTIVITY_LEVELS,
  EXPIRY_LEVELS,
  type DurableKind,
  type EpisodeActivityLevel,
  type Expiry,
  type StoreDurableInput,
} from "../../../core/types.js";
import {
  isRecord,
  parseOptionalTrimmedString,
  parseRequiredTrimmedString,
  pushIssue,
  pushUnexpectedFields,
  type ValidationIssue,
} from "../../shared/validation.js";
import {
  WEB_DURABLE_SORT_FIELDS,
  type WebDurableListQuery,
  type WebDurableSortField,
  type WebDurableStateFilter,
} from "../../db/web-durable-queries.js";
import { WebApiError } from "../api-error.js";

/** Lifecycle states accepted by the durable browser query. */
const DURABLE_STATES: readonly WebDurableStateFilter[] = ["active", "stale", "superseded", "all"];

/** Sort directions accepted by list queries. */
const SORT_DIRECTIONS = ["asc", "desc"] as const;

/** Proposal review decisions accepted by the review endpoint. */
const REVIEW_DECISIONS = ["apply", "reject"] as const;

/** Allowed body keys for a store-durable request. */
const STORE_DURABLE_KEYS = new Set<string>([
  "type",
  "subject",
  "content",
  "importance",
  "expiry",
  "tags",
  "project",
  "claimKey",
  "validFrom",
  "validTo",
]);

/** Allowed body keys for a metadata-update request. */
const UPDATE_METADATA_KEYS = new Set<string>(["importance", "expiry", "claimKey", "validFrom", "validTo", "project"]);

/** Allowed body keys for an episode metadata-update request. */
const UPDATE_EPISODE_METADATA_KEYS = new Set<string>(["sourceRef", "surface", "userId", "project", "activityLevel", "tags", "validFrom", "validTo"]);

/** Allowed body keys for a dreaming-start request. */
const DREAM_START_KEYS = new Set<string>(["tier", "apply", "project"]);

/** Allowed body keys for a procedure-validate request. */
const PROCEDURE_VALIDATE_KEYS = new Set<string>(["content", "relativePath"]);

/**
 * Validated body for storing a new durable from the console.
 */
export interface ParsedStoreDurableBody {
  /** Normalized store input forwarded to the shared pipeline. */
  durable: StoreDurableInput;
}

/**
 * Validated metadata-update fields for an existing durable.
 */
export interface ParsedUpdateMetadataBody {
  /** Updated importance, when provided. */
  importance?: number;
  /** Updated expiry tier, when provided. */
  expiry?: Expiry;
  /** Updated canonical claim key, when provided. */
  claimKey?: string;
  /** Updated valid-from timestamp, when provided. */
  validFrom?: string;
  /** Updated valid-to timestamp, when provided. */
  validTo?: string;
  /** Updated project scope, when provided. */
  project?: string;
}

/**
 * Validated metadata-update fields for an existing episode.
 */
export interface ParsedUpdateEpisodeMetadataBody {
  /** Updated source reference, when provided. Empty clears it. */
  sourceRef?: string;
  /** Updated host surface, when provided. Empty clears it. */
  surface?: string;
  /** Updated user id, when provided. Empty clears it. */
  userId?: string;
  /** Updated project scope, when provided. Empty clears it. */
  project?: string;
  /** Updated activity level, when provided. */
  activityLevel?: EpisodeActivityLevel | "";
  /** Updated tag list, when provided. Empty clears tags. */
  tags?: string[];
  /** Updated valid-from timestamp, when provided. Empty clears it. */
  validFrom?: string;
  /** Updated valid-to timestamp, when provided. Empty clears it. */
  validTo?: string;
}

/**
 * Validated proposal-review decision.
 */
export interface ParsedReviewBody {
  /** Apply or reject decision. */
  decision: (typeof REVIEW_DECISIONS)[number];
  /** Non-empty operator-provided reason. */
  reason: string;
}

/**
 * Validated dreaming-run start request.
 */
export interface ParsedDreamStartBody {
  /** Run tier. */
  tier: DreamTier;
  /** Whether the run applies changes. */
  apply: boolean;
  /** Optional project scope. */
  project?: string;
}

/**
 * Validated procedure-save request.
 */
export interface ParsedProcedureSaveBody {
  /** Procedures-directory-relative file path. */
  relativePath: string;
  /** Raw YAML document content. */
  content: string;
}

/**
 * Parses a durable browser query from URL search parameters.
 *
 * @param params - Request URL search parameters.
 * @returns Structured durable list query.
 * @throws {WebApiError} 400 when any parameter is malformed.
 */
export function parseDurableListQuery(params: URLSearchParams): WebDurableListQuery {
  const issues: ValidationIssue[] = [];

  const state = readEnumParam<WebDurableStateFilter>(params, "state", DURABLE_STATES, issues);
  const sort = readEnumParam<WebDurableSortField>(params, "sort", WEB_DURABLE_SORT_FIELDS, issues);
  const direction = readEnumParam(params, "direction", SORT_DIRECTIONS, issues);
  const types = readDurableKindListParam(params, "types", issues);
  const expiry = readEnumParam<Expiry>(params, "expiry", EXPIRY_LEVELS, issues);

  const query: WebDurableListQuery = {
    ...readStringParam(params, "text", (value) => ({ text: value })),
    ...(types.length > 0 ? { types } : {}),
    ...arrayOrEmpty("tags", readStringArrayParam(params, "tags")),
    ...readStringParam(params, "project", (value) => ({ project: value })),
    ...(state ? { state } : {}),
    ...readStringParam(params, "claimKey", (value) => ({ claimKey: value })),
    ...readStringParam(params, "claimKeyPrefix", (value) => ({ claimKeyPrefix: value })),
    ...readStringParam(params, "source", (value) => ({ source: value })),
    ...readNumberParam(params, "minImportance", issues, (value) => ({ minImportance: value })),
    ...readNumberParam(params, "maxImportance", issues, (value) => ({ maxImportance: value })),
    ...(expiry ? { expiry } : {}),
    ...readStringParam(params, "createdSince", (value) => ({ createdSince: value })),
    ...readStringParam(params, "createdUntil", (value) => ({ createdUntil: value })),
    ...(sort ? { sort } : {}),
    ...(direction ? { direction } : {}),
    ...readIntParam(params, "limit", issues, (value) => ({ limit: value })),
    ...readIntParam(params, "offset", issues, (value) => ({ offset: value })),
  };

  throwIfIssues(issues);
  return query;
}

/**
 * Parses the recent-episodes list query from URL search parameters.
 *
 * @param params - Request URL search parameters.
 * @returns Project filter plus pagination.
 * @throws {WebApiError} 400 when pagination parameters are malformed.
 */
export function parseEpisodeListQuery(params: URLSearchParams): { project?: string; limit?: number; offset?: number } {
  const issues: ValidationIssue[] = [];
  const query = {
    ...readStringParam(params, "project", (value) => ({ project: value })),
    ...readIntParam(params, "limit", issues, (value) => ({ limit: value })),
    ...readIntParam(params, "offset", issues, (value) => ({ offset: value })),
  };
  throwIfIssues(issues);
  return query;
}

/**
 * Parses the proposal backlog query from URL search parameters.
 *
 * @param params - Request URL search parameters.
 * @returns Structured backlog query.
 * @throws {WebApiError} 400 when any parameter is malformed.
 */
export function parseProposalBacklogQuery(params: URLSearchParams): WebProposalBacklogQuery {
  const issues: ValidationIssue[] = [];
  const includeIneligible = params.get("includeIneligible");
  const query: WebProposalBacklogQuery = {
    state: "open",
    ...readIntParam(params, "limit", issues, (value) => ({ limit: value })),
    ...readNumberParam(params, "minConfidence", issues, (value) => ({ minConfidence: value })),
    ...readStringParam(params, "createdSince", (value) => ({ createdSince: value })),
    ...(includeIneligible === "true" ? {} : { eligibleOnly: true }),
  };
  throwIfIssues(issues);
  return query;
}

/**
 * Parses and validates a store-durable request body.
 *
 * @param input - Raw JSON request body.
 * @returns Validated store input.
 * @throws {WebApiError} 400 when the body is malformed.
 */
export function parseStoreDurableBody(input: unknown): ParsedStoreDurableBody {
  const { record, issues } = requireObject(input, STORE_DURABLE_KEYS);
  const durable = parseDurableCore(record, issues);
  throwIfIssues(issues);
  return { durable };
}

/**
 * Parses and validates a metadata-update request body.
 *
 * @param input - Raw JSON request body.
 * @returns Validated metadata fields.
 * @throws {WebApiError} 400 when the body is malformed or empty.
 */
export function parseUpdateMetadataBody(input: unknown): ParsedUpdateMetadataBody {
  const { record, issues } = requireObject(input, UPDATE_METADATA_KEYS);

  const fields: ParsedUpdateMetadataBody = {
    ...readNumberField(record, "importance", issues, (value) => ({ importance: value })),
    ...readEnumField<Expiry>(record, "expiry", EXPIRY_LEVELS, issues, (value) => ({ expiry: value })),
    ...readStringField(record, "claimKey", issues, (value) => ({ claimKey: value })),
    ...readStringFieldPreserveEmpty(record, "validFrom", issues, (value) => ({ validFrom: value })),
    ...readStringFieldPreserveEmpty(record, "validTo", issues, (value) => ({ validTo: value })),
    ...readStringFieldPreserveEmpty(record, "project", issues, (value) => ({ project: value })),
  };

  if (Object.keys(fields).length === 0) {
    pushIssue(issues, "$", "Provide at least one metadata field to update.");
  }

  throwIfIssues(issues);
  return fields;
}

/**
 * Parses and validates an episode metadata-update request body.
 *
 * @param input - Raw JSON request body.
 * @returns Validated metadata fields.
 * @throws {WebApiError} 400 when the body is malformed or empty.
 */
export function parseUpdateEpisodeMetadataBody(input: unknown): ParsedUpdateEpisodeMetadataBody {
  const { record, issues } = requireObject(input, UPDATE_EPISODE_METADATA_KEYS);

  const fields: ParsedUpdateEpisodeMetadataBody = {
    ...readStringFieldPreserveEmpty(record, "sourceRef", issues, (value) => ({ sourceRef: value })),
    ...readStringFieldPreserveEmpty(record, "surface", issues, (value) => ({ surface: value })),
    ...readStringFieldPreserveEmpty(record, "userId", issues, (value) => ({ userId: value })),
    ...readStringFieldPreserveEmpty(record, "project", issues, (value) => ({ project: value })),
    ...readEpisodeActivityLevelField(record, "activityLevel", issues),
    ...readStringArrayFieldPreserveEmpty(record, "tags", issues, (value) => ({ tags: value })),
    ...readStringFieldPreserveEmpty(record, "validFrom", issues, (value) => ({ validFrom: value })),
    ...readStringFieldPreserveEmpty(record, "validTo", issues, (value) => ({ validTo: value })),
  };

  if (Object.keys(fields).length === 0) {
    pushIssue(issues, "$", "Provide at least one episode metadata field to update.");
  }

  throwIfIssues(issues);
  return fields;
}

/**
 * Parses an optional close-validity request body for a reason.
 *
 * @param input - Raw JSON request body, possibly empty.
 * @returns Optional trimmed reason.
 * @throws {WebApiError} 400 when the reason field is the wrong type.
 */
export function parseCloseValidityBody(input: unknown): { reason?: string } {
  if (input === undefined || input === null) {
    return {};
  }

  const { record, issues } = requireObject(input, new Set(["reason"]));
  const reason = parseOptionalTrimmedString(record.reason, "reason", issues);
  throwIfIssues(issues);
  return reason ? { reason } : {};
}

/**
 * Parses and validates a proposal-review request body.
 *
 * @param input - Raw JSON request body.
 * @returns Validated decision and reason.
 * @throws {WebApiError} 400 when the body is malformed.
 */
export function parseReviewBody(input: unknown): ParsedReviewBody {
  const { record, issues } = requireObject(input, new Set(["decision", "reason"]));
  const decision = readEnumValue(record.decision, "decision", REVIEW_DECISIONS, issues);
  const reason = parseRequiredTrimmedString(record.reason, "reason", issues) ?? "";
  throwIfIssues(issues);
  if (!decision) {
    throw WebApiError.invalid([{ path: "decision", message: `Expected one of: ${REVIEW_DECISIONS.join(", ")}.` }]);
  }

  return { decision, reason };
}

/**
 * Parses and validates a dreaming-run start request body.
 *
 * @param input - Raw JSON request body.
 * @returns Validated start parameters.
 * @throws {WebApiError} 400 when the body is malformed.
 */
export function parseDreamStartBody(input: unknown): ParsedDreamStartBody {
  const { record, issues } = requireObject(input, DREAM_START_KEYS);
  const tier = readEnumValue<DreamTier>(record.tier, "tier", DREAM_TIERS, issues) ?? "light";
  const apply = record.apply === undefined ? false : readBoolean(record.apply, "apply", issues);
  const project = parseOptionalTrimmedString(record.project, "project", issues);
  throwIfIssues(issues);
  return { tier, apply, ...(project ? { project } : {}) };
}

/**
 * Validated procedure-validate request.
 */
export interface ParsedProcedureValidateBody {
  /** Raw YAML document content. */
  content: string;
  /** Procedures-directory-relative file path used in validation messages. */
  relativePath: string;
}

/**
 * Parses and validates a procedure-validate request body.
 *
 * @param input - Raw JSON request body.
 * @returns Validated YAML content and relative path label.
 * @throws {WebApiError} 400 when the body is malformed.
 */
export function parseProcedureValidateBody(input: unknown): ParsedProcedureValidateBody {
  const { record, issues } = requireObject(input, PROCEDURE_VALIDATE_KEYS);
  const content = typeof record.content === "string" ? record.content : "";
  if (typeof record.content !== "string") {
    pushIssue(issues, "content", "Expected a string.");
  }

  const relativePath = parseOptionalTrimmedString(record.relativePath, "relativePath", issues) ?? "procedure.yaml";
  throwIfIssues(issues);
  return { content, relativePath };
}

/**
 * Parses and validates a procedure-save request body.
 *
 * @param input - Raw JSON request body.
 * @returns Validated relative path and content.
 * @throws {WebApiError} 400 when the body is malformed.
 */
export function parseProcedureSaveBody(input: unknown): ParsedProcedureSaveBody {
  const { record, issues } = requireObject(input, new Set(["relativePath", "content"]));
  const relativePath = parseRequiredTrimmedString(record.relativePath, "relativePath", issues) ?? "";
  const content = typeof record.content === "string" ? record.content : "";
  if (typeof record.content !== "string") {
    pushIssue(issues, "content", "Expected a string.");
  }
  throwIfIssues(issues);
  return { relativePath, content };
}

/**
 * Parses and validates an instance-registration request body.
 *
 * @param input - Raw JSON request body.
 * @returns Validated instance registration input.
 * @throws {WebApiError} 400 when the body is malformed.
 */
export function parseRegisterInstanceBody(input: unknown): RegisterInstanceInput {
  const { record, issues } = requireObject(input, new Set(["name", "configPath", "dbPath", "proceduresDir"]));
  const name = parseRequiredTrimmedString(record.name, "name", issues) ?? "";
  const configPath = parseOptionalTrimmedString(record.configPath, "configPath", issues);
  const dbPath = parseOptionalTrimmedString(record.dbPath, "dbPath", issues);
  const proceduresDir = parseOptionalTrimmedString(record.proceduresDir, "proceduresDir", issues);
  throwIfIssues(issues);
  return {
    name,
    ...(configPath ? { configPath } : {}),
    ...(dbPath ? { dbPath } : {}),
    ...(proceduresDir ? { proceduresDir } : {}),
  };
}

/** Parses the shared durable content fields used by store and supersede. */
function parseDurableCore(record: Record<string, unknown>, issues: ValidationIssue[]): StoreDurableInput {
  const type = readEnumValue<DurableKind>(record.type, "type", DURABLE_KINDS, issues) ?? "fact";
  const subject = parseRequiredTrimmedString(record.subject, "subject", issues) ?? "";
  const content = parseRequiredTrimmedString(record.content, "content", issues) ?? "";

  return {
    type,
    subject,
    content,
    ...readNumberField(record, "importance", issues, (value) => ({ importance: value })),
    ...readEnumField<Expiry>(record, "expiry", EXPIRY_LEVELS, issues, (value) => ({ expiry: value })),
    ...readStringArrayField(record, "tags", issues),
    ...readStringField(record, "project", issues, (value) => ({ project: value })),
    ...readStringField(record, "claimKey", issues, (value) => ({ claim_key: value })),
    ...readStringField(record, "validFrom", issues, (value) => ({ valid_from: value })),
    ...readStringField(record, "validTo", issues, (value) => ({ valid_to: value })),
  };
}

/** Requires the input be an object and reports unexpected fields. */
function requireObject(input: unknown, allowedKeys: ReadonlySet<string>): { record: Record<string, unknown>; issues: ValidationIssue[] } {
  if (!isRecord(input)) {
    throw WebApiError.invalid([{ path: "$", message: "Request body must be a JSON object." }]);
  }

  const issues: ValidationIssue[] = [];
  pushUnexpectedFields(input, allowedKeys, "", issues);
  return { record: input, issues };
}

/** Throws a 400 validation error when any issues were collected. */
function throwIfIssues(issues: ValidationIssue[]): void {
  if (issues.length > 0) {
    throw WebApiError.invalid(issues);
  }
}

/** Returns true when a value is one of the supported durable kinds. */
function isDurableKind(value: string): value is DurableKind {
  return (DURABLE_KINDS as readonly string[]).includes(value);
}

/** Reads a trimmed query-string value, applying a builder when present. */
function readStringParam<T>(params: URLSearchParams, key: string, build: (value: string) => T): T | Record<never, never> {
  const raw = params.get(key)?.trim();
  return raw && raw.length > 0 ? build(raw) : {};
}

/** Reads a durable-kind list query parameter, reporting unsupported values. */
function readDurableKindListParam(params: URLSearchParams, key: string, issues: ValidationIssue[]): DurableKind[] {
  const values = readStringArrayParam(params, key);
  const types: DurableKind[] = [];
  for (const value of values) {
    if (isDurableKind(value)) {
      types.push(value);
      continue;
    }

    pushIssue(issues, key, `Unsupported durable kind: ${value}.`);
  }

  return types;
}

/** Reads a comma-separated or repeated query parameter into a string array. */
function readStringArrayParam(params: URLSearchParams, key: string): string[] {
  const values = params.getAll(key).flatMap((entry) => entry.split(","));
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

/** Wraps a non-empty array under a key, or yields an empty object. */
function arrayOrEmpty<K extends string>(key: K, values: string[]): Record<K, string[]> | Record<never, never> {
  return values.length > 0 ? ({ [key]: values } as Record<K, string[]>) : {};
}

/** Reads an integer query parameter, reporting malformed values. */
function readIntParam<T>(params: URLSearchParams, key: string, issues: ValidationIssue[], build: (value: number) => T): T | Record<never, never> {
  const raw = params.get(key)?.trim();
  if (!raw || raw.length === 0) {
    return {};
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    pushIssue(issues, key, "Expected an integer.");
    return {};
  }

  return build(parsed);
}

/** Reads a finite-number query parameter, reporting malformed values. */
function readNumberParam<T>(params: URLSearchParams, key: string, issues: ValidationIssue[], build: (value: number) => T): T | Record<never, never> {
  const raw = params.get(key)?.trim();
  if (!raw || raw.length === 0) {
    return {};
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    pushIssue(issues, key, "Expected a number.");
    return {};
  }

  return build(parsed);
}

/** Reads an enum query parameter, reporting unsupported values. */
function readEnumParam<T extends string>(params: URLSearchParams, key: string, allowed: readonly T[], issues: ValidationIssue[]): T | undefined {
  const raw = params.get(key)?.trim();
  if (!raw || raw.length === 0) {
    return undefined;
  }

  if (!(allowed as readonly string[]).includes(raw)) {
    pushIssue(issues, key, `Expected one of: ${allowed.join(", ")}.`);
    return undefined;
  }

  return raw as T;
}

/** Reads a finite-number body field, reporting malformed values. */
function readNumberField<T>(record: Record<string, unknown>, key: string, issues: ValidationIssue[], build: (value: number) => T): T | Record<never, never> {
  const value = record[key];
  if (value === undefined) {
    return {};
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    pushIssue(issues, key, "Expected a finite number.");
    return {};
  }

  return build(value);
}

/** Reads a trimmed string body field, reporting malformed values. */
function readStringField<T>(record: Record<string, unknown>, key: string, issues: ValidationIssue[], build: (value: string) => T): T | Record<never, never> {
  const value = record[key];
  if (value === undefined) {
    return {};
  }

  if (typeof value !== "string") {
    pushIssue(issues, key, "Expected a string.");
    return {};
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? build(trimmed) : {};
}

/** Reads a string body field, preserving empty strings for clear operations. */
function readStringFieldPreserveEmpty<T>(
  record: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[],
  build: (value: string) => T,
): T | Record<never, never> {
  const value = record[key];
  if (value === undefined) {
    return {};
  }

  if (typeof value !== "string") {
    pushIssue(issues, key, "Expected a string.");
    return {};
  }

  return build(value.trim());
}

/** Reads a string-array body field, reporting malformed values. */
function readStringArrayField(record: Record<string, unknown>, key: string, issues: ValidationIssue[]): { tags: string[] } | Record<never, never> {
  const value = record[key];
  if (value === undefined) {
    return {};
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    pushIssue(issues, key, "Expected an array of strings.");
    return {};
  }

  const tags = value.map((entry) => (entry as string).trim()).filter((entry) => entry.length > 0);
  return tags.length > 0 ? { tags } : {};
}

/** Reads a string-array body field, preserving empty arrays for clear operations. */
function readStringArrayFieldPreserveEmpty<T>(
  record: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[],
  build: (value: string[]) => T,
): T | Record<never, never> {
  const value = record[key];
  if (value === undefined) {
    return {};
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    pushIssue(issues, key, "Expected an array of strings.");
    return {};
  }

  return build(value.map((entry) => (entry as string).trim()).filter((entry) => entry.length > 0));
}

/** Reads an enum body field, reporting unsupported values. */
function readEnumField<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  issues: ValidationIssue[],
  build: (value: T) => Record<string, T>,
): Record<string, T> | Record<never, never> {
  const value = record[key];
  if (value === undefined) {
    return {};
  }

  const parsed = readEnumValue(value, key, allowed, issues);
  return parsed ? build(parsed) : {};
}

/** Reads an episode activity body field, preserving an empty string to clear it. */
function readEpisodeActivityLevelField(
  record: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[],
): { activityLevel: EpisodeActivityLevel | "" } | Record<never, never> {
  const value = record[key];
  if (value === undefined) {
    return {};
  }

  if (typeof value === "string" && value.trim().length === 0) {
    return { activityLevel: "" };
  }

  const parsed = readEnumValue(value, key, EPISODE_ACTIVITY_LEVELS, issues);
  return parsed ? { activityLevel: parsed } : {};
}

/** Validates a single enum value, reporting unsupported or wrong-typed input. */
function readEnumValue<T extends string>(value: unknown, key: string, allowed: readonly T[], issues: ValidationIssue[]): T | undefined {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    pushIssue(issues, key, `Expected one of: ${allowed.join(", ")}.`);
    return undefined;
  }

  return value as T;
}

/** Validates a boolean body field. */
function readBoolean(value: unknown, key: string, issues: ValidationIssue[]): boolean {
  if (typeof value !== "boolean") {
    pushIssue(issues, key, "Expected a boolean.");
    return false;
  }

  return value;
}
