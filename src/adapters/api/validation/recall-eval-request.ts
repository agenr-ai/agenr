import { ENTRY_TYPES, EXPIRY_LEVELS } from "../../../core/types.js";
import type {
  RecallEvalCaseOptions,
  RecallEvalCaseRequest,
  RecallEvalFixtureEntry,
  RecallEvalQueryRequest,
  RecallEvalSandboxRequest,
} from "../../../app/evals/recall/index.js";

const ROOT_REQUEST_KEYS = new Set<string>(["caseId", "description", "sandbox", "memoryPool", "recallRequest", "options"]);
const SANDBOX_REQUEST_KEYS = new Set<string>(["root", "preserve"]);
const FIXTURE_ENTRY_KEYS = new Set<string>([
  "id",
  "type",
  "subject",
  "content",
  "importance",
  "expiry",
  "tags",
  "source_file",
  "source_context",
  "created_at",
  "updated_at",
  "retired",
  "retired_at",
  "retired_reason",
  "superseded_by",
]);
const RECALL_REQUEST_KEYS = new Set<string>(["text", "limit", "threshold", "budget", "types", "tags", "since", "until", "around", "aroundRadius"]);
const OPTIONS_KEYS = new Set<string>(["includeDiagnostics", "includeCandidates", "includeTimings"]);

/**
 * Structured request validation issue emitted at the HTTP boundary.
 */
export interface RecallEvalValidationIssue {
  /** Dot-path pointing to the invalid request field. */
  path: string;
  /** Human-readable explanation of the validation failure. */
  message: string;
}

/**
 * Error thrown when a recall eval HTTP request fails boundary validation.
 */
export class RecallEvalRequestValidationError extends Error {
  /** Parseable case identifier echoed for invalid request correlation when available. */
  public readonly caseId?: string;
  /** Structured list of request validation issues. */
  public readonly issues: RecallEvalValidationIssue[];

  /**
   * Creates a request validation error with stable issue details.
   *
   * @param issues - Structured validation issues collected during parsing.
   * @param caseId - Parseable request case identifier when available.
   */
  public constructor(issues: RecallEvalValidationIssue[], caseId?: string) {
    super("Invalid recall eval request.");
    this.name = "RecallEvalRequestValidationError";
    this.issues = issues;
    this.caseId = caseId;
  }
}

/**
 * Validates and normalizes a raw recall eval case request payload.
 *
 * @param input - Raw parsed JSON body from the HTTP adapter.
 * @returns Normalized typed recall eval request for the app layer.
 * @throws RecallEvalRequestValidationError When the payload is invalid.
 */
export function parseRecallEvalCaseRequest(input: unknown): RecallEvalCaseRequest {
  const caseId = extractParseableCaseId(input);

  if (!isRecord(input)) {
    throw new RecallEvalRequestValidationError(
      [
        {
          path: "$",
          message: "Request body must be a JSON object.",
        },
      ],
      caseId,
    );
  }

  const issues: RecallEvalValidationIssue[] = [];
  pushUnexpectedFields(input, ROOT_REQUEST_KEYS, "", issues);
  const parsedCaseId = parseRequiredString(input.caseId, "caseId", issues);
  const description = parseOptionalString(input.description, "description", issues);
  const sandbox = parseSandbox(input.sandbox, issues);
  const memoryPool = parseMemoryPool(input.memoryPool, issues);
  const recallRequest = parseRecallRequest(input.recallRequest, issues);
  const options = parseOptions(input.options, issues);

  if (issues.length > 0 || parsedCaseId === undefined || memoryPool === undefined || recallRequest === undefined) {
    throw new RecallEvalRequestValidationError(issues, caseId);
  }

  return {
    caseId: parsedCaseId,
    description,
    sandbox,
    memoryPool,
    recallRequest,
    options,
  };
}

/** Checks whether a value is a plain object record. */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Extracts a confidently parseable case identifier from a raw request envelope. */
const extractParseableCaseId = (value: unknown): string | undefined => {
  if (!isRecord(value) || typeof value.caseId !== "string") {
    return undefined;
  }

  const normalized = value.caseId.trim();
  return normalized.length > 0 ? normalized : undefined;
};

/** Appends a structured validation issue to the collector. */
const pushIssue = (issues: RecallEvalValidationIssue[], path: string, message: string): void => {
  issues.push({ path, message });
};

/** Records any unsupported object keys so the HTTP contract stays narrow. */
const pushUnexpectedFields = (
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  basePath: string,
  issues: RecallEvalValidationIssue[],
): void => {
  for (const key of Object.keys(value)) {
    if (allowedKeys.has(key)) {
      continue;
    }

    pushIssue(issues, basePath.length > 0 ? `${basePath}.${key}` : key, "Unexpected field.");
  }
};

/** Parses a required trimmed string field. */
const parseRequiredString = (value: unknown, path: string, issues: RecallEvalValidationIssue[]): string | undefined => {
  if (typeof value !== "string") {
    pushIssue(issues, path, "Expected a non-empty string.");
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    pushIssue(issues, path, "Expected a non-empty string.");
    return undefined;
  }

  return normalized;
};

/** Parses an optional trimmed string field. */
const parseOptionalString = (value: unknown, path: string, issues: RecallEvalValidationIssue[]): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    pushIssue(issues, path, "Expected a string.");
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    pushIssue(issues, path, "Expected a non-empty string.");
    return undefined;
  }

  return normalized;
};

/** Parses an optional boolean field. */
const parseOptionalBoolean = (value: unknown, path: string, issues: RecallEvalValidationIssue[]): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    pushIssue(issues, path, "Expected a boolean.");
    return undefined;
  }

  return value;
};

/** Parses an optional sandbox request object. */
const parseSandbox = (value: unknown, issues: RecallEvalValidationIssue[]): RecallEvalSandboxRequest | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    pushIssue(issues, "sandbox", "Expected an object.");
    return undefined;
  }

  pushUnexpectedFields(value, SANDBOX_REQUEST_KEYS, "sandbox", issues);

  return {
    root: parseOptionalString(value.root, "sandbox.root", issues),
    preserve: parseOptionalBoolean(value.preserve, "sandbox.preserve", issues),
  };
};

/** Parses the explicit memory fixture array. */
const parseMemoryPool = (value: unknown, issues: RecallEvalValidationIssue[]): RecallEvalFixtureEntry[] | undefined => {
  if (!Array.isArray(value)) {
    pushIssue(issues, "memoryPool", "Expected an array of fixture entries.");
    return undefined;
  }

  return value.flatMap((entry, index) => {
    const parsed = parseFixtureEntry(entry, index, issues);
    return parsed ? [parsed] : [];
  });
};

/** Parses a single explicit memory fixture entry. */
const parseFixtureEntry = (value: unknown, index: number, issues: RecallEvalValidationIssue[]): RecallEvalFixtureEntry | undefined => {
  const basePath = `memoryPool[${index}]`;
  if (!isRecord(value)) {
    pushIssue(issues, basePath, "Expected an object.");
    return undefined;
  }

  pushUnexpectedFields(value, FIXTURE_ENTRY_KEYS, basePath, issues);

  const type = parseEntryType(value.type, `${basePath}.type`, issues);
  const subject = parseRequiredString(value.subject, `${basePath}.subject`, issues);
  const content = parseRequiredString(value.content, `${basePath}.content`, issues);

  if (!type || !subject || !content) {
    return undefined;
  }

  return {
    id: parseOptionalString(value.id, `${basePath}.id`, issues),
    type,
    subject,
    content,
    importance: parseOptionalImportance(value.importance, `${basePath}.importance`, issues),
    expiry: parseOptionalExpiry(value.expiry, `${basePath}.expiry`, issues),
    tags: parseOptionalStringArray(value.tags, `${basePath}.tags`, issues),
    source_file: parseOptionalString(value.source_file, `${basePath}.source_file`, issues),
    source_context: parseOptionalString(value.source_context, `${basePath}.source_context`, issues),
    created_at: parseOptionalTimestamp(value.created_at, `${basePath}.created_at`, issues),
    updated_at: parseOptionalTimestamp(value.updated_at, `${basePath}.updated_at`, issues),
    retired: parseOptionalBoolean(value.retired, `${basePath}.retired`, issues),
    retired_at: parseOptionalTimestamp(value.retired_at, `${basePath}.retired_at`, issues),
    retired_reason: parseOptionalString(value.retired_reason, `${basePath}.retired_reason`, issues),
    superseded_by: parseOptionalString(value.superseded_by, `${basePath}.superseded_by`, issues),
  };
};

/** Parses the recall query request aligned to the core recall input. */
const parseRecallRequest = (value: unknown, issues: RecallEvalValidationIssue[]): RecallEvalQueryRequest | undefined => {
  if (!isRecord(value)) {
    pushIssue(issues, "recallRequest", "Expected an object.");
    return undefined;
  }

  pushUnexpectedFields(value, RECALL_REQUEST_KEYS, "recallRequest", issues);

  const text = parseRequiredString(value.text, "recallRequest.text", issues);
  if (!text) {
    return undefined;
  }

  return {
    text,
    limit: parseOptionalNonNegativeInteger(value.limit, "recallRequest.limit", issues),
    threshold: parseOptionalThreshold(value.threshold, "recallRequest.threshold", issues),
    budget: parseOptionalNonNegativeInteger(value.budget, "recallRequest.budget", issues),
    types: parseOptionalEntryTypeArray(value.types, "recallRequest.types", issues),
    tags: parseOptionalStringArray(value.tags, "recallRequest.tags", issues),
    since: parseOptionalString(value.since, "recallRequest.since", issues),
    until: parseOptionalString(value.until, "recallRequest.until", issues),
    around: parseOptionalString(value.around, "recallRequest.around", issues),
    aroundRadius: parseOptionalPositiveInteger(value.aroundRadius, "recallRequest.aroundRadius", issues),
  };
};

/** Parses optional case-level output controls. */
const parseOptions = (value: unknown, issues: RecallEvalValidationIssue[]): RecallEvalCaseOptions | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    pushIssue(issues, "options", "Expected an object.");
    return undefined;
  }

  pushUnexpectedFields(value, OPTIONS_KEYS, "options", issues);

  return {
    includeDiagnostics: parseOptionalBoolean(value.includeDiagnostics, "options.includeDiagnostics", issues),
    includeCandidates: parseOptionalBoolean(value.includeCandidates, "options.includeCandidates", issues),
    includeTimings: parseOptionalBoolean(value.includeTimings, "options.includeTimings", issues),
  };
};

/** Parses a valid entry type enum member. */
const parseEntryType = (value: unknown, path: string, issues: RecallEvalValidationIssue[]): RecallEvalFixtureEntry["type"] | undefined => {
  if (typeof value !== "string" || !ENTRY_TYPES.includes(value as RecallEvalFixtureEntry["type"])) {
    pushIssue(issues, path, `Expected one of: ${ENTRY_TYPES.join(", ")}.`);
    return undefined;
  }

  return value as RecallEvalFixtureEntry["type"];
};

/** Parses an optional expiry enum member. */
const parseOptionalExpiry = (value: unknown, path: string, issues: RecallEvalValidationIssue[]): RecallEvalFixtureEntry["expiry"] | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !EXPIRY_LEVELS.includes(value as NonNullable<RecallEvalFixtureEntry["expiry"]>)) {
    pushIssue(issues, path, `Expected one of: ${EXPIRY_LEVELS.join(", ")}.`);
    return undefined;
  }

  return value as NonNullable<RecallEvalFixtureEntry["expiry"]>;
};

/** Parses an optional integer importance value in the supported 1-10 range. */
const parseOptionalImportance = (value: unknown, path: string, issues: RecallEvalValidationIssue[]): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10) {
    pushIssue(issues, path, "Expected an integer from 1 to 10.");
    return undefined;
  }

  return value;
};

/** Parses an optional array of non-empty trimmed strings. */
const parseOptionalStringArray = (value: unknown, path: string, issues: RecallEvalValidationIssue[]): string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    pushIssue(issues, path, "Expected an array of strings.");
    return undefined;
  }

  const normalized = value.map((item) => item.trim()).filter((item) => item.length > 0);
  return normalized;
};

/** Parses an optional array of valid entry type enum members. */
const parseOptionalEntryTypeArray = (value: unknown, path: string, issues: RecallEvalValidationIssue[]): RecallEvalQueryRequest["types"] | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    pushIssue(issues, path, "Expected an array.");
    return undefined;
  }

  const parsed: NonNullable<RecallEvalQueryRequest["types"]> = [];
  for (const [index, item] of value.entries()) {
    const entryType = parseEntryType(item, `${path}[${index}]`, issues);
    if (entryType) {
      parsed.push(entryType);
    }
  }

  return parsed;
};

/** Parses an optional non-negative integer field. */
const parseOptionalNonNegativeInteger = (value: unknown, path: string, issues: RecallEvalValidationIssue[]): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    pushIssue(issues, path, "Expected a non-negative integer.");
    return undefined;
  }

  return value;
};

/** Parses an optional positive integer field. */
const parseOptionalPositiveInteger = (value: unknown, path: string, issues: RecallEvalValidationIssue[]): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    pushIssue(issues, path, "Expected a positive integer.");
    return undefined;
  }

  return value;
};

/** Parses an optional recall threshold constrained to the 0-1 range. */
const parseOptionalThreshold = (value: unknown, path: string, issues: RecallEvalValidationIssue[]): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 1) {
    pushIssue(issues, path, "Expected a number from 0 to 1.");
    return undefined;
  }

  return value;
};

/** Parses an optional ISO-like timestamp string. */
const parseOptionalTimestamp = (value: unknown, path: string, issues: RecallEvalValidationIssue[]): string | undefined => {
  const timestamp = parseOptionalString(value, path, issues);
  if (timestamp === undefined) {
    return undefined;
  }

  if (Number.isNaN(Date.parse(timestamp))) {
    pushIssue(issues, path, "Expected a valid timestamp string.");
    return undefined;
  }

  return timestamp;
};
