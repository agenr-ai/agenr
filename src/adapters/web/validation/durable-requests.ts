import {
  DURABLE_KINDS,
  EPISODE_ACTIVITY_LEVELS,
  EXPIRY_LEVELS,
  type DurableKind,
  type EpisodeActivityLevel,
  type Expiry,
  type StoreDurableInput,
} from "../../../core/types.js";
import type { ValidationIssue } from "../../shared/validation.js";
import {
  WEB_DURABLE_SORT_FIELDS,
  type WebDurableListQuery,
  type WebDurableSortField,
  type WebDurableStateFilter,
} from "../../db/web-durable-queries.js";
import {
  arrayOrEmpty,
  parseOptionalTrimmedString,
  parseRequiredTrimmedString,
  pushIssue,
  readEnumField,
  readEnumParam,
  readEnumValue,
  readIntParam,
  readNumberField,
  readNumberParam,
  readStringArrayField,
  readStringArrayFieldPreserveEmpty,
  readStringArrayParam,
  readStringField,
  readStringFieldPreserveEmpty,
  readStringParam,
  requireObject,
  throwIfIssues,
} from "./field-parsers.js";

/** Lifecycle states accepted by the durable browser query. */
const DURABLE_STATES: readonly WebDurableStateFilter[] = ["active", "stale", "superseded", "all"];

/** Sort directions accepted by list queries. */
const SORT_DIRECTIONS = ["asc", "desc"] as const;

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
  importance?: number;
  expiry?: Expiry;
  claimKey?: string;
  validFrom?: string;
  validTo?: string;
  project?: string;
}

/**
 * Validated metadata-update fields for an existing episode.
 */
export interface ParsedUpdateEpisodeMetadataBody {
  sourceRef?: string;
  surface?: string;
  userId?: string;
  project?: string;
  activityLevel?: EpisodeActivityLevel | "";
  tags?: string[];
  validFrom?: string;
  validTo?: string;
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

/** Returns true when a value is one of the supported durable kinds. */
function isDurableKind(value: string): value is DurableKind {
  return (DURABLE_KINDS as readonly string[]).includes(value);
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
