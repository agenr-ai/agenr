import type {
  DreamingEfficiencyDreamRunFixture,
  DreamingEfficiencyEvalCaseOptions,
  DreamingEfficiencyEvalCaseRequest,
} from "../../../app/evals/dreaming-efficiency/index.js";
import { DREAM_TIERS, type DreamCompletionSummary, type DreamEfficiencySummary, type DreamEvidenceRef } from "../../../core/dreaming/types.js";
import type { ValidationIssue } from "../../shared/validation.js";
import { parseOptionalBoolean, parseOptionalTrimmedString, parseRequiredTrimmedString, pushIssue, pushUnexpectedFields } from "../../shared/validation.js";
import { mapFixtureEntryDto, mapSandboxRequestDto, parseMemoryPool, parseObject, parseSandbox } from "./internal-eval-shared.js";

const ROOT_REQUEST_KEYS = new Set<string>(["caseId", "description", "sandbox", "memoryPool", "dreamRunFixture", "options"]);
const DREAM_RUN_FIXTURE_KEYS = new Set<string>(["tier", "summaryJson", "estimatedCostUsd", "completedAt"]);
const DREAM_COMPLETION_SUMMARY_KEYS = new Set<string>([
  "actions_taken",
  "durables_skipped",
  "observations",
  "recommendations",
  "scan",
  "extract",
  "temporalize",
  "project",
  "prune",
  "efficiency",
]);
const DREAM_SCAN_KEYS = new Set<string>([
  "episodesSinceLastRun",
  "ingestFilesSinceLastRun",
  "durablesCreatedSinceLastRun",
  "evidenceRefs",
  "unsynthesizedImportanceSum",
]);
const DREAM_EVIDENCE_REF_KEYS = new Set<string>(["kind", "locator", "observedAt"]);
const DREAM_EXTRACT_KEYS = new Set<string>([
  "episodesScanned",
  "candidatesEmitted",
  "newCandidates",
  "refineCandidates",
  "knownCandidates",
  "durablesInserted",
]);
const DREAM_TEMPORALIZE_KEYS = new Set<string>(["revisionsIdentified", "revisionsApplied", "revisionsSkipped"]);
const DREAM_PROJECT_KEYS = new Set<string>(["profileDurableCount", "directiveCount", "snapshotId", "applied"]);
const DREAM_PRUNE_KEYS = new Set<string>(["durablesScanned", "candidatesIdentified", "candidatesProtected", "candidatesRetirable", "durablesStaled", "dryRun"]);
const DREAM_EFFICIENCY_KEYS = new Set<string>([
  "evidenceItemsRead",
  "synthesizedDurableMutations",
  "costPerSynthesizedDurableUsd",
  "profileInjectionTokenEstimate",
  "recomputeRatio",
]);
const DURABLE_SKIP_KEYS = new Set<string>(["durable_id", "reason"]);
const DREAM_EVIDENCE_KINDS = ["episode", "ingest_log", "durable", "transcript"] as const;
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

/** Parses a dreaming completion summary fixture used for efficiency derivation. */
function parseDreamCompletionSummary(value: unknown, path: string, issues: ValidationIssue[]): DreamCompletionSummary | undefined {
  const summary = parseObject(value, path, issues);
  if (summary === undefined) {
    return undefined;
  }

  pushUnexpectedFields(summary, DREAM_COMPLETION_SUMMARY_KEYS, path, issues);

  const actionsTaken = parseRequiredNonNegativeInteger(summary.actions_taken, `${path}.actions_taken`, issues);
  const durablesSkipped = parseDurablesSkipped(summary.durables_skipped, `${path}.durables_skipped`, issues);
  const observations = parseRequiredStringArray(summary.observations, `${path}.observations`, issues);
  const recommendations = parseRequiredStringArray(summary.recommendations, `${path}.recommendations`, issues);
  const scan = parseDreamScanSummary(summary.scan, `${path}.scan`, issues);
  const project = parseDreamProjectSummary(summary.project, `${path}.project`, issues);

  return {
    actions_taken: actionsTaken ?? 0,
    durables_skipped: durablesSkipped ?? [],
    observations: observations ?? [],
    recommendations: recommendations ?? [],
    ...(scan ? { scan } : {}),
    ...(parseDreamExtractSummary(summary.extract, `${path}.extract`, issues) ?? {}),
    ...(parseDreamTemporalizeSummary(summary.temporalize, `${path}.temporalize`, issues) ?? {}),
    ...(project ? { project } : {}),
    ...(parseDreamPruneSummary(summary.prune, `${path}.prune`, issues) ?? {}),
    ...(parseDreamEfficiencySummary(summary.efficiency, `${path}.efficiency`, issues) ?? {}),
  };
}

/** Parses the scan summary required for efficiency derivation. */
function parseDreamScanSummary(value: unknown, path: string, issues: ValidationIssue[]): DreamCompletionSummary["scan"] | undefined {
  const scan = parseRequiredObject(value, path, issues);
  if (scan === undefined) {
    return undefined;
  }

  pushUnexpectedFields(scan, DREAM_SCAN_KEYS, path, issues);

  return {
    episodesSinceLastRun: parseRequiredNonNegativeInteger(scan.episodesSinceLastRun, `${path}.episodesSinceLastRun`, issues) ?? 0,
    ingestFilesSinceLastRun: parseRequiredNonNegativeInteger(scan.ingestFilesSinceLastRun, `${path}.ingestFilesSinceLastRun`, issues) ?? 0,
    durablesCreatedSinceLastRun: parseRequiredNonNegativeInteger(scan.durablesCreatedSinceLastRun, `${path}.durablesCreatedSinceLastRun`, issues) ?? 0,
    evidenceRefs: parseEvidenceRefs(scan.evidenceRefs, `${path}.evidenceRefs`, issues) ?? [],
    unsynthesizedImportanceSum: parseRequiredNonNegativeNumber(scan.unsynthesizedImportanceSum, `${path}.unsynthesizedImportanceSum`, issues) ?? 0,
  };
}

/** Parses optional extract-stage counters. */
function parseDreamExtractSummary(value: unknown, path: string, issues: ValidationIssue[]): Pick<DreamCompletionSummary, "extract"> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const extract = parseObject(value, path, issues);
  if (extract === undefined) {
    return undefined;
  }

  pushUnexpectedFields(extract, DREAM_EXTRACT_KEYS, path, issues);

  return {
    extract: {
      episodesScanned: parseRequiredNonNegativeInteger(extract.episodesScanned, `${path}.episodesScanned`, issues) ?? 0,
      candidatesEmitted: parseRequiredNonNegativeInteger(extract.candidatesEmitted, `${path}.candidatesEmitted`, issues) ?? 0,
      newCandidates: parseRequiredNonNegativeInteger(extract.newCandidates, `${path}.newCandidates`, issues) ?? 0,
      refineCandidates: parseRequiredNonNegativeInteger(extract.refineCandidates, `${path}.refineCandidates`, issues) ?? 0,
      knownCandidates: parseRequiredNonNegativeInteger(extract.knownCandidates, `${path}.knownCandidates`, issues) ?? 0,
      durablesInserted: parseRequiredNonNegativeInteger(extract.durablesInserted, `${path}.durablesInserted`, issues) ?? 0,
    },
  };
}

/** Parses optional temporalize-stage counters. */
function parseDreamTemporalizeSummary(value: unknown, path: string, issues: ValidationIssue[]): Pick<DreamCompletionSummary, "temporalize"> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const temporalize = parseObject(value, path, issues);
  if (temporalize === undefined) {
    return undefined;
  }

  pushUnexpectedFields(temporalize, DREAM_TEMPORALIZE_KEYS, path, issues);

  return {
    temporalize: {
      revisionsIdentified: parseRequiredNonNegativeInteger(temporalize.revisionsIdentified, `${path}.revisionsIdentified`, issues) ?? 0,
      revisionsApplied: parseRequiredNonNegativeInteger(temporalize.revisionsApplied, `${path}.revisionsApplied`, issues) ?? 0,
      revisionsSkipped: parseRequiredNonNegativeInteger(temporalize.revisionsSkipped, `${path}.revisionsSkipped`, issues) ?? 0,
    },
  };
}

/** Parses the profile projection counters required for token estimation. */
function parseDreamProjectSummary(value: unknown, path: string, issues: ValidationIssue[]): DreamCompletionSummary["project"] | undefined {
  const project = parseRequiredObject(value, path, issues);
  if (project === undefined) {
    return undefined;
  }

  pushUnexpectedFields(project, DREAM_PROJECT_KEYS, path, issues);

  return {
    profileDurableCount: parseRequiredNonNegativeInteger(project.profileDurableCount, `${path}.profileDurableCount`, issues) ?? 0,
    directiveCount: parseRequiredNonNegativeInteger(project.directiveCount, `${path}.directiveCount`, issues) ?? 0,
    snapshotId: parseOptionalStringOrNull(project.snapshotId, `${path}.snapshotId`, issues),
    applied: parseRequiredBoolean(project.applied, `${path}.applied`, issues) ?? false,
  };
}

/** Parses optional prune-stage counters. */
function parseDreamPruneSummary(value: unknown, path: string, issues: ValidationIssue[]): Pick<DreamCompletionSummary, "prune"> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const prune = parseObject(value, path, issues);
  if (prune === undefined) {
    return undefined;
  }

  pushUnexpectedFields(prune, DREAM_PRUNE_KEYS, path, issues);

  return {
    prune: {
      durablesScanned: parseRequiredNonNegativeInteger(prune.durablesScanned, `${path}.durablesScanned`, issues) ?? 0,
      candidatesIdentified: parseRequiredNonNegativeInteger(prune.candidatesIdentified, `${path}.candidatesIdentified`, issues) ?? 0,
      candidatesProtected: parseRequiredNonNegativeInteger(prune.candidatesProtected, `${path}.candidatesProtected`, issues) ?? 0,
      candidatesRetirable: parseRequiredNonNegativeInteger(prune.candidatesRetirable, `${path}.candidatesRetirable`, issues) ?? 0,
      durablesStaled: parseRequiredNonNegativeInteger(prune.durablesStaled, `${path}.durablesStaled`, issues) ?? 0,
      dryRun: parseRequiredBoolean(prune.dryRun, `${path}.dryRun`, issues) ?? false,
    },
  };
}

/** Parses an optional persisted efficiency block when a fixture includes one. */
function parseDreamEfficiencySummary(value: unknown, path: string, issues: ValidationIssue[]): Pick<DreamCompletionSummary, "efficiency"> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const efficiency = parseObject(value, path, issues);
  if (efficiency === undefined) {
    return undefined;
  }

  pushUnexpectedFields(efficiency, DREAM_EFFICIENCY_KEYS, path, issues);

  return {
    efficiency: {
      evidenceItemsRead: parseRequiredNonNegativeInteger(efficiency.evidenceItemsRead, `${path}.evidenceItemsRead`, issues) ?? 0,
      synthesizedDurableMutations: parseRequiredNonNegativeInteger(efficiency.synthesizedDurableMutations, `${path}.synthesizedDurableMutations`, issues) ?? 0,
      costPerSynthesizedDurableUsd: parseOptionalNumberOrNull(efficiency.costPerSynthesizedDurableUsd, `${path}.costPerSynthesizedDurableUsd`, issues),
      profileInjectionTokenEstimate:
        parseRequiredNonNegativeInteger(efficiency.profileInjectionTokenEstimate, `${path}.profileInjectionTokenEstimate`, issues) ?? 0,
      recomputeRatio: parseRequiredNonNegativeNumber(efficiency.recomputeRatio, `${path}.recomputeRatio`, issues) ?? 0,
    } satisfies DreamEfficiencySummary,
  };
}

/** Parses the required skipped-durable array. */
function parseDurablesSkipped(value: unknown, path: string, issues: ValidationIssue[]): DreamCompletionSummary["durables_skipped"] | undefined {
  if (!Array.isArray(value)) {
    pushIssue(issues, path, "Expected an array.");
    return undefined;
  }

  return value.flatMap((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = parseObject(item, itemPath, issues);
    if (record === undefined) {
      return [];
    }

    pushUnexpectedFields(record, DURABLE_SKIP_KEYS, itemPath, issues);
    const reason = parseRequiredTrimmedString(record.reason, `${itemPath}.reason`, issues);
    const durableId = parseOptionalTrimmedString(record.durable_id, `${itemPath}.durable_id`, issues);
    return [
      {
        ...(durableId ? { durable_id: durableId } : {}),
        reason: reason ?? "",
      },
    ];
  });
}

/** Parses required evidence references for the scan summary. */
function parseEvidenceRefs(value: unknown, path: string, issues: ValidationIssue[]): DreamEvidenceRef[] | undefined {
  if (!Array.isArray(value)) {
    pushIssue(issues, path, "Expected an array.");
    return undefined;
  }

  return value.flatMap((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = parseObject(item, itemPath, issues);
    if (record === undefined) {
      return [];
    }

    pushUnexpectedFields(record, DREAM_EVIDENCE_REF_KEYS, itemPath, issues);
    const kind = parseEvidenceKind(record.kind, `${itemPath}.kind`, issues);
    const locator = parseRequiredTrimmedString(record.locator, `${itemPath}.locator`, issues);
    const observedAt = parseOptionalTrimmedString(record.observedAt, `${itemPath}.observedAt`, issues);
    return [
      {
        kind: kind ?? "episode",
        locator: locator ?? "",
        ...(observedAt ? { observedAt } : {}),
      },
    ];
  });
}

/** Parses a supported evidence-reference kind. */
function parseEvidenceKind(value: unknown, path: string, issues: ValidationIssue[]): DreamEvidenceRef["kind"] | undefined {
  if (typeof value !== "string" || !DREAM_EVIDENCE_KINDS.includes(value as DreamEvidenceRef["kind"])) {
    pushIssue(issues, path, `kind must be one of: ${DREAM_EVIDENCE_KINDS.join(", ")}.`);
    return undefined;
  }

  return value as DreamEvidenceRef["kind"];
}

/** Parses one required object. */
function parseRequiredObject(value: unknown, path: string, issues: ValidationIssue[]): Record<string, unknown> | undefined {
  if (value === undefined) {
    pushIssue(issues, path, "Expected an object.");
    return undefined;
  }

  return parseObject(value, path, issues);
}

/** Parses a required non-negative integer. */
function parseRequiredNonNegativeInteger(value: unknown, path: string, issues: ValidationIssue[]): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    pushIssue(issues, path, "Expected a non-negative integer.");
    return undefined;
  }

  return value;
}

/** Parses a required non-negative finite number. */
function parseRequiredNonNegativeNumber(value: unknown, path: string, issues: ValidationIssue[]): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    pushIssue(issues, path, "Expected a non-negative number.");
    return undefined;
  }

  return value;
}

/** Parses an optional non-negative finite number. */
function parseOptionalNonNegativeNumber(value: unknown, path: string, issues: ValidationIssue[]): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseRequiredNonNegativeNumber(value, path, issues);
}

/** Parses a required boolean. */
function parseRequiredBoolean(value: unknown, path: string, issues: ValidationIssue[]): boolean | undefined {
  if (typeof value !== "boolean") {
    pushIssue(issues, path, "Expected a boolean.");
    return undefined;
  }

  return value;
}

/** Parses a required string array. */
function parseRequiredStringArray(value: unknown, path: string, issues: ValidationIssue[]): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    pushIssue(issues, path, "Expected an array of strings.");
    return undefined;
  }

  return value;
}

/** Parses an optional string-or-null field. */
function parseOptionalStringOrNull(value: unknown, path: string, issues: ValidationIssue[]): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return parseOptionalTrimmedString(value, path, issues) ?? null;
}

/** Parses a number-or-null field. */
function parseOptionalNumberOrNull(value: unknown, path: string, issues: ValidationIssue[]): number | null {
  if (value === null) {
    return null;
  }

  return parseRequiredNonNegativeNumber(value, path, issues) ?? null;
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
