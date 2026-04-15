import type { BeforeTurnEvalCaseOptions, BeforeTurnEvalCaseRequest } from "../../../app/evals/before-turn/index.js";
import type { BeforeTurnInput, BeforeTurnPolicy, BeforeTurnRecentTurn } from "../../../app/before-turn/index.js";
import type { RecallEvalFixtureEntry, RecallEvalFixtureProcedure, RecallEvalSandboxRequest } from "../../../app/evals/recall/index.js";
import {
  extractParseableCaseId,
  mapFixtureEntryDto,
  mapFixtureProcedureDto,
  mapSandboxRequestDto,
  parseMemoryPool,
  parseObject,
  parseOptionalThreshold,
  parseProcedurePool,
  parseRecentTurnRole,
  parseRequiredString,
  parseSandbox,
  type InternalEvalFixtureEntryDto,
  type InternalEvalFixtureProcedureDto,
  type InternalEvalSandboxRequestDto,
} from "./internal-eval-shared.js";
import {
  isRecord,
  parseOptionalBoolean,
  parseOptionalIntegerInRange,
  parseOptionalTrimmedString,
  parseRequiredTrimmedString,
  pushUnexpectedFields,
  type ValidationIssue,
} from "../../shared/validation.js";

const ROOT_REQUEST_KEYS = new Set<string>(["caseId", "description", "sandbox", "memoryPool", "procedurePool", "beforeTurnInput", "options"]);
const BEFORE_TURN_INPUT_KEYS = new Set<string>(["sessionKey", "currentTurnText", "recentTurns", "trigger", "policy"]);
const BEFORE_TURN_RECENT_TURN_KEYS = new Set<string>(["role", "text"]);
const BEFORE_TURN_POLICY_KEYS = new Set<string>([
  "enableDurableRecall",
  "enableProcedureSuggestion",
  "maxRecentTurns",
  "maxQueryChars",
  "maxDurableEntries",
  "maxHighConfidenceDurableEntries",
  "maxProcedureCandidates",
  "recallThreshold",
  "highConfidenceRecallThreshold",
  "procedureThreshold",
  "skipTrivialTurns",
  "requireTurnSignal",
]);
const OPTIONS_KEYS = new Set<string>(["includeDiagnostics", "includeRenderedPatch", "includeTimings"]);

/**
 * Structured request validation issue emitted at the HTTP boundary.
 */
export type BeforeTurnEvalValidationIssue = ValidationIssue;

/**
 * Adapter-owned normalized recent-turn DTO.
 */
export interface BeforeTurnRecentTurnDto {
  /** Role for one recent turn. */
  role: BeforeTurnRecentTurn["role"];
  /** Raw recent-turn text preserved for service-side normalization. */
  text: string;
}

/**
 * Adapter-owned normalized before-turn policy DTO.
 */
export interface BeforeTurnPolicyDto {
  /** Enables or disables durable-memory recall for this pass. */
  enableDurableRecall?: boolean;
  /** Enables or disables proactive procedure suggestion for this pass. */
  enableProcedureSuggestion?: boolean;
  /** Maximum recent turns to consider while building the turn query. */
  maxRecentTurns?: number;
  /** Maximum total characters preserved in the derived query. */
  maxQueryChars?: number;
  /** Maximum durable-memory rows to return. */
  maxDurableEntries?: number;
  /** Maximum durable rows allowed when all surfaced items are very high confidence. */
  maxHighConfidenceDurableEntries?: number;
  /** Maximum procedure candidates to consider before canonical selection. */
  maxProcedureCandidates?: number;
  /** Optional score threshold used for durable-memory recall. */
  recallThreshold?: number;
  /** Optional threshold required before expanding beyond the default durable cap. */
  highConfidenceRecallThreshold?: number;
  /** Optional score threshold used for canonical procedure selection. */
  procedureThreshold?: number;
  /** Enables or disables early skips for short or social turns. */
  skipTrivialTurns?: boolean;
  /** Enables or disables the factual, procedural, or task signal gate. */
  requireTurnSignal?: boolean;
}

/**
 * Adapter-owned normalized before-turn input DTO.
 */
export interface BeforeTurnInputDto {
  /** Optional session key used for telemetry attribution. */
  sessionKey?: string;
  /** Current user-turn text forwarded to the real service without trimming. */
  currentTurnText: string;
  /** Optional bounded recent conversational turns. */
  recentTurns?: BeforeTurnRecentTurnDto[];
  /** Optional host trigger hint preserved for future routing. */
  trigger?: string;
  /** Optional policy hints that bound the returned patch. */
  policy?: BeforeTurnPolicyDto;
}

/**
 * Adapter-owned normalized options DTO.
 */
export interface BeforeTurnEvalCaseOptionsDto {
  /** Include structured diagnostics in the response. */
  includeDiagnostics?: boolean;
  /** Include rendered prompt text in the response. */
  includeRenderedPatch?: boolean;
  /** Include timing metadata in the response. */
  includeTimings?: boolean;
}

/**
 * Adapter-owned normalized request DTO for the before-turn eval HTTP seam.
 */
export interface BeforeTurnEvalCaseRequestDto {
  /** Stable external case identifier. */
  caseId: string;
  /** Optional human-readable case description. */
  description?: string;
  /** Optional sandbox controls. */
  sandbox?: InternalEvalSandboxRequestDto;
  /** Explicit fixture entries to provision. */
  memoryPool: InternalEvalFixtureEntryDto[];
  /** Optional fixture procedures to provision. */
  procedurePool?: InternalEvalFixtureProcedureDto[];
  /** Before-turn input facts to forward into the real service. */
  beforeTurnInput: BeforeTurnInputDto;
  /** Optional response-shaping flags. */
  options?: BeforeTurnEvalCaseOptionsDto;
}

/**
 * Error thrown when a before-turn eval HTTP request fails boundary validation.
 */
export class BeforeTurnEvalRequestValidationError extends Error {
  /** Parseable case identifier echoed for invalid request correlation when available. */
  public readonly caseId?: string;
  /** Structured list of request validation issues. */
  public readonly issues: BeforeTurnEvalValidationIssue[];

  /**
   * Creates a request validation error with stable issue details.
   *
   * @param issues - Structured validation issues collected during parsing.
   * @param caseId - Parseable request case identifier when available.
   */
  public constructor(issues: BeforeTurnEvalValidationIssue[], caseId?: string) {
    super("Invalid before-turn eval request.");
    this.name = "BeforeTurnEvalRequestValidationError";
    this.issues = issues;
    this.caseId = caseId;
  }
}

/**
 * Validates and normalizes a raw before-turn eval case request payload into an
 * adapter-owned DTO.
 *
 * @param input - Raw parsed JSON body from the HTTP adapter.
 * @returns Normalized request DTO for adapter-to-app mapping.
 * @throws BeforeTurnEvalRequestValidationError When the payload is invalid.
 */
export function parseBeforeTurnEvalCaseRequest(input: unknown): BeforeTurnEvalCaseRequestDto {
  const caseId = extractParseableCaseId(input);

  if (!isRecord(input)) {
    throw new BeforeTurnEvalRequestValidationError(
      [
        {
          path: "$",
          message: "Request body must be a JSON object.",
        },
      ],
      caseId,
    );
  }

  const issues: BeforeTurnEvalValidationIssue[] = [];
  pushUnexpectedFields(input, ROOT_REQUEST_KEYS, "", issues);
  const parsedCaseId = parseRequiredTrimmedString(input.caseId, "caseId", issues);
  const description = parseOptionalTrimmedString(input.description, "description", issues);
  const sandbox = parseSandbox(input.sandbox, issues);
  const memoryPool = parseMemoryPool(input.memoryPool, issues);
  const procedurePool = parseProcedurePool(input.procedurePool, issues);
  const beforeTurnInput = parseBeforeTurnInput(input.beforeTurnInput, issues);
  const options = parseOptions(input.options, issues);

  if (issues.length > 0 || parsedCaseId === undefined || memoryPool === undefined || beforeTurnInput === undefined) {
    throw new BeforeTurnEvalRequestValidationError(issues, caseId);
  }

  return {
    caseId: parsedCaseId,
    description,
    sandbox,
    memoryPool,
    procedurePool,
    beforeTurnInput,
    options,
  };
}

/**
 * Maps a validated adapter DTO into the app-layer request contract.
 *
 * @param dto - Normalized adapter request DTO.
 * @returns App-layer request contract with no raw transport concerns.
 */
export function mapBeforeTurnEvalCaseRequestDto(dto: BeforeTurnEvalCaseRequestDto): BeforeTurnEvalCaseRequest {
  return {
    caseId: dto.caseId,
    description: dto.description,
    sandbox: mapSandboxRequestDto(dto.sandbox) as RecallEvalSandboxRequest | undefined,
    memoryPool: dto.memoryPool.map((entry) => mapFixtureEntryDto(entry) as RecallEvalFixtureEntry),
    procedurePool: dto.procedurePool?.map((procedure) => mapFixtureProcedureDto(procedure) as RecallEvalFixtureProcedure),
    beforeTurnInput: mapBeforeTurnInputDto(dto.beforeTurnInput),
    options: mapCaseOptionsDto(dto.options),
  };
}

/**
 * Parses the before-turn input object aligned to the real app-layer service contract.
 *
 * @param value - Raw before-turn input field.
 * @param issues - Mutable validation issue collection.
 * @returns Normalized before-turn input DTO when valid.
 */
function parseBeforeTurnInput(value: unknown, issues: BeforeTurnEvalValidationIssue[]): BeforeTurnInputDto | undefined {
  const beforeTurnInput = parseObject(value, "beforeTurnInput", issues);
  if (beforeTurnInput === undefined) {
    return undefined;
  }

  pushUnexpectedFields(beforeTurnInput, BEFORE_TURN_INPUT_KEYS, "beforeTurnInput", issues);

  const currentTurnText = parseRequiredString(beforeTurnInput.currentTurnText, "beforeTurnInput.currentTurnText", issues);
  if (currentTurnText === undefined) {
    return undefined;
  }

  return {
    sessionKey: parseOptionalTrimmedString(beforeTurnInput.sessionKey, "beforeTurnInput.sessionKey", issues),
    currentTurnText,
    recentTurns: parseRecentTurns(beforeTurnInput.recentTurns, issues),
    trigger: parseOptionalTrimmedString(beforeTurnInput.trigger, "beforeTurnInput.trigger", issues),
    policy: parseBeforeTurnPolicy(beforeTurnInput.policy, issues),
  };
}

/**
 * Parses the optional recent-turn array aligned to the real app-layer contract.
 *
 * @param value - Raw recent-turns field.
 * @param issues - Mutable validation issue collection.
 * @returns Normalized recent-turn DTOs when valid.
 */
function parseRecentTurns(value: unknown, issues: BeforeTurnEvalValidationIssue[]): BeforeTurnRecentTurnDto[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    issues.push({
      path: "beforeTurnInput.recentTurns",
      message: "Expected an array of recent turns.",
    });
    return undefined;
  }

  return value.flatMap((turn, index) => {
    const basePath = `beforeTurnInput.recentTurns[${index}]`;
    const record = parseObject(turn, basePath, issues);
    if (record === undefined) {
      return [];
    }

    pushUnexpectedFields(record, BEFORE_TURN_RECENT_TURN_KEYS, basePath, issues);
    const role = parseRecentTurnRole(record.role, `${basePath}.role`, issues);
    const text = parseRequiredString(record.text, `${basePath}.text`, issues);
    if (role === undefined || text === undefined) {
      return [];
    }

    return [{ role, text }];
  });
}

/**
 * Parses optional before-turn policy hints.
 *
 * @param value - Raw policy field.
 * @param issues - Mutable validation issue collection.
 * @returns Normalized policy DTO when valid.
 */
function parseBeforeTurnPolicy(value: unknown, issues: BeforeTurnEvalValidationIssue[]): BeforeTurnPolicyDto | undefined {
  if (value === undefined) {
    return undefined;
  }

  const policy = parseObject(value, "beforeTurnInput.policy", issues);
  if (policy === undefined) {
    return undefined;
  }

  pushUnexpectedFields(policy, BEFORE_TURN_POLICY_KEYS, "beforeTurnInput.policy", issues);

  return {
    enableDurableRecall: parseOptionalBoolean(policy.enableDurableRecall, "beforeTurnInput.policy.enableDurableRecall", issues),
    enableProcedureSuggestion: parseOptionalBoolean(policy.enableProcedureSuggestion, "beforeTurnInput.policy.enableProcedureSuggestion", issues),
    maxRecentTurns: parseOptionalIntegerInRange(policy.maxRecentTurns, "beforeTurnInput.policy.maxRecentTurns", issues, {
      min: 0,
    }),
    maxQueryChars: parseOptionalIntegerInRange(policy.maxQueryChars, "beforeTurnInput.policy.maxQueryChars", issues, {
      min: 0,
    }),
    maxDurableEntries: parseOptionalIntegerInRange(policy.maxDurableEntries, "beforeTurnInput.policy.maxDurableEntries", issues, {
      min: 0,
    }),
    maxHighConfidenceDurableEntries: parseOptionalIntegerInRange(
      policy.maxHighConfidenceDurableEntries,
      "beforeTurnInput.policy.maxHighConfidenceDurableEntries",
      issues,
      {
        min: 0,
      },
    ),
    maxProcedureCandidates: parseOptionalIntegerInRange(policy.maxProcedureCandidates, "beforeTurnInput.policy.maxProcedureCandidates", issues, {
      min: 0,
    }),
    recallThreshold: parseOptionalThreshold(policy.recallThreshold, "beforeTurnInput.policy.recallThreshold", issues),
    highConfidenceRecallThreshold: parseOptionalThreshold(policy.highConfidenceRecallThreshold, "beforeTurnInput.policy.highConfidenceRecallThreshold", issues),
    procedureThreshold: parseOptionalThreshold(policy.procedureThreshold, "beforeTurnInput.policy.procedureThreshold", issues),
    skipTrivialTurns: parseOptionalBoolean(policy.skipTrivialTurns, "beforeTurnInput.policy.skipTrivialTurns", issues),
    requireTurnSignal: parseOptionalBoolean(policy.requireTurnSignal, "beforeTurnInput.policy.requireTurnSignal", issues),
  };
}

/**
 * Parses optional case-level output controls.
 *
 * @param value - Raw options field.
 * @param issues - Mutable validation issue collection.
 * @returns Normalized options DTO when valid.
 */
function parseOptions(value: unknown, issues: BeforeTurnEvalValidationIssue[]): BeforeTurnEvalCaseOptionsDto | undefined {
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
    includeRenderedPatch: parseOptionalBoolean(options.includeRenderedPatch, "options.includeRenderedPatch", issues),
    includeTimings: parseOptionalBoolean(options.includeTimings, "options.includeTimings", issues),
  };
}

/**
 * Maps an adapter before-turn input DTO into the app-layer contract.
 *
 * @param dto - Adapter before-turn input DTO.
 * @returns App-layer before-turn input.
 */
function mapBeforeTurnInputDto(dto: BeforeTurnInputDto): BeforeTurnInput {
  return {
    sessionKey: dto.sessionKey,
    currentTurnText: dto.currentTurnText,
    recentTurns: dto.recentTurns?.map((turn) => ({
      role: turn.role,
      text: turn.text,
    })),
    trigger: dto.trigger,
    policy: mapBeforeTurnPolicyDto(dto.policy),
  };
}

/**
 * Maps an adapter before-turn policy DTO into the app-layer contract.
 *
 * @param dto - Adapter policy DTO.
 * @returns App-layer before-turn policy or `undefined`.
 */
function mapBeforeTurnPolicyDto(dto: BeforeTurnPolicyDto | undefined): BeforeTurnPolicy | undefined {
  if (dto === undefined) {
    return undefined;
  }

  return {
    enableDurableRecall: dto.enableDurableRecall,
    enableProcedureSuggestion: dto.enableProcedureSuggestion,
    maxRecentTurns: dto.maxRecentTurns,
    maxQueryChars: dto.maxQueryChars,
    maxDurableEntries: dto.maxDurableEntries,
    maxHighConfidenceDurableEntries: dto.maxHighConfidenceDurableEntries,
    maxProcedureCandidates: dto.maxProcedureCandidates,
    recallThreshold: dto.recallThreshold,
    highConfidenceRecallThreshold: dto.highConfidenceRecallThreshold,
    procedureThreshold: dto.procedureThreshold,
    skipTrivialTurns: dto.skipTrivialTurns,
    requireTurnSignal: dto.requireTurnSignal,
  };
}

/**
 * Maps an adapter options DTO into the app-layer options contract.
 *
 * @param dto - Adapter options DTO.
 * @returns App case options or `undefined`.
 */
function mapCaseOptionsDto(dto: BeforeTurnEvalCaseOptionsDto | undefined): BeforeTurnEvalCaseOptions | undefined {
  if (dto === undefined) {
    return undefined;
  }

  return {
    includeDiagnostics: dto.includeDiagnostics,
    includeRenderedPatch: dto.includeRenderedPatch,
    includeTimings: dto.includeTimings,
  };
}
