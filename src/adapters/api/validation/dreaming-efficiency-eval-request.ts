import type {
  DreamingEfficiencyDreamRunFixture,
  DreamingEfficiencyEvalCaseOptions,
  DreamingEfficiencyEvalCaseRequest,
} from "../../../app/evals/dreaming-efficiency/index.js";
import { DREAM_TIERS, type DreamCompletionSummary } from "../../../core/dreaming/types.js";
import type { ValidationIssue } from "../../shared/validation.js";
import { parseOptionalBoolean, parseOptionalTrimmedString, parseRequiredTrimmedString, pushIssue, pushUnexpectedFields } from "../../shared/validation.js";
import { mapFixtureEntryDto, mapSandboxRequestDto, parseMemoryPool, parseObject, parseSandbox } from "./internal-eval-shared.js";
import { parseDreamCompletionSummary } from "./parse-dream-completion-summary.js";

const ROOT_REQUEST_KEYS = new Set<string>(["caseId", "description", "sandbox", "memoryPool", "dreamRunFixture", "options"]);
const DREAM_RUN_FIXTURE_KEYS = new Set<string>(["tier", "summaryJson", "estimatedCostUsd", "completedAt"]);
const OPTIONS_KEYS = new Set<string>(["includeTimings"]);

/** Validation issue emitted by the dreaming-efficiency eval request parser. */
export type DreamingEfficiencyEvalValidationIssue = ValidationIssue;

/** Error thrown when a dreaming-efficiency eval request fails strict validation. */
export class DreamingEfficiencyEvalRequestValidationError extends Error {
  readonly caseId?: string;
  readonly issues: DreamingEfficiencyEvalValidationIssue[];

  /**
   * Creates one validation error with structured request issues.
   *
   * @param issues - Validation failures found at the HTTP boundary.
   * @param caseId - Optional case identifier extracted before validation failed.
   */
  constructor(issues: DreamingEfficiencyEvalValidationIssue[], caseId?: string) {
    super("Invalid dreaming-efficiency eval request.");
    this.name = "DreamingEfficiencyEvalRequestValidationError";
    this.issues = issues;
    this.caseId = caseId;
  }
}

/** Adapter-owned normalized DTO for a dreaming-efficiency eval request. */
export interface DreamingEfficiencyEvalCaseRequestDto {
  caseId: string;
  description?: string;
  sandbox?: ReturnType<typeof parseSandbox>;
  memoryPool: NonNullable<ReturnType<typeof parseMemoryPool>>;
  dreamRunFixture: DreamingEfficiencyDreamRunFixtureDto;
  options?: DreamingEfficiencyEvalCaseOptionsDto;
}

/** Adapter-owned normalized dream-run fixture DTO. */
interface DreamingEfficiencyDreamRunFixtureDto {
  /** Dreaming tier to record on the seeded run. */
  tier: (typeof DREAM_TIERS)[number];
  /** Completion summary persisted on the seeded run. */
  summaryJson: DreamCompletionSummary;
  /** Optional persisted estimated run cost in USD. */
  estimatedCostUsd?: number;
  /** Optional deterministic completion timestamp. */
  completedAt?: string;
}

/** Adapter-owned normalized response options DTO. */
interface DreamingEfficiencyEvalCaseOptionsDto {
  /** Include timing metadata in the response. */
  includeTimings?: boolean;
}

/** Parses and validates one dreaming-efficiency eval HTTP request payload. */
export function parseDreamingEfficiencyEvalCaseRequest(payload: unknown): DreamingEfficiencyEvalCaseRequestDto {
  const issues: ValidationIssue[] = [];
  const input = parseObject(payload, "$", issues);
  if (input === undefined) {
    throw new DreamingEfficiencyEvalRequestValidationError(issues);
  }

  pushUnexpectedFields(input, ROOT_REQUEST_KEYS, "$", issues);

  const caseId = parseRequiredTrimmedString(input.caseId, "caseId", issues);
  const memoryPool = parseMemoryPool(input.memoryPool, issues);
  if (memoryPool === undefined) {
    pushUnexpectedFields({}, new Set(["memoryPool"]), "$", issues);
  }
  const description = parseOptionalTrimmedString(input.description, "description", issues);
  const sandbox = parseSandbox(input.sandbox, issues);
  const dreamRunFixture = parseRequiredDreamRunFixture(input.dreamRunFixture, issues);
  const options = parseOptions(input.options, issues);

  if (issues.length > 0) {
    throw new DreamingEfficiencyEvalRequestValidationError(issues, caseId);
  }

  return {
    caseId: caseId ?? "",
    memoryPool: memoryPool ?? [],
    ...(description ? { description } : {}),
    ...(sandbox ? { sandbox } : {}),
    dreamRunFixture: dreamRunFixture!,
    ...(options ? { options } : {}),
  };
}

/** Maps an adapter request DTO into the app-layer dreaming-efficiency eval contract. */
export function mapDreamingEfficiencyEvalCaseRequestDto(dto: DreamingEfficiencyEvalCaseRequestDto): DreamingEfficiencyEvalCaseRequest {
  return {
    caseId: dto.caseId,
    ...(dto.description ? { description: dto.description } : {}),
    ...(dto.sandbox ? { sandbox: mapSandboxRequestDto(dto.sandbox) } : {}),
    memoryPool: dto.memoryPool.map((entry) => mapFixtureEntryDto(entry)),
    dreamRunFixture: mapDreamRunFixtureDto(dto.dreamRunFixture),
    ...(dto.options ? { options: mapCaseOptionsDto(dto.options) } : {}),
  };
}

/** Parses the required dream-run fixture payload. */
function parseRequiredDreamRunFixture(value: unknown, issues: ValidationIssue[]): DreamingEfficiencyDreamRunFixtureDto | undefined {
  if (value === undefined) {
    pushIssue(issues, "dreamRunFixture", "Expected an object.");
    return undefined;
  }

  const fixture = parseObject(value, "dreamRunFixture", issues);
  if (fixture === undefined) {
    return undefined;
  }

  pushUnexpectedFields(fixture, DREAM_RUN_FIXTURE_KEYS, "dreamRunFixture", issues);

  const tier = parseDreamTier(fixture.tier, "dreamRunFixture.tier", issues);
  const summaryJson = parseDreamCompletionSummary(fixture.summaryJson, "dreamRunFixture.summaryJson", issues);
  if (summaryJson === undefined) {
    return undefined;
  }

  return {
    tier: tier ?? "standard",
    summaryJson,
    estimatedCostUsd: parseOptionalNonNegativeNumber(fixture.estimatedCostUsd, "dreamRunFixture.estimatedCostUsd", issues),
    completedAt: parseOptionalTrimmedString(fixture.completedAt, "dreamRunFixture.completedAt", issues),
  };
}

/** Parses the required dreaming tier discriminator. */
function parseDreamTier(value: unknown, path: string, issues: ValidationIssue[]): DreamingEfficiencyDreamRunFixtureDto["tier"] | undefined {
  if (value === undefined) {
    pushIssue(issues, path, "Expected a dreaming tier.");
    return undefined;
  }

  if (typeof value !== "string" || !DREAM_TIERS.includes(value as (typeof DREAM_TIERS)[number])) {
    issues.push({ path, message: `tier must be one of: ${DREAM_TIERS.join(", ")}.` });
    return undefined;
  }

  return value as (typeof DREAM_TIERS)[number];
}

/** Parses an optional non-negative finite number. */
function parseOptionalNonNegativeNumber(value: unknown, path: string, issues: ValidationIssue[]): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    pushIssue(issues, path, "Expected a non-negative number.");
    return undefined;
  }

  return value;
}

/** Parses optional eval response-shaping options. */
function parseOptions(value: unknown, issues: ValidationIssue[]): DreamingEfficiencyEvalCaseOptionsDto | undefined {
  if (value === undefined) {
    return undefined;
  }

  const options = parseObject(value, "options", issues);
  if (options === undefined) {
    return undefined;
  }

  pushUnexpectedFields(options, OPTIONS_KEYS, "options", issues);

  return {
    includeTimings: parseOptionalBoolean(options.includeTimings, "options.includeTimings", issues),
  };
}

/** Maps a validated dream-run fixture DTO into the app-layer contract. */
function mapDreamRunFixtureDto(dto: DreamingEfficiencyDreamRunFixtureDto): DreamingEfficiencyDreamRunFixture {
  return {
    tier: dto.tier,
    summaryJson: dto.summaryJson,
    ...(dto.estimatedCostUsd !== undefined ? { estimatedCostUsd: dto.estimatedCostUsd } : {}),
    ...(dto.completedAt ? { completedAt: dto.completedAt } : {}),
  };
}

/** Maps validated options into the app-layer contract. */
function mapCaseOptionsDto(dto: DreamingEfficiencyEvalCaseOptionsDto): DreamingEfficiencyEvalCaseOptions {
  return {
    includeTimings: dto.includeTimings,
  };
}
