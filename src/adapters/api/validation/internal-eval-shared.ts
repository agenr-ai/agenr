import type { ClaimKeySource, ClaimKeyStatus, ClaimSupportMode, EntryType, Expiry, ProcedureSource, ProcedureStep } from "../../../core/types.js";
import { CLAIM_KEY_SOURCES, CLAIM_KEY_STATUSES, CLAIM_SUPPORT_MODES, ENTRY_TYPES, EXPIRY_LEVELS } from "../../../core/types.js";
import { normalizeProcedureDefinition } from "../../../core/procedures/normalization.js";
import type { ValidationIssue } from "../../shared/validation.js";
import {
  isRecord,
  parseOptionalBoolean,
  parseOptionalIntegerInRange,
  parseOptionalTimestampString,
  parseOptionalTrimmedString,
  parseRequiredTrimmedString,
  pushIssue,
  pushUnexpectedFields,
} from "../../shared/validation.js";

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
  "claim_key",
  "claim_key_status",
  "claim_key_source",
  "claim_support_source_kind",
  "claim_support_locator",
  "claim_support_observed_at",
  "claim_support_mode",
  "valid_from",
  "valid_to",
  "supersession_kind",
  "supersession_reason",
]);
const FIXTURE_PROCEDURE_KEYS = new Set<string>([
  "id",
  "procedure_key",
  "title",
  "goal",
  "when_to_use",
  "when_not_to_use",
  "prerequisites",
  "steps",
  "verification",
  "failure_modes",
  "sources",
  "source_file",
  "retired",
  "retired_at",
  "retired_reason",
  "superseded_by",
  "created_at",
  "updated_at",
]);

/**
 * Adapter-owned normalized sandbox request DTO shared across internal eval seams.
 */
export interface InternalEvalSandboxRequestDto {
  /** Optional sandbox root path. */
  root?: string;
  /** When true, preserves the sandbox on disk for inspection. */
  preserve?: boolean;
}

/**
 * Adapter-owned normalized fixture entry DTO shared across internal eval seams.
 */
export interface InternalEvalFixtureEntryDto {
  /** Optional stable entry identifier. */
  id?: string;
  /** Durable entry type. */
  type: EntryType;
  /** Fixture subject line. */
  subject: string;
  /** Fixture content body. */
  content: string;
  /** Optional importance override. */
  importance?: number;
  /** Optional expiry override. */
  expiry?: Expiry;
  /** Optional normalized tag list. */
  tags?: string[];
  /** Optional source file path. */
  source_file?: string;
  /** Optional source context text. */
  source_context?: string;
  /** Optional creation timestamp. */
  created_at?: string;
  /** Optional update timestamp. */
  updated_at?: string;
  /** Optional retired state. */
  retired?: boolean;
  /** Optional retirement timestamp. */
  retired_at?: string;
  /** Optional retirement reason. */
  retired_reason?: string;
  /** Optional successor entry identifier. */
  superseded_by?: string;
  /** Optional canonical claim key. */
  claim_key?: string;
  /** Optional claim-key lifecycle status. */
  claim_key_status?: ClaimKeyStatus;
  /** Optional claim-key provenance source. */
  claim_key_source?: ClaimKeySource;
  /** Optional claim support source kind. */
  claim_support_source_kind?: string;
  /** Optional claim support locator. */
  claim_support_locator?: string;
  /** Optional claim support observed-at timestamp. */
  claim_support_observed_at?: string;
  /** Optional claim support normalization mode. */
  claim_support_mode?: ClaimSupportMode;
  /** Optional validity lower bound. */
  valid_from?: string;
  /** Optional validity upper bound. */
  valid_to?: string;
  /** Optional explicit supersession kind. */
  supersession_kind?: string;
  /** Optional explicit supersession rationale. */
  supersession_reason?: string;
}

/**
 * Adapter-owned normalized fixture procedure DTO shared across internal eval seams.
 */
export interface InternalEvalFixtureProcedureDto {
  /** Optional stable procedure identifier. */
  id?: string;
  /** Stable procedure key used for active revision lookup. */
  procedure_key: string;
  /** Human-readable procedure title. */
  title: string;
  /** Short goal statement for the authored procedure. */
  goal: string;
  /** Applicability guidance for when this procedure should be used. */
  when_to_use?: string[];
  /** Applicability guidance for when this procedure should not be used. */
  when_not_to_use?: string[];
  /** Ordered prerequisite checklist. */
  prerequisites?: string[];
  /** Ordered authored procedure steps. */
  steps: ProcedureStep[];
  /** Verification checks for the procedure. */
  verification?: string[];
  /** Expected failure modes for the procedure. */
  failure_modes?: string[];
  /** Explicit authored provenance for the procedure. */
  sources?: ProcedureSource[];
  /** Optional source file path attached to the stored procedure. */
  source_file?: string;
  /** Optional retirement flag for inactive procedure fixtures. */
  retired?: boolean;
  /** Optional retirement timestamp when the fixture is retired. */
  retired_at?: string;
  /** Optional retirement reason attached to the fixture. */
  retired_reason?: string;
  /** Optional successor procedure ID when the fixture is superseded. */
  superseded_by?: string;
  /** Optional creation timestamp for deterministic ordering. */
  created_at?: string;
  /** Optional update timestamp for deterministic ordering. */
  updated_at?: string;
}

/**
 * Extracts a confidently parseable case identifier from a raw request envelope.
 *
 * @param value - Raw request value.
 * @returns Trimmed case identifier when available.
 */
export function extractParseableCaseId(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.caseId !== "string") {
    return undefined;
  }

  const normalized = value.caseId.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Parses one required object field.
 *
 * @param value - Raw field value.
 * @param path - Stable validation path.
 * @param issues - Mutable validation issue collection.
 * @returns Object record when valid.
 */
export function parseObject(value: unknown, path: string, issues: ValidationIssue[]): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return undefined;
  }

  return value;
}

/**
 * Parses an optional sandbox request object.
 *
 * @param value - Raw sandbox field.
 * @param issues - Mutable validation issue collection.
 * @returns Normalized sandbox DTO when valid.
 */
export function parseSandbox(value: unknown, issues: ValidationIssue[]): InternalEvalSandboxRequestDto | undefined {
  if (value === undefined) {
    return undefined;
  }

  const sandbox = parseObject(value, "sandbox", issues);
  if (sandbox === undefined) {
    return undefined;
  }

  pushUnexpectedFields(sandbox, SANDBOX_REQUEST_KEYS, "sandbox", issues);

  return {
    root: parseOptionalTrimmedString(sandbox.root, "sandbox.root", issues),
    preserve: parseOptionalBoolean(sandbox.preserve, "sandbox.preserve", issues),
  };
}

/**
 * Parses the explicit memory fixture array.
 *
 * @param value - Raw memory-pool field.
 * @param issues - Mutable validation issue collection.
 * @returns Normalized fixture DTO list when valid.
 */
export function parseMemoryPool(value: unknown, issues: ValidationIssue[]): InternalEvalFixtureEntryDto[] | undefined {
  if (!Array.isArray(value)) {
    pushIssue(issues, "memoryPool", "Expected an array of fixture entries.");
    return undefined;
  }

  return value.flatMap((entry, index) => {
    const parsed = parseFixtureEntry(entry, index, issues);
    return parsed ? [parsed] : [];
  });
}

/**
 * Parses the explicit procedure fixture array.
 *
 * @param value - Raw procedure-pool field.
 * @param issues - Mutable validation issue collection.
 * @returns Normalized procedure DTO list when valid.
 */
export function parseProcedurePool(value: unknown, issues: ValidationIssue[]): InternalEvalFixtureProcedureDto[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    pushIssue(issues, "procedurePool", "Expected an array of fixture procedures.");
    return undefined;
  }

  return value.flatMap((procedure, index) => {
    const parsed = parseFixtureProcedure(procedure, index, issues);
    return parsed ? [parsed] : [];
  });
}

/**
 * Maps an adapter sandbox DTO into the app-layer sandbox contract.
 *
 * @param dto - Adapter sandbox DTO.
 * @returns App sandbox request or `undefined`.
 */
export function mapSandboxRequestDto(dto: InternalEvalSandboxRequestDto | undefined): InternalEvalSandboxRequestDto | undefined {
  if (dto === undefined) {
    return undefined;
  }

  return {
    root: dto.root,
    preserve: dto.preserve,
  };
}

/**
 * Maps an adapter fixture-entry DTO into the app-layer fixture contract.
 *
 * @param dto - Adapter fixture-entry DTO.
 * @returns App fixture request.
 */
export function mapFixtureEntryDto(dto: InternalEvalFixtureEntryDto): InternalEvalFixtureEntryDto {
  return {
    id: dto.id,
    type: dto.type,
    subject: dto.subject,
    content: dto.content,
    importance: dto.importance,
    expiry: dto.expiry,
    tags: dto.tags,
    source_file: dto.source_file,
    source_context: dto.source_context,
    created_at: dto.created_at,
    updated_at: dto.updated_at,
    retired: dto.retired,
    retired_at: dto.retired_at,
    retired_reason: dto.retired_reason,
    superseded_by: dto.superseded_by,
    claim_key: dto.claim_key,
    claim_key_status: dto.claim_key_status,
    claim_key_source: dto.claim_key_source,
    claim_support_source_kind: dto.claim_support_source_kind,
    claim_support_locator: dto.claim_support_locator,
    claim_support_observed_at: dto.claim_support_observed_at,
    claim_support_mode: dto.claim_support_mode,
    valid_from: dto.valid_from,
    valid_to: dto.valid_to,
    supersession_kind: dto.supersession_kind,
    supersession_reason: dto.supersession_reason,
  };
}

/**
 * Maps an adapter fixture-procedure DTO into the app-layer fixture contract.
 *
 * @param dto - Adapter fixture-procedure DTO.
 * @returns App fixture request.
 */
export function mapFixtureProcedureDto(dto: InternalEvalFixtureProcedureDto): InternalEvalFixtureProcedureDto {
  return {
    id: dto.id,
    procedure_key: dto.procedure_key,
    title: dto.title,
    goal: dto.goal,
    when_to_use: dto.when_to_use,
    when_not_to_use: dto.when_not_to_use,
    prerequisites: dto.prerequisites,
    steps: dto.steps,
    verification: dto.verification,
    failure_modes: dto.failure_modes,
    sources: dto.sources,
    source_file: dto.source_file,
    retired: dto.retired,
    retired_at: dto.retired_at,
    retired_reason: dto.retired_reason,
    superseded_by: dto.superseded_by,
    created_at: dto.created_at,
    updated_at: dto.updated_at,
  };
}

/**
 * Parses an optional array of non-empty trimmed strings.
 *
 * @param value - Raw string-array field.
 * @param path - Stable validation path.
 * @param issues - Mutable validation issue collection.
 * @returns Trimmed string array when valid.
 */
export function parseOptionalStringArray(value: unknown, path: string, issues: ValidationIssue[]): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    pushIssue(issues, path, "Expected an array of strings.");
    return undefined;
  }

  return value.map((item) => item.trim()).filter((item) => item.length > 0);
}

/**
 * Parses an optional threshold constrained to the 0-1 range.
 *
 * @param value - Raw threshold field.
 * @param path - Stable validation path.
 * @param issues - Mutable validation issue collection.
 * @returns Threshold when valid.
 */
export function parseOptionalThreshold(value: unknown, path: string, issues: ValidationIssue[]): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 1) {
    pushIssue(issues, path, "Expected a number from 0 to 1.");
    return undefined;
  }

  return value;
}

/**
 * Parses a required string without trimming or non-empty enforcement.
 *
 * @param value - Raw field value.
 * @param path - Stable validation path.
 * @param issues - Mutable validation issue collection.
 * @returns String value when valid.
 */
export function parseRequiredString(value: unknown, path: string, issues: ValidationIssue[]): string | undefined {
  if (typeof value !== "string") {
    pushIssue(issues, path, "Expected a string.");
    return undefined;
  }

  return value;
}

/**
 * Parses a valid recent-turn role.
 *
 * @param value - Raw role value.
 * @param path - Stable validation path.
 * @param issues - Mutable validation issue collection.
 * @returns Canonical role when valid.
 */
export function parseRecentTurnRole(value: unknown, path: string, issues: ValidationIssue[]): "user" | "assistant" | undefined {
  if (typeof value !== "string") {
    pushIssue(issues, path, 'Expected "user" or "assistant".');
    return undefined;
  }

  const normalized = value.trim();
  if (normalized !== "user" && normalized !== "assistant") {
    pushIssue(issues, path, 'Expected "user" or "assistant".');
    return undefined;
  }

  return normalized;
}

/** Parses a single explicit memory fixture entry. */
function parseFixtureEntry(value: unknown, index: number, issues: ValidationIssue[]): InternalEvalFixtureEntryDto | undefined {
  const basePath = `memoryPool[${index}]`;
  const fixture = parseObject(value, basePath, issues);
  if (fixture === undefined) {
    return undefined;
  }

  pushUnexpectedFields(fixture, FIXTURE_ENTRY_KEYS, basePath, issues);

  const type = parseEntryType(fixture.type, `${basePath}.type`, issues);
  const subject = parseRequiredTrimmedString(fixture.subject, `${basePath}.subject`, issues);
  const content = parseRequiredTrimmedString(fixture.content, `${basePath}.content`, issues);

  if (type === undefined || subject === undefined || content === undefined) {
    return undefined;
  }

  return {
    id: parseOptionalTrimmedString(fixture.id, `${basePath}.id`, issues),
    type,
    subject,
    content,
    importance: parseOptionalIntegerInRange(fixture.importance, `${basePath}.importance`, issues, {
      min: 1,
      max: 10,
    }),
    expiry: parseOptionalExpiry(fixture.expiry, `${basePath}.expiry`, issues),
    tags: parseOptionalStringArray(fixture.tags, `${basePath}.tags`, issues),
    source_file: parseOptionalTrimmedString(fixture.source_file, `${basePath}.source_file`, issues),
    source_context: parseOptionalTrimmedString(fixture.source_context, `${basePath}.source_context`, issues),
    created_at: parseOptionalTimestampString(fixture.created_at, `${basePath}.created_at`, issues),
    updated_at: parseOptionalTimestampString(fixture.updated_at, `${basePath}.updated_at`, issues),
    retired: parseOptionalBoolean(fixture.retired, `${basePath}.retired`, issues),
    retired_at: parseOptionalTimestampString(fixture.retired_at, `${basePath}.retired_at`, issues),
    retired_reason: parseOptionalTrimmedString(fixture.retired_reason, `${basePath}.retired_reason`, issues),
    superseded_by: parseOptionalTrimmedString(fixture.superseded_by, `${basePath}.superseded_by`, issues),
    claim_key: parseOptionalTrimmedString(fixture.claim_key, `${basePath}.claim_key`, issues),
    claim_key_status: parseOptionalClaimKeyStatus(fixture.claim_key_status, `${basePath}.claim_key_status`, issues),
    claim_key_source: parseOptionalClaimKeySource(fixture.claim_key_source, `${basePath}.claim_key_source`, issues),
    claim_support_source_kind: parseOptionalTrimmedString(fixture.claim_support_source_kind, `${basePath}.claim_support_source_kind`, issues),
    claim_support_locator: parseOptionalTrimmedString(fixture.claim_support_locator, `${basePath}.claim_support_locator`, issues),
    claim_support_observed_at: parseOptionalTimestampString(fixture.claim_support_observed_at, `${basePath}.claim_support_observed_at`, issues),
    claim_support_mode: parseOptionalClaimSupportMode(fixture.claim_support_mode, `${basePath}.claim_support_mode`, issues),
    valid_from: parseOptionalTimestampString(fixture.valid_from, `${basePath}.valid_from`, issues),
    valid_to: parseOptionalTimestampString(fixture.valid_to, `${basePath}.valid_to`, issues),
    supersession_kind: parseOptionalTrimmedString(fixture.supersession_kind, `${basePath}.supersession_kind`, issues),
    supersession_reason: parseOptionalTrimmedString(fixture.supersession_reason, `${basePath}.supersession_reason`, issues),
  };
}

/** Parses a single explicit procedure fixture entry. */
function parseFixtureProcedure(value: unknown, index: number, issues: ValidationIssue[]): InternalEvalFixtureProcedureDto | undefined {
  const basePath = `procedurePool[${index}]`;
  const fixture = parseObject(value, basePath, issues);
  if (fixture === undefined) {
    return undefined;
  }

  pushUnexpectedFields(fixture, FIXTURE_PROCEDURE_KEYS, basePath, issues);

  const procedureKey = parseRequiredTrimmedString(fixture.procedure_key, `${basePath}.procedure_key`, issues);
  const title = parseRequiredTrimmedString(fixture.title, `${basePath}.title`, issues);
  const goal = parseRequiredTrimmedString(fixture.goal, `${basePath}.goal`, issues);
  const whenToUse = parseOptionalStringArray(fixture.when_to_use, `${basePath}.when_to_use`, issues);
  const whenNotToUse = parseOptionalStringArray(fixture.when_not_to_use, `${basePath}.when_not_to_use`, issues);
  const prerequisites = parseOptionalStringArray(fixture.prerequisites, `${basePath}.prerequisites`, issues);
  const verification = parseOptionalStringArray(fixture.verification, `${basePath}.verification`, issues);
  const failureModes = parseOptionalStringArray(fixture.failure_modes, `${basePath}.failure_modes`, issues);

  if (procedureKey === undefined || title === undefined || goal === undefined) {
    return undefined;
  }

  try {
    const normalized = normalizeProcedureDefinition(
      {
        procedure_key: procedureKey,
        title,
        goal,
        when_to_use: whenToUse ?? [],
        when_not_to_use: whenNotToUse ?? [],
        prerequisites: prerequisites ?? [],
        steps: fixture.steps,
        verification: verification ?? [],
        failure_modes: failureModes ?? [],
        sources: fixture.sources ?? [{ kind: "manual", label: "recall eval fixture" }],
      },
      basePath,
    );

    return {
      id: parseOptionalTrimmedString(fixture.id, `${basePath}.id`, issues),
      procedure_key: normalized.procedure_key,
      title: normalized.title,
      goal: normalized.goal,
      when_to_use: normalized.when_to_use,
      when_not_to_use: normalized.when_not_to_use,
      prerequisites: normalized.prerequisites,
      steps: normalized.steps,
      verification: normalized.verification,
      failure_modes: normalized.failure_modes,
      sources: normalized.sources,
      source_file: parseOptionalTrimmedString(fixture.source_file, `${basePath}.source_file`, issues),
      retired: parseOptionalBoolean(fixture.retired, `${basePath}.retired`, issues),
      retired_at: parseOptionalTimestampString(fixture.retired_at, `${basePath}.retired_at`, issues),
      retired_reason: parseOptionalTrimmedString(fixture.retired_reason, `${basePath}.retired_reason`, issues),
      superseded_by: parseOptionalTrimmedString(fixture.superseded_by, `${basePath}.superseded_by`, issues),
      created_at: parseOptionalTimestampString(fixture.created_at, `${basePath}.created_at`, issues),
      updated_at: parseOptionalTimestampString(fixture.updated_at, `${basePath}.updated_at`, issues),
    };
  } catch (error) {
    pushIssue(issues, basePath, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/** Parses a valid entry type enum member. */
function parseEntryType(value: unknown, path: string, issues: ValidationIssue[]): EntryType | undefined {
  if (typeof value !== "string" || !ENTRY_TYPES.includes(value as EntryType)) {
    pushIssue(issues, path, `Expected one of: ${ENTRY_TYPES.join(", ")}.`);
    return undefined;
  }

  return value as EntryType;
}

/** Parses an optional expiry enum member. */
function parseOptionalExpiry(value: unknown, path: string, issues: ValidationIssue[]): Expiry | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !EXPIRY_LEVELS.includes(value as Expiry)) {
    pushIssue(issues, path, `Expected one of: ${EXPIRY_LEVELS.join(", ")}.`);
    return undefined;
  }

  return value as Expiry;
}

/** Parses an optional claim-key lifecycle status. */
function parseOptionalClaimKeyStatus(value: unknown, path: string, issues: ValidationIssue[]): ClaimKeyStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !CLAIM_KEY_STATUSES.includes(value as ClaimKeyStatus)) {
    pushIssue(issues, path, `Expected one of: ${CLAIM_KEY_STATUSES.join(", ")}.`);
    return undefined;
  }

  return value as ClaimKeyStatus;
}

/** Parses an optional claim-key provenance source. */
function parseOptionalClaimKeySource(value: unknown, path: string, issues: ValidationIssue[]): ClaimKeySource | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !CLAIM_KEY_SOURCES.includes(value as ClaimKeySource)) {
    pushIssue(issues, path, `Expected one of: ${CLAIM_KEY_SOURCES.join(", ")}.`);
    return undefined;
  }

  return value as ClaimKeySource;
}

/** Parses an optional claim-support normalization mode. */
function parseOptionalClaimSupportMode(value: unknown, path: string, issues: ValidationIssue[]): ClaimSupportMode | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !CLAIM_SUPPORT_MODES.includes(value as ClaimSupportMode)) {
    pushIssue(issues, path, `Expected one of: ${CLAIM_SUPPORT_MODES.join(", ")}.`);
    return undefined;
  }

  return value as ClaimSupportMode;
}
