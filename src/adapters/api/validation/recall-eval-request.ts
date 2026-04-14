import type {
  RecallEvalCaseOptions,
  RecallEvalCaseRequest,
  RecallEvalFaultInjectionRequest,
  RecallEvalFixtureEntry,
  RecallEvalPath,
  RecallEvalQueryRequest,
  RecallEvalSandboxRequest,
  RecallEvalUnifiedRequest,
} from "../../../app/evals/recall/index.js";
import type { ClaimSlotPolicyConfig, ClaimSlotPolicy } from "../../../core/claim-slot-policy.js";
import { ENTRY_TYPES } from "../../../core/types.js";
import {
  extractParseableCaseId,
  mapFixtureEntryDto as mapSharedFixtureEntryDto,
  mapSandboxRequestDto as mapSharedSandboxRequestDto,
  parseMemoryPool,
  parseObject,
  parseOptionalStringArray,
  parseOptionalThreshold,
  parseSandbox,
  type InternalEvalFixtureEntryDto,
} from "./internal-eval-shared.js";
import {
  isRecord,
  parseOptionalBoolean,
  parseOptionalIntegerInRange,
  parseOptionalTrimmedString,
  parseRequiredTrimmedString,
  pushIssue,
  pushUnexpectedFields,
  type ValidationIssue,
} from "../../shared/validation.js";

const ROOT_REQUEST_KEYS = new Set<string>(["caseId", "description", "recallPath", "sandbox", "memoryPool", "recallRequest", "unified", "options"]);
const RECALL_REQUEST_KEYS = new Set<string>([
  "text",
  "limit",
  "threshold",
  "budget",
  "types",
  "tags",
  "since",
  "until",
  "around",
  "aroundRadius",
  "asOf",
  "rankingProfile",
]);
const UNIFIED_REQUEST_KEYS = new Set<string>(["mode", "sessionKey", "memoryPolicy"]);
const UNIFIED_MEMORY_POLICY_KEYS = new Set<string>(["slotPolicies"]);
const SLOT_POLICY_KEYS = new Set<string>(["attributeHeads"]);
const OPTIONS_KEYS = new Set<string>(["includeDiagnostics", "includeCandidates", "includeTimings", "faultInjection"]);
const FAULT_INJECTION_KEYS = new Set<string>(["queryEmbeddingFailure", "vectorSearchFailure"]);
const RECALL_PATHS = ["core", "unified"] as const;
const RECALL_RANKING_PROFILES = ["historical_state"] as const;
const UNIFIED_RECALL_MODES = ["auto", "entries", "episodes"] as const;
const CLAIM_SLOT_POLICIES = ["exclusive", "multivalued"] as const;

/**
 * Structured request validation issue emitted at the HTTP boundary.
 */
export type RecallEvalValidationIssue = ValidationIssue;

/**
 * Adapter-owned normalized sandbox request DTO.
 */
export interface RecallEvalSandboxRequestDto {
  /** Optional sandbox root path. */
  root?: string;
  /** When true, preserves the sandbox on disk for inspection. */
  preserve?: boolean;
}

/**
 * Adapter-owned normalized fixture entry DTO.
 */
export interface RecallEvalFixtureEntryDto {
  /** Optional stable entry identifier. */
  id?: string;
  /** Durable entry type. */
  type: InternalEvalFixtureEntryDto["type"];
  /** Fixture subject line. */
  subject: string;
  /** Fixture content body. */
  content: string;
  /** Optional importance override. */
  importance?: number;
  /** Optional expiry override. */
  expiry?: InternalEvalFixtureEntryDto["expiry"];
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
  claim_key_status?: InternalEvalFixtureEntryDto["claim_key_status"];
  /** Optional claim-key provenance source. */
  claim_key_source?: InternalEvalFixtureEntryDto["claim_key_source"];
  /** Optional claim support source kind. */
  claim_support_source_kind?: string;
  /** Optional claim support locator. */
  claim_support_locator?: string;
  /** Optional claim support observed-at timestamp. */
  claim_support_observed_at?: string;
  /** Optional claim support normalization mode. */
  claim_support_mode?: InternalEvalFixtureEntryDto["claim_support_mode"];
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
 * Adapter-owned normalized recall query DTO.
 */
export interface RecallEvalQueryRequestDto {
  /** User query text. */
  text: string;
  /** Optional result limit. */
  limit?: number;
  /** Optional score threshold. */
  threshold?: number;
  /** Optional ranking budget. */
  budget?: number;
  /** Optional entry-type filters. */
  types?: RecallEvalQueryRequest["types"];
  /** Optional tag filters. */
  tags?: string[];
  /** Optional lower time bound. */
  since?: string;
  /** Optional upper time bound. */
  until?: string;
  /** Optional around-date hint. */
  around?: string;
  /** Optional around-date radius. */
  aroundRadius?: number;
  /** Optional explicit as-of reference point. */
  asOf?: string;
  /** Optional ranking profile selector. */
  rankingProfile?: RecallEvalQueryRequest["rankingProfile"];
}

/**
 * Adapter-owned normalized options DTO.
 */
export interface RecallEvalCaseOptionsDto {
  /** Include structured diagnostics in the response. */
  includeDiagnostics?: boolean;
  /** Include candidate-count diagnostics in the response. */
  includeCandidates?: boolean;
  /** Include timing metadata in the response. */
  includeTimings?: boolean;
  /** Internal deterministic degradation controls for recall eval cases. */
  faultInjection?: RecallEvalFaultInjectionRequest;
}

/**
 * Adapter-owned normalized memory-policy DTO for unified recall execution.
 */
export interface RecallEvalUnifiedMemoryPolicyRequestDto {
  /** Optional slot-policy overrides aligned with the OpenClaw adapter. */
  slotPolicies?: ClaimSlotPolicyConfig;
}

/**
 * Adapter-owned normalized unified-caller DTO.
 */
export interface RecallEvalUnifiedRequestDto {
  /** Optional unified routing mode. */
  mode?: RecallEvalUnifiedRequest["mode"];
  /** Optional session key forwarded into real recall telemetry. */
  sessionKey?: string;
  /** Optional runtime memory-policy overrides. */
  memoryPolicy?: RecallEvalUnifiedMemoryPolicyRequestDto;
}

/**
 * Adapter-owned normalized request DTO for the recall eval HTTP seam.
 */
export interface RecallEvalCaseRequestDto {
  /** Stable external case identifier. */
  caseId: string;
  /** Optional human-readable case description. */
  description?: string;
  /** Optional recall execution path override. */
  recallPath?: RecallEvalPath;
  /** Optional sandbox controls. */
  sandbox?: RecallEvalSandboxRequestDto;
  /** Explicit fixture entries to provision. */
  memoryPool: RecallEvalFixtureEntryDto[];
  /** Normalized recall query payload. */
  recallRequest: RecallEvalQueryRequestDto;
  /** Optional unified-only caller context. */
  unified?: RecallEvalUnifiedRequestDto;
  /** Optional response-shaping flags. */
  options?: RecallEvalCaseOptionsDto;
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
 * Validates and normalizes a raw recall eval case request payload into an
 * adapter-owned DTO.
 *
 * @param input - Raw parsed JSON body from the HTTP adapter.
 * @returns Normalized request DTO for adapter-to-app mapping.
 * @throws RecallEvalRequestValidationError When the payload is invalid.
 */
export function parseRecallEvalCaseRequest(input: unknown): RecallEvalCaseRequestDto {
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
  const parsedCaseId = parseRequiredTrimmedString(input.caseId, "caseId", issues);
  const description = parseOptionalTrimmedString(input.description, "description", issues);
  const recallPath = parseOptionalRecallPath(input.recallPath, "recallPath", issues);
  const sandbox = parseSandbox(input.sandbox, issues);
  const memoryPool = parseMemoryPool(input.memoryPool, issues);
  const recallRequest = parseRecallRequest(input.recallRequest, issues);
  const unified = parseUnifiedRequest(input.unified, issues);
  const options = parseOptions(input.options, issues);
  validatePathSpecificRequest(recallPath, recallRequest, unified, issues);

  if (issues.length > 0 || parsedCaseId === undefined || memoryPool === undefined || recallRequest === undefined) {
    throw new RecallEvalRequestValidationError(issues, caseId);
  }

  return {
    caseId: parsedCaseId,
    description,
    recallPath,
    sandbox,
    memoryPool,
    recallRequest,
    unified,
    options,
  };
}

/**
 * Maps a validated adapter DTO into the app-layer request contract.
 *
 * @param dto - Normalized adapter request DTO.
 * @returns App-layer request contract with no raw transport concerns.
 */
export function mapRecallEvalCaseRequestDto(dto: RecallEvalCaseRequestDto): RecallEvalCaseRequest {
  return {
    caseId: dto.caseId,
    description: dto.description,
    recallPath: dto.recallPath,
    sandbox: mapSandboxRequestDto(dto.sandbox),
    memoryPool: dto.memoryPool.map(mapFixtureEntryDto),
    recallRequest: mapRecallRequestDto(dto.recallRequest),
    unified: mapUnifiedRequestDto(dto.unified),
    options: mapCaseOptionsDto(dto.options),
  };
}

/**
/**
 * Parses the recall query request aligned to the core recall input.
 *
 * @param value - Raw recall request field.
 * @param issues - Mutable validation issue collection.
 * @returns Normalized recall query DTO when valid.
 */
function parseRecallRequest(value: unknown, issues: RecallEvalValidationIssue[]): RecallEvalQueryRequestDto | undefined {
  const recallRequest = parseObject(value, "recallRequest", issues);
  if (recallRequest === undefined) {
    return undefined;
  }

  pushUnexpectedFields(recallRequest, RECALL_REQUEST_KEYS, "recallRequest", issues);

  const text = parseRequiredTrimmedString(recallRequest.text, "recallRequest.text", issues);
  if (text === undefined) {
    return undefined;
  }

  return {
    text,
    limit: parseOptionalIntegerInRange(recallRequest.limit, "recallRequest.limit", issues, {
      min: 0,
    }),
    threshold: parseOptionalThreshold(recallRequest.threshold, "recallRequest.threshold", issues),
    budget: parseOptionalIntegerInRange(recallRequest.budget, "recallRequest.budget", issues, {
      min: 0,
    }),
    types: parseOptionalEntryTypeArray(recallRequest.types, "recallRequest.types", issues),
    tags: parseOptionalStringArray(recallRequest.tags, "recallRequest.tags", issues),
    since: parseOptionalTrimmedString(recallRequest.since, "recallRequest.since", issues),
    until: parseOptionalTrimmedString(recallRequest.until, "recallRequest.until", issues),
    around: parseOptionalTrimmedString(recallRequest.around, "recallRequest.around", issues),
    aroundRadius: parseOptionalIntegerInRange(recallRequest.aroundRadius, "recallRequest.aroundRadius", issues, {
      min: 1,
    }),
    asOf: parseOptionalTrimmedString(recallRequest.asOf, "recallRequest.asOf", issues),
    rankingProfile: parseOptionalRankingProfile(recallRequest.rankingProfile, "recallRequest.rankingProfile", issues),
  };
}

/**
 * Parses optional unified-caller context aligned with the OpenClaw tool surface.
 *
 * @param value - Raw unified request field.
 * @param issues - Mutable validation issue collection.
 * @returns Normalized unified DTO when valid.
 */
function parseUnifiedRequest(value: unknown, issues: RecallEvalValidationIssue[]): RecallEvalUnifiedRequestDto | undefined {
  if (value === undefined) {
    return undefined;
  }

  const unified = parseObject(value, "unified", issues);
  if (unified === undefined) {
    return undefined;
  }

  pushUnexpectedFields(unified, UNIFIED_REQUEST_KEYS, "unified", issues);

  return {
    mode: parseOptionalUnifiedRecallMode(unified.mode, "unified.mode", issues),
    sessionKey: parseOptionalTrimmedString(unified.sessionKey, "unified.sessionKey", issues),
    memoryPolicy: parseUnifiedMemoryPolicy(unified.memoryPolicy, issues),
  };
}

/**
 * Parses optional case-level output controls.
 *
 * @param value - Raw options field.
 * @param issues - Mutable validation issue collection.
 * @returns Normalized options DTO when valid.
 */
function parseOptions(value: unknown, issues: RecallEvalValidationIssue[]): RecallEvalCaseOptionsDto | undefined {
  if (value === undefined) {
    return undefined;
  }

  const options = parseObject(value, "options", issues);
  if (options === undefined) {
    return undefined;
  }

  pushUnexpectedFields(options, OPTIONS_KEYS, "options", issues);

  return {
    includeDiagnostics: parseOptionalBoolean(options.includeDiagnostics, "options.includeDiagnostics", issues),
    includeCandidates: parseOptionalBoolean(options.includeCandidates, "options.includeCandidates", issues),
    includeTimings: parseOptionalBoolean(options.includeTimings, "options.includeTimings", issues),
    faultInjection: parseFaultInjection(options.faultInjection, issues),
  };
}

/**
 * Parses optional internal fault-injection controls for deterministic degraded evals.
 *
 * @param value - Raw fault-injection field.
 * @param issues - Mutable validation issue collection.
 * @returns Normalized fault-injection config when valid.
 */
function parseFaultInjection(value: unknown, issues: RecallEvalValidationIssue[]): RecallEvalFaultInjectionRequest | undefined {
  if (value === undefined) {
    return undefined;
  }

  const faultInjection = parseObject(value, "options.faultInjection", issues);
  if (faultInjection === undefined) {
    return undefined;
  }

  pushUnexpectedFields(faultInjection, FAULT_INJECTION_KEYS, "options.faultInjection", issues);

  return {
    queryEmbeddingFailure: parseOptionalBoolean(faultInjection.queryEmbeddingFailure, "options.faultInjection.queryEmbeddingFailure", issues),
    vectorSearchFailure: parseOptionalBoolean(faultInjection.vectorSearchFailure, "options.faultInjection.vectorSearchFailure", issues),
  };
}

/**
 * Parses the optional unified memory-policy block.
 *
 * @param value - Raw unified memory-policy field.
 * @param issues - Mutable validation issue collection.
 * @returns Normalized unified memory-policy DTO when valid.
 */
function parseUnifiedMemoryPolicy(value: unknown, issues: RecallEvalValidationIssue[]): RecallEvalUnifiedMemoryPolicyRequestDto | undefined {
  if (value === undefined) {
    return undefined;
  }

  const memoryPolicy = parseObject(value, "unified.memoryPolicy", issues);
  if (memoryPolicy === undefined) {
    return undefined;
  }

  pushUnexpectedFields(memoryPolicy, UNIFIED_MEMORY_POLICY_KEYS, "unified.memoryPolicy", issues);

  return {
    slotPolicies: parseClaimSlotPolicyConfig(memoryPolicy.slotPolicies, "unified.memoryPolicy.slotPolicies", issues),
  };
}

/**
 * Parses a valid entry type enum member.
 *
 * @param value - Raw entry-type value.
 * @param path - Stable validation path.
 * @param issues - Mutable validation issue collection.
 * @returns Valid entry type when recognized.
 */
function parseEntryType(value: unknown, path: string, issues: RecallEvalValidationIssue[]): InternalEvalFixtureEntryDto["type"] | undefined {
  if (typeof value !== "string" || !ENTRY_TYPES.includes(value as RecallEvalFixtureEntry["type"])) {
    pushIssue(issues, path, `Expected one of: ${ENTRY_TYPES.join(", ")}.`);
    return undefined;
  }

  return value as InternalEvalFixtureEntryDto["type"];
}

/**
 * Parses an optional recall execution path enum member.
 *
 * @param value - Raw recall-path value.
 * @param path - Stable validation path.
 * @param issues - Mutable validation issue collection.
 * @returns Valid recall path when recognized.
 */
function parseOptionalRecallPath(value: unknown, path: string, issues: RecallEvalValidationIssue[]): RecallEvalPath | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !RECALL_PATHS.includes(value as RecallEvalPath)) {
    pushIssue(issues, path, `Expected one of: ${RECALL_PATHS.join(", ")}.`);
    return undefined;
  }

  return value as RecallEvalPath;
}

/**
 * Parses an optional unified recall mode enum member.
 *
 * @param value - Raw unified-mode value.
 * @param path - Stable validation path.
 * @param issues - Mutable validation issue collection.
 * @returns Valid unified mode when recognized.
 */
function parseOptionalUnifiedRecallMode(value: unknown, path: string, issues: RecallEvalValidationIssue[]): RecallEvalUnifiedRequest["mode"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !UNIFIED_RECALL_MODES.includes(value as (typeof UNIFIED_RECALL_MODES)[number])) {
    pushIssue(issues, path, `Expected one of: ${UNIFIED_RECALL_MODES.join(", ")}.`);
    return undefined;
  }

  return value as RecallEvalUnifiedRequest["mode"];
}

/**
 * Parses an optional internal recall ranking profile enum member.
 *
 * @param value - Raw ranking-profile value.
 * @param path - Stable validation path.
 * @param issues - Mutable validation issue collection.
 * @returns Valid ranking profile when recognized.
 */
function parseOptionalRankingProfile(value: unknown, path: string, issues: RecallEvalValidationIssue[]): RecallEvalQueryRequest["rankingProfile"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !RECALL_RANKING_PROFILES.includes(value as (typeof RECALL_RANKING_PROFILES)[number])) {
    pushIssue(issues, path, `Expected one of: ${RECALL_RANKING_PROFILES.join(", ")}.`);
    return undefined;
  }

  return value as RecallEvalQueryRequest["rankingProfile"];
}

/**
/**
 * Parses an optional array of valid entry type enum members.
 *
 * @param value - Raw entry-type array field.
 * @param path - Stable validation path.
 * @param issues - Mutable validation issue collection.
 * @returns Valid entry-type array when recognized.
 */
function parseOptionalEntryTypeArray(value: unknown, path: string, issues: RecallEvalValidationIssue[]): RecallEvalQueryRequest["types"] | undefined {
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
    if (entryType !== undefined) {
      parsed.push(entryType);
    }
  }

  return parsed;
}

/**
/**
 * Parses one optional slot-policy config block keyed by canonical attribute head.
 *
 * @param value - Raw slot-policy config field.
 * @param path - Stable validation path.
 * @param issues - Mutable validation issue collection.
 * @returns Normalized slot-policy config when valid.
 */
function parseClaimSlotPolicyConfig(value: unknown, path: string, issues: RecallEvalValidationIssue[]): ClaimSlotPolicyConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const config = parseObject(value, path, issues);
  if (config === undefined) {
    return undefined;
  }

  pushUnexpectedFields(config, SLOT_POLICY_KEYS, path, issues);
  const attributeHeads = parseClaimSlotPolicyAttributeHeads(config.attributeHeads, `${path}.attributeHeads`, issues);
  return attributeHeads ? { attributeHeads } : undefined;
}

/**
 * Parses optional attribute-head slot-policy overrides.
 *
 * @param value - Raw attribute-head map.
 * @param path - Stable validation path.
 * @param issues - Mutable validation issue collection.
 * @returns Canonicalized attribute-head map when valid.
 */
function parseClaimSlotPolicyAttributeHeads(
  value: unknown,
  path: string,
  issues: RecallEvalValidationIssue[],
): Readonly<Record<string, ClaimSlotPolicy>> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return undefined;
  }

  const normalized: Record<string, ClaimSlotPolicy> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const attributeHead = rawKey.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(attributeHead)) {
      pushIssue(issues, `${path}.${rawKey}`, "Expected a canonical attribute-head label.");
      continue;
    }

    if (typeof rawValue !== "string" || !CLAIM_SLOT_POLICIES.includes(rawValue as ClaimSlotPolicy)) {
      pushIssue(issues, `${path}.${attributeHead}`, `Expected one of: ${CLAIM_SLOT_POLICIES.join(", ")}.`);
      continue;
    }

    normalized[attributeHead] = rawValue as ClaimSlotPolicy;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
/**
 * Enforces path-specific request rules so the seam mirrors real callers.
 *
 * @param recallPath - Requested top-level recall path.
 * @param recallRequest - Parsed recall request DTO.
 * @param unified - Parsed unified-only request block.
 * @param issues - Mutable validation issue collection.
 */
function validatePathSpecificRequest(
  recallPath: RecallEvalPath | undefined,
  recallRequest: RecallEvalQueryRequestDto | undefined,
  unified: RecallEvalUnifiedRequestDto | undefined,
  issues: RecallEvalValidationIssue[],
): void {
  const effectivePath = recallPath ?? "core";
  if (effectivePath !== "unified") {
    if (unified !== undefined) {
      pushIssue(issues, "unified", 'The "unified" block is only allowed when recallPath is "unified".');
    }
    return;
  }

  if (recallRequest === undefined) {
    return;
  }

  if (recallRequest.budget !== undefined) {
    pushIssue(issues, "recallRequest.budget", 'This field is only supported when recallPath is "core".');
  }
  if (recallRequest.since !== undefined) {
    pushIssue(issues, "recallRequest.since", 'This field is only supported when recallPath is "core".');
  }
  if (recallRequest.until !== undefined) {
    pushIssue(issues, "recallRequest.until", 'This field is only supported when recallPath is "core".');
  }
  if (recallRequest.around !== undefined) {
    pushIssue(issues, "recallRequest.around", 'This field is only supported when recallPath is "core".');
  }
  if (recallRequest.aroundRadius !== undefined) {
    pushIssue(issues, "recallRequest.aroundRadius", 'This field is only supported when recallPath is "core".');
  }
  if (recallRequest.rankingProfile !== undefined) {
    pushIssue(issues, "recallRequest.rankingProfile", 'This field is derived by unified recall and cannot be supplied when recallPath is "unified".');
  }
}

/**
 * Maps an adapter sandbox DTO into the app-layer sandbox contract.
 *
 * @param dto - Adapter sandbox DTO.
 * @returns App sandbox request or `undefined`.
 */
function mapSandboxRequestDto(dto: RecallEvalSandboxRequestDto | undefined): RecallEvalSandboxRequest | undefined {
  return mapSharedSandboxRequestDto(dto) as RecallEvalSandboxRequest | undefined;
}

/**
 * Maps an adapter fixture-entry DTO into the app-layer fixture contract.
 *
 * @param dto - Adapter fixture-entry DTO.
 * @returns App fixture request.
 */
function mapFixtureEntryDto(dto: RecallEvalFixtureEntryDto): RecallEvalFixtureEntry {
  return mapSharedFixtureEntryDto(dto) as RecallEvalFixtureEntry;
}

/**
 * Maps an adapter recall-query DTO into the app-layer query contract.
 *
 * @param dto - Adapter recall-query DTO.
 * @returns App recall query request.
 */
function mapRecallRequestDto(dto: RecallEvalQueryRequestDto): RecallEvalQueryRequest {
  return {
    text: dto.text,
    limit: dto.limit,
    threshold: dto.threshold,
    budget: dto.budget,
    types: dto.types,
    tags: dto.tags,
    since: dto.since,
    until: dto.until,
    around: dto.around,
    aroundRadius: dto.aroundRadius,
    asOf: dto.asOf,
    rankingProfile: dto.rankingProfile,
  };
}

/**
 * Maps an adapter unified-request DTO into the app-layer unified contract.
 *
 * @param dto - Adapter unified-request DTO.
 * @returns App unified request or `undefined`.
 */
function mapUnifiedRequestDto(dto: RecallEvalUnifiedRequestDto | undefined): RecallEvalUnifiedRequest | undefined {
  if (dto === undefined) {
    return undefined;
  }

  return {
    mode: dto.mode,
    sessionKey: dto.sessionKey,
    memoryPolicy:
      dto.memoryPolicy !== undefined
        ? {
            slotPolicies: dto.memoryPolicy.slotPolicies,
          }
        : undefined,
  };
}

/**
 * Maps an adapter options DTO into the app-layer options contract.
 *
 * @param dto - Adapter options DTO.
 * @returns App case options or `undefined`.
 */
function mapCaseOptionsDto(dto: RecallEvalCaseOptionsDto | undefined): RecallEvalCaseOptions | undefined {
  if (dto === undefined) {
    return undefined;
  }

  return {
    includeDiagnostics: dto.includeDiagnostics,
    includeCandidates: dto.includeCandidates,
    includeTimings: dto.includeTimings,
    faultInjection: dto.faultInjection,
  };
}
