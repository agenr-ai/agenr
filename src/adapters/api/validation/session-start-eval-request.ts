import type { SessionStartEvalCaseOptions, SessionStartEvalCaseRequest } from "../../../app/evals/session-start/index.js";
import type { SessionStartInput, SessionStartPolicy } from "../../../app/session-start/index.js";
import type { RecallEvalFixtureEntry, RecallEvalSandboxRequest } from "../../../app/evals/recall/index.js";
import {
  extractParseableCaseId,
  mapFixtureEntryDto,
  mapSandboxRequestDto,
  parseMemoryPool,
  parseObject,
  parseOptionalThreshold,
  parseSandbox,
  type InternalEvalFixtureEntryDto,
  type InternalEvalSandboxRequestDto,
} from "./internal-eval-shared.js";
import {
  parseOptionalBoolean,
  parseOptionalIntegerInRange,
  parseOptionalTrimmedString,
  parseRequiredTrimmedString,
  pushUnexpectedFields,
  type ValidationIssue,
} from "../../shared/validation.js";

const ROOT_REQUEST_KEYS = new Set<string>(["caseId", "description", "sandbox", "memoryPool", "sessionStartInput", "options"]);
const SESSION_START_INPUT_KEYS = new Set<string>(["sessionKey", "policy"]);
const SESSION_START_POLICY_KEYS = new Set<string>([
  "maxCoreEntries",
  "enableArtifactRecall",
  "maxArtifactRecallEntries",
  "maxDurableEntries",
  "maxArtifactChars",
  "recallThreshold",
  "maxProfileSnapshotAgeHours",
]);
const OPTIONS_KEYS = new Set<string>(["includeDiagnostics", "includeTimings"]);

/** Validation issue emitted by the session-start eval request parser. */
export type SessionStartEvalValidationIssue = ValidationIssue;

/** Error thrown when a session-start eval request fails strict validation. */
export class SessionStartEvalRequestValidationError extends Error {
  readonly caseId?: string;
  readonly issues: SessionStartEvalValidationIssue[];

  /** Creates a validation error with optional safely parsed case id. */
  constructor(issues: SessionStartEvalValidationIssue[], caseId?: string) {
    super("Invalid session-start eval request.");
    this.name = "SessionStartEvalRequestValidationError";
    this.issues = issues;
    this.caseId = caseId;
  }
}

/** Adapter-owned normalized DTO for a session-start eval request. */
export interface SessionStartEvalCaseRequestDto {
  caseId: string;
  description?: string;
  sandbox?: InternalEvalSandboxRequestDto;
  memoryPool: InternalEvalFixtureEntryDto[];
  sessionStartInput: SessionStartInputDto;
  options?: SessionStartEvalCaseOptionsDto;
}

/** Adapter-owned normalized DTO for session-start input. */
interface SessionStartInputDto {
  sessionKey?: string;
  policy?: SessionStartPolicyDto;
}

/** Adapter-owned normalized DTO for session-start policy. */
interface SessionStartPolicyDto {
  maxCoreEntries?: number;
  enableArtifactRecall?: boolean;
  maxArtifactRecallEntries?: number;
  maxDurableEntries?: number;
  maxArtifactChars?: number;
  recallThreshold?: number;
  maxProfileSnapshotAgeHours?: number;
}

/** Adapter-owned normalized DTO for response-shaping flags. */
interface SessionStartEvalCaseOptionsDto {
  includeDiagnostics?: boolean;
  includeTimings?: boolean;
}

/** Parses and validates one session-start eval HTTP request payload. */
export function parseSessionStartEvalCaseRequest(payload: unknown): SessionStartEvalCaseRequestDto {
  const issues: ValidationIssue[] = [];
  const input = parseObject(payload, "$", issues);
  if (input === undefined) {
    throw new SessionStartEvalRequestValidationError(issues);
  }

  pushUnexpectedFields(input, ROOT_REQUEST_KEYS, "$", issues);

  const caseId = parseRequiredTrimmedString(input.caseId, "caseId", issues);
  const memoryPool = parseMemoryPool(input.memoryPool, issues);
  const sessionStartInput = parseSessionStartInput(input.sessionStartInput, issues);

  if (caseId === undefined || memoryPool === undefined || sessionStartInput === undefined) {
    throw new SessionStartEvalRequestValidationError(issues, extractParseableCaseId(input));
  }

  const dto: SessionStartEvalCaseRequestDto = {
    caseId,
    memoryPool,
    sessionStartInput,
    description: parseOptionalTrimmedString(input.description, "description", issues),
    sandbox: parseSandbox(input.sandbox, issues),
    options: parseOptions(input.options, issues),
  };

  if (issues.length > 0) {
    throw new SessionStartEvalRequestValidationError(issues, caseId);
  }

  return dto;
}

/** Maps an adapter request DTO into the app-layer session-start eval contract. */
export function mapSessionStartEvalCaseRequestDto(dto: SessionStartEvalCaseRequestDto): SessionStartEvalCaseRequest {
  return {
    caseId: dto.caseId,
    ...(dto.description ? { description: dto.description } : {}),
    sandbox: mapSandboxRequestDto(dto.sandbox) as RecallEvalSandboxRequest | undefined,
    memoryPool: dto.memoryPool.map((entry) => mapFixtureEntryDto(entry)) as RecallEvalFixtureEntry[],
    sessionStartInput: mapSessionStartInputDto(dto.sessionStartInput),
    ...(dto.options ? { options: mapCaseOptionsDto(dto.options) } : {}),
  };
}

/** Parses the nested session-start input DTO. */
function parseSessionStartInput(value: unknown, issues: ValidationIssue[]): SessionStartInputDto | undefined {
  const sessionStartInput = parseObject(value, "sessionStartInput", issues);
  if (sessionStartInput === undefined) {
    return undefined;
  }

  pushUnexpectedFields(sessionStartInput, SESSION_START_INPUT_KEYS, "sessionStartInput", issues);

  return {
    sessionKey: parseOptionalTrimmedString(sessionStartInput.sessionKey, "sessionStartInput.sessionKey", issues),
    policy: parseSessionStartPolicy(sessionStartInput.policy, issues),
  };
}

/** Parses optional session-start policy hints. */
function parseSessionStartPolicy(value: unknown, issues: ValidationIssue[]): SessionStartPolicyDto | undefined {
  if (value === undefined) {
    return undefined;
  }

  const policy = parseObject(value, "sessionStartInput.policy", issues);
  if (policy === undefined) {
    return undefined;
  }

  pushUnexpectedFields(policy, SESSION_START_POLICY_KEYS, "sessionStartInput.policy", issues);

  return {
    maxCoreEntries: parseOptionalIntegerInRange(policy.maxCoreEntries, "sessionStartInput.policy.maxCoreEntries", issues, { min: 0 }),
    enableArtifactRecall: parseOptionalBoolean(policy.enableArtifactRecall, "sessionStartInput.policy.enableArtifactRecall", issues),
    maxArtifactRecallEntries: parseOptionalIntegerInRange(policy.maxArtifactRecallEntries, "sessionStartInput.policy.maxArtifactRecallEntries", issues, {
      min: 0,
    }),
    maxDurableEntries: parseOptionalIntegerInRange(policy.maxDurableEntries, "sessionStartInput.policy.maxDurableEntries", issues, { min: 0 }),
    maxArtifactChars: parseOptionalIntegerInRange(policy.maxArtifactChars, "sessionStartInput.policy.maxArtifactChars", issues, { min: 0 }),
    recallThreshold: parseOptionalThreshold(policy.recallThreshold, "sessionStartInput.policy.recallThreshold", issues),
    maxProfileSnapshotAgeHours: parseOptionalIntegerInRange(policy.maxProfileSnapshotAgeHours, "sessionStartInput.policy.maxProfileSnapshotAgeHours", issues, {
      min: 0,
    }),
  };
}

/** Parses optional session-start eval response-shaping flags. */
function parseOptions(value: unknown, issues: ValidationIssue[]): SessionStartEvalCaseOptionsDto | undefined {
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
    includeTimings: parseOptionalBoolean(options.includeTimings, "options.includeTimings", issues),
  };
}

/** Maps the input DTO into the app-layer session-start contract. */
function mapSessionStartInputDto(dto: SessionStartInputDto): SessionStartInput {
  return {
    ...(dto.sessionKey ? { sessionKey: dto.sessionKey } : {}),
    ...(dto.policy ? { policy: mapSessionStartPolicyDto(dto.policy) } : {}),
  };
}

/** Maps policy DTO fields into the app-layer policy contract. */
function mapSessionStartPolicyDto(dto: SessionStartPolicyDto): SessionStartPolicy {
  return {
    maxCoreEntries: dto.maxCoreEntries,
    enableArtifactRecall: dto.enableArtifactRecall,
    maxArtifactRecallEntries: dto.maxArtifactRecallEntries,
    maxDurableEntries: dto.maxDurableEntries,
    maxArtifactChars: dto.maxArtifactChars,
    recallThreshold: dto.recallThreshold,
    maxProfileSnapshotAgeHours: dto.maxProfileSnapshotAgeHours,
  };
}

/** Maps response-shaping option flags into the app-layer eval contract. */
function mapCaseOptionsDto(dto: SessionStartEvalCaseOptionsDto): SessionStartEvalCaseOptions {
  return {
    includeDiagnostics: dto.includeDiagnostics,
    includeTimings: dto.includeTimings,
  };
}
