import {
  parseOptionalBoolean,
  parseOptionalIntegerInRange,
  parseOptionalTrimmedString,
  pushIssue,
  pushUnexpectedFields,
  isRecord,
  type ValidationIssue,
} from "../shared/validation.js";
import {
  authMethodToProvider,
  DEFAULT_API_PORT,
  DEFAULT_CLAIM_EXTRACTION_CONCURRENCY,
  DEFAULT_CLAIM_EXTRACTION_CONFIDENCE_THRESHOLD,
  DEFAULT_CLAIM_EXTRACTION_ELIGIBLE_TYPES,
  DEFAULT_SURGEON_CONTEXT_LIMIT,
  DEFAULT_SURGEON_COST_CAP,
  DEFAULT_SURGEON_DAILY_COST_CAP,
  DEFAULT_SURGEON_RETIREMENT_PROTECT_MIN_IMPORTANCE,
  DEFAULT_SURGEON_RETIREMENT_PROTECT_RECALLED_DAYS,
  DEFAULT_SURGEON_SKIP_RECENTLY_EVALUATED_DAYS,
  isAgenrAuthMethod,
  isAgenrProvider,
  isEntryType,
  sameEligibleTypes,
  type AgenrClaimExtractionConfig,
  type AgenrConfigInput,
  type AgenrStoredCredentials,
  type ModelConfig,
  type ResolvedAgenrClaimExtractionConfig,
  type ResolvedAgenrConfig,
  type ResolvedSurgeonConfig,
  type ResolvedSurgeonPassConfig,
  type SurgeonConfig,
} from "./types.js";
import type { EntryType } from "../../core/types.js";

/**
 * Options that control config parsing defaults.
 */
export interface ParseAgenrConfigOptions {
  /** Default database path applied when config does not set `dbPath`. */
  defaultDbPath: string;
}

/**
 * Successful config parse result.
 */
export interface ParsedAgenrConfigSuccess {
  /** Success discriminator. */
  ok: true;
  /** Fully resolved runtime config. */
  value: ResolvedAgenrConfig;
}

/**
 * Failed config parse result.
 */
export interface ParsedAgenrConfigFailure {
  /** Failure discriminator. */
  ok: false;
  /** Structured validation issues emitted by the config boundary. */
  issues: ValidationIssue[];
}

/**
 * Result type returned by adapter-side config parsing helpers.
 */
export type ParsedAgenrConfigResult = ParsedAgenrConfigSuccess | ParsedAgenrConfigFailure;

/**
 * Validates one raw config value and resolves runtime defaults.
 *
 * @param value - Raw parsed JSON value supplied by the config boundary.
 * @param options - Parsing defaults used for runtime resolution.
 * @returns Fully resolved config or structured validation issues.
 */
export function parseAgenrConfig(value: unknown, options: ParseAgenrConfigOptions): ParsedAgenrConfigResult {
  const normalized = normalizeAgenrConfig(value, options);
  return normalized.ok ? { ok: true, value: normalized.resolved } : normalized;
}

/**
 * Validates one raw config value and returns the canonical persisted shape.
 *
 * @param value - Raw parsed JSON value supplied by the config boundary.
 * @param options - Parsing defaults used for runtime resolution.
 * @returns Canonical persisted config or structured validation issues.
 */
export function canonicalizeAgenrConfigInput(
  value: unknown,
  options: ParseAgenrConfigOptions,
): { ok: true; value: AgenrConfigInput } | ParsedAgenrConfigFailure {
  const normalized = normalizeAgenrConfig(value, options);
  return normalized.ok ? { ok: true, value: normalized.input } : normalized;
}

/**
 * Converts one resolved runtime config back into the sparse persisted shape.
 *
 * This is used by setup and init flows that need to edit existing persisted
 * config without dragging resolved defaults back into `config.json`.
 *
 * @param config - Fully resolved runtime config.
 * @param options - Optional persistence defaults used when omitting values.
 * @returns Canonical persisted config shape.
 */
export function toAgenrConfigInput(config: ResolvedAgenrConfig, options: Partial<ParseAgenrConfigOptions> = {}): AgenrConfigInput {
  const input: AgenrConfigInput = {
    ...(config.auth ? { auth: config.auth } : {}),
    ...(config.provider ? { provider: config.provider } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(hasStoredCredentials(config.credentials) ? { credentials: config.credentials } : {}),
    ...(config.embeddingModel ? { embeddingModel: config.embeddingModel } : {}),
    ...(config.extractionContext ? { extractionContext: config.extractionContext } : {}),
    ...(hasModelConfig(config.extractionModel) ? { extractionModel: config.extractionModel } : {}),
    ...(hasModelConfig(config.dedupModel) ? { dedupModel: config.dedupModel } : {}),
    ...(hasModelConfig(config.episodeModel) ? { episodeModel: config.episodeModel } : {}),
  };

  const claimExtraction = toClaimExtractionInput(config.claimExtraction);
  if (claimExtraction) {
    input.claimExtraction = claimExtraction;
  }

  const surgeon = toSurgeonInput(config.surgeon);
  if (surgeon) {
    input.surgeon = surgeon;
  }

  if (config.dbPath !== options.defaultDbPath) {
    input.dbPath = config.dbPath;
  }

  if (config.apiPort !== DEFAULT_API_PORT) {
    input.apiPort = config.apiPort;
  }

  return input;
}

/**
 * Internal normalization result that carries both persisted and runtime forms.
 */
type NormalizedAgenrConfigResult =
  | {
      ok: true;
      input: AgenrConfigInput;
      resolved: ResolvedAgenrConfig;
    }
  | ParsedAgenrConfigFailure;

/**
 * Parses and validates the config once, producing both persisted and runtime forms.
 *
 * @param value - Raw parsed JSON value supplied by the config boundary.
 * @param options - Parsing defaults used for runtime resolution.
 * @returns Canonical persisted shape plus fully resolved runtime config.
 */
function normalizeAgenrConfig(value: unknown, options: ParseAgenrConfigOptions): NormalizedAgenrConfigResult {
  const issues: ValidationIssue[] = [];
  const claimDefaults = createDefaultClaimExtractionConfig();
  const surgeonDefaults = createDefaultSurgeonConfig();

  if (value === undefined) {
    return {
      ok: true,
      input: {},
      resolved: {
        claimExtraction: claimDefaults,
        surgeon: surgeonDefaults,
        dbPath: options.defaultDbPath,
        apiPort: DEFAULT_API_PORT,
      },
    };
  }

  if (!isRecord(value)) {
    return {
      ok: false,
      issues: [{ path: "config", message: "Expected a JSON object." }],
    };
  }

  pushTopLevelIssues(value, issues);

  const auth = parseAuth(value.auth, "auth", issues);
  const provider = parseProvider(value.provider, "provider", issues);
  const model = parseOptionalTrimmedString(value.model, "model", issues);
  const credentials = parseCredentials(value.credentials, "credentials", issues);
  const embeddingModel = parseOptionalTrimmedString(value.embeddingModel, "embeddingModel", issues);
  const extractionContext = parseOptionalTrimmedString(value.extractionContext, "extractionContext", issues);
  const extractionModel = parseModelConfig(value.extractionModel, "extractionModel", issues);
  const dedupModel = parseModelConfig(value.dedupModel, "dedupModel", issues);
  const episodeModel = parseModelConfig(value.episodeModel, "episodeModel", issues);
  const claimExtraction = parseClaimExtractionConfig(value.claimExtraction, "claimExtraction", issues);
  const surgeon = parseSurgeonConfig(value.surgeon, "surgeon", issues);
  const dbPath = parseOptionalTrimmedString(value.dbPath, "dbPath", issues);
  const apiPort = parseOptionalIntegerInRange(value.apiPort, "apiPort", issues, {
    min: 1,
    max: 65_535,
  });

  if (auth && provider && authMethodToProvider(auth) !== provider) {
    pushIssue(issues, "provider", `Provider "${provider}" does not match auth method "${auth}".`);
  }

  if (issues.length > 0) {
    return {
      ok: false,
      issues,
    };
  }

  const input: AgenrConfigInput = {
    ...(auth ? { auth } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(credentials ? { credentials } : {}),
    ...(embeddingModel ? { embeddingModel } : {}),
    ...(extractionContext ? { extractionContext } : {}),
    ...(extractionModel ? { extractionModel } : {}),
    ...(dedupModel ? { dedupModel } : {}),
    ...(episodeModel ? { episodeModel } : {}),
    ...(claimExtraction.input ? { claimExtraction: claimExtraction.input } : {}),
    ...(surgeon.input ? { surgeon: surgeon.input } : {}),
    ...(dbPath ? { dbPath } : {}),
    ...(apiPort !== undefined ? { apiPort } : {}),
  };

  return {
    ok: true,
    input,
    resolved: {
      ...(auth ? { auth } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(credentials ? { credentials } : {}),
      ...(embeddingModel ? { embeddingModel } : {}),
      ...(extractionContext ? { extractionContext } : {}),
      ...(extractionModel ? { extractionModel } : {}),
      ...(dedupModel ? { dedupModel } : {}),
      ...(episodeModel ? { episodeModel } : {}),
      claimExtraction: claimExtraction.resolved,
      surgeon: surgeon.resolved,
      dbPath: dbPath ?? options.defaultDbPath,
      apiPort: apiPort ?? DEFAULT_API_PORT,
    },
  };
}

/**
 * Emits top-level unknown-field and legacy-field issues.
 *
 * @param value - Raw config record.
 * @param issues - Mutable issue collection.
 */
function pushTopLevelIssues(value: Record<string, unknown>, issues: ValidationIssue[]): void {
  const allowedKeys = new Set([
    "auth",
    "provider",
    "model",
    "credentials",
    "embeddingModel",
    "extractionContext",
    "extractionModel",
    "dedupModel",
    "episodeModel",
    "claimExtraction",
    "surgeon",
    "dbPath",
    "apiPort",
    "apiKey",
    "embeddingApiKey",
  ]);
  pushUnexpectedFields(value, allowedKeys, "", issues);

  if ("apiKey" in value) {
    pushIssue(issues, "apiKey", "Removed field. Move this value to credentials.openaiApiKey or credentials.anthropicApiKey, then delete apiKey.");
  }

  if ("embeddingApiKey" in value) {
    pushIssue(issues, "embeddingApiKey", "Removed field. Move this value to credentials.openaiApiKey, then delete embeddingApiKey.");
  }
}

/**
 * Parses one optional auth-method field.
 *
 * @param value - Raw field value.
 * @param path - Stable issue path.
 * @param issues - Mutable issue collection.
 * @returns Normalized auth method when valid.
 */
function parseAuth(value: unknown, path: string, issues: ValidationIssue[]): ResolvedAgenrConfig["auth"] {
  const normalized = parseOptionalTrimmedString(value, path, issues);
  if (!normalized) {
    return undefined;
  }

  if (!isAgenrAuthMethod(normalized)) {
    pushIssue(issues, path, "Expected a supported auth method.");
    return undefined;
  }

  return normalized;
}

/**
 * Parses one optional provider field.
 *
 * @param value - Raw field value.
 * @param path - Stable issue path.
 * @param issues - Mutable issue collection.
 * @returns Normalized provider when valid.
 */
function parseProvider(value: unknown, path: string, issues: ValidationIssue[]): string | undefined {
  const normalized = parseOptionalTrimmedString(value, path, issues);
  if (!normalized) {
    return undefined;
  }

  if (!isAgenrProvider(normalized)) {
    pushIssue(issues, path, "Expected a supported provider.");
    return undefined;
  }

  return normalized;
}

/**
 * Parses the nested credentials block.
 *
 * @param value - Raw nested value.
 * @param path - Stable issue path.
 * @param issues - Mutable issue collection.
 * @returns Canonical credentials block when valid.
 */
function parseCredentials(value: unknown, path: string, issues: ValidationIssue[]): AgenrStoredCredentials | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return undefined;
  }

  const startIndex = issues.length;
  pushUnexpectedFields(value, new Set(["openaiApiKey", "anthropicApiKey", "anthropicOauthToken"]), path, issues);

  const openaiApiKey = parseOptionalTrimmedString(value.openaiApiKey, `${path}.openaiApiKey`, issues);
  const anthropicApiKey = parseOptionalTrimmedString(value.anthropicApiKey, `${path}.anthropicApiKey`, issues);
  const anthropicOauthToken = parseOptionalTrimmedString(value.anthropicOauthToken, `${path}.anthropicOauthToken`, issues);

  if (issues.length > startIndex) {
    return undefined;
  }

  const credentials: AgenrStoredCredentials = {
    ...(openaiApiKey ? { openaiApiKey } : {}),
    ...(anthropicApiKey ? { anthropicApiKey } : {}),
    ...(anthropicOauthToken ? { anthropicOauthToken } : {}),
  };

  return hasStoredCredentials(credentials) ? credentials : undefined;
}

/**
 * Parses one optional provider/model override block.
 *
 * @param value - Raw nested value.
 * @param path - Stable issue path.
 * @param issues - Mutable issue collection.
 * @returns Canonical model override when valid.
 */
function parseModelConfig(value: unknown, path: string, issues: ValidationIssue[]): ModelConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return undefined;
  }

  const startIndex = issues.length;
  pushUnexpectedFields(value, new Set(["provider", "model"]), path, issues);

  const provider = parseProvider(value.provider, `${path}.provider`, issues);
  const model = parseOptionalTrimmedString(value.model, `${path}.model`, issues);

  if (!provider && !model) {
    pushIssue(issues, path, "Expected at least one of provider or model.");
  }

  if (issues.length > startIndex) {
    return undefined;
  }

  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}

/**
 * Parses the nested claim-extraction block.
 *
 * @param value - Raw nested value.
 * @param path - Stable issue path.
 * @param issues - Mutable issue collection.
 * @returns Canonical persisted values plus the resolved runtime block.
 */
function parseClaimExtractionConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): { input?: AgenrClaimExtractionConfig; resolved: ResolvedAgenrClaimExtractionConfig } {
  const defaults = createDefaultClaimExtractionConfig();
  if (value === undefined) {
    return {
      resolved: defaults,
    };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return {
      resolved: defaults,
    };
  }

  const startIndex = issues.length;
  pushUnexpectedFields(value, new Set(["enabled", "confidenceThreshold", "eligibleTypes", "concurrency", "model"]), path, issues);

  const enabled = parseOptionalBoolean(value.enabled, `${path}.enabled`, issues);
  const confidenceThreshold = parseOptionalUnitInterval(value.confidenceThreshold, `${path}.confidenceThreshold`, issues);
  const eligibleTypes = parseEligibleTypes(value.eligibleTypes, `${path}.eligibleTypes`, issues);
  const concurrency = parseOptionalIntegerInRange(value.concurrency, `${path}.concurrency`, issues, {
    min: 1,
  });
  const model = parseModelConfig(value.model, `${path}.model`, issues);

  if (issues.length > startIndex) {
    return {
      resolved: defaults,
    };
  }

  const input: AgenrClaimExtractionConfig = {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(confidenceThreshold !== undefined ? { confidenceThreshold } : {}),
    ...(eligibleTypes ? { eligibleTypes } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(model ? { model } : {}),
  };

  return {
    ...(hasClaimExtractionInput(input) ? { input } : {}),
    resolved: {
      enabled: enabled ?? defaults.enabled,
      confidenceThreshold: confidenceThreshold ?? defaults.confidenceThreshold,
      eligibleTypes: eligibleTypes ?? defaults.eligibleTypes,
      concurrency: concurrency ?? defaults.concurrency,
      ...(model ? { model } : {}),
    },
  };
}

/**
 * Parses the nested surgeon block.
 *
 * @param value - Raw nested value.
 * @param path - Stable issue path.
 * @param issues - Mutable issue collection.
 * @returns Canonical persisted values plus the resolved runtime block.
 */
function parseSurgeonConfig(value: unknown, path: string, issues: ValidationIssue[]): { input?: SurgeonConfig; resolved: ResolvedSurgeonConfig } {
  const defaults = createDefaultSurgeonConfig();
  if (value === undefined) {
    return {
      resolved: defaults,
    };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return {
      resolved: defaults,
    };
  }

  const startIndex = issues.length;
  pushUnexpectedFields(value, new Set(["model", "costCap", "dailyCostCap", "contextLimit", "customInstructions", "passes"]), path, issues);

  const model = parseModelConfig(value.model, `${path}.model`, issues);
  const costCap = parseOptionalPositiveNumber(value.costCap, `${path}.costCap`, issues);
  const dailyCostCap = parseOptionalNonNegativeNumber(value.dailyCostCap, `${path}.dailyCostCap`, issues);
  const contextLimit = parseOptionalIntegerInRange(value.contextLimit, `${path}.contextLimit`, issues, { min: 0 });
  const customInstructions = parseOptionalTrimmedString(value.customInstructions, `${path}.customInstructions`, issues);
  const retirement = parseRetirementPassConfig(value.passes, `${path}.passes`, issues);

  if (issues.length > startIndex) {
    return {
      resolved: defaults,
    };
  }

  const input: SurgeonConfig = {
    ...(model ? { model } : {}),
    ...(costCap !== undefined ? { costCap } : {}),
    ...(dailyCostCap !== undefined ? { dailyCostCap } : {}),
    ...(contextLimit !== undefined ? { contextLimit } : {}),
    ...(customInstructions ? { customInstructions } : {}),
    ...(retirement.input
      ? {
          passes: {
            retirement: retirement.input,
          },
        }
      : {}),
  };

  return {
    ...(hasSurgeonInput(input) ? { input } : {}),
    resolved: {
      ...(model ? { model } : {}),
      costCap: costCap ?? defaults.costCap,
      dailyCostCap: dailyCostCap ?? defaults.dailyCostCap,
      contextLimit: contextLimit ?? defaults.contextLimit,
      ...(customInstructions ? { customInstructions } : {}),
      passes: {
        retirement: retirement.resolved,
      },
    },
  };
}

/**
 * Parses the nested `surgeon.passes.retirement` block.
 *
 * @param value - Raw `passes` value.
 * @param path - Stable issue path.
 * @param issues - Mutable issue collection.
 * @returns Canonical persisted values plus the resolved runtime block.
 */
function parseRetirementPassConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): { input?: NonNullable<NonNullable<SurgeonConfig["passes"]>["retirement"]>; resolved: ResolvedSurgeonPassConfig } {
  const defaults = createDefaultRetirementPassConfig();
  if (value === undefined) {
    return {
      resolved: defaults,
    };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return {
      resolved: defaults,
    };
  }

  const startIndex = issues.length;
  pushUnexpectedFields(value, new Set(["retirement"]), path, issues);

  const retirement = value.retirement;
  if (retirement === undefined) {
    if (issues.length === startIndex) {
      pushIssue(issues, path, "Expected a retirement config when passes is provided.");
    }
    return {
      resolved: defaults,
    };
  }

  if (!isRecord(retirement)) {
    pushIssue(issues, `${path}.retirement`, "Expected an object.");
    return {
      resolved: defaults,
    };
  }

  pushUnexpectedFields(retirement, new Set(["protectRecalledDays", "protectMinImportance", "skipRecentlyEvaluatedDays"]), `${path}.retirement`, issues);

  const protectRecalledDays = parseOptionalIntegerInRange(retirement.protectRecalledDays, `${path}.retirement.protectRecalledDays`, issues, {
    min: 0,
  });
  const protectMinImportance = parseOptionalIntegerInRange(retirement.protectMinImportance, `${path}.retirement.protectMinImportance`, issues, {
    min: 0,
  });
  const skipRecentlyEvaluatedDays = parseOptionalIntegerInRange(retirement.skipRecentlyEvaluatedDays, `${path}.retirement.skipRecentlyEvaluatedDays`, issues, {
    min: 0,
  });

  if (issues.length > startIndex) {
    return {
      resolved: defaults,
    };
  }

  const input: NonNullable<NonNullable<SurgeonConfig["passes"]>["retirement"]> = {
    ...(protectRecalledDays !== undefined ? { protectRecalledDays } : {}),
    ...(protectMinImportance !== undefined ? { protectMinImportance } : {}),
    ...(skipRecentlyEvaluatedDays !== undefined ? { skipRecentlyEvaluatedDays } : {}),
  };

  return {
    ...(Object.keys(input).length > 0 ? { input } : {}),
    resolved: {
      protectRecalledDays: protectRecalledDays ?? defaults.protectRecalledDays,
      protectMinImportance: protectMinImportance ?? defaults.protectMinImportance,
      skipRecentlyEvaluatedDays: skipRecentlyEvaluatedDays ?? defaults.skipRecentlyEvaluatedDays,
    },
  };
}

/**
 * Parses one optional 0-1 floating-point field.
 *
 * @param value - Raw field value.
 * @param path - Stable issue path.
 * @param issues - Mutable issue collection.
 * @returns Number when valid.
 */
function parseOptionalUnitInterval(value: unknown, path: string, issues: ValidationIssue[]): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    pushIssue(issues, path, "Expected a number from 0 to 1.");
    return undefined;
  }

  return value;
}

/**
 * Parses one optional positive numeric field.
 *
 * @param value - Raw field value.
 * @param path - Stable issue path.
 * @param issues - Mutable issue collection.
 * @returns Number when valid.
 */
function parseOptionalPositiveNumber(value: unknown, path: string, issues: ValidationIssue[]): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    pushIssue(issues, path, "Expected a positive number.");
    return undefined;
  }

  return value;
}

/**
 * Parses one optional non-negative numeric field.
 *
 * @param value - Raw field value.
 * @param path - Stable issue path.
 * @param issues - Mutable issue collection.
 * @returns Number when valid.
 */
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

/**
 * Parses one optional list of eligible entry types.
 *
 * @param value - Raw field value.
 * @param path - Stable issue path.
 * @param issues - Mutable issue collection.
 * @returns Unique eligible types when valid.
 */
function parseEligibleTypes(value: unknown, path: string, issues: ValidationIssue[]): EntryType[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    pushIssue(issues, path, "Expected an array of entry types.");
    return undefined;
  }

  const normalized: EntryType[] = [];
  const seen = new Set<EntryType>();

  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") {
      pushIssue(issues, `${path}.${index}`, "Expected a supported entry type.");
      continue;
    }

    const trimmed = item.trim();
    if (!isEntryType(trimmed)) {
      pushIssue(issues, `${path}.${index}`, "Expected a supported entry type.");
      continue;
    }

    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      normalized.push(trimmed);
    }
  }

  if (normalized.length === 0) {
    pushIssue(issues, path, "Expected at least one supported entry type.");
    return undefined;
  }

  return normalized;
}

/**
 * Returns the default resolved claim-extraction config.
 *
 * @returns Claim-extraction defaults used at runtime.
 */
function createDefaultClaimExtractionConfig(): ResolvedAgenrClaimExtractionConfig {
  return {
    enabled: true,
    confidenceThreshold: DEFAULT_CLAIM_EXTRACTION_CONFIDENCE_THRESHOLD,
    eligibleTypes: [...DEFAULT_CLAIM_EXTRACTION_ELIGIBLE_TYPES],
    concurrency: DEFAULT_CLAIM_EXTRACTION_CONCURRENCY,
  };
}

/**
 * Returns the default resolved surgeon config.
 *
 * @returns Surgeon defaults used at runtime.
 */
function createDefaultSurgeonConfig(): ResolvedSurgeonConfig {
  return {
    costCap: DEFAULT_SURGEON_COST_CAP,
    dailyCostCap: DEFAULT_SURGEON_DAILY_COST_CAP,
    contextLimit: DEFAULT_SURGEON_CONTEXT_LIMIT,
    passes: {
      retirement: createDefaultRetirementPassConfig(),
    },
  };
}

/**
 * Returns the default retirement-pass config.
 *
 * @returns Retirement-pass defaults used at runtime.
 */
function createDefaultRetirementPassConfig(): ResolvedSurgeonPassConfig {
  return {
    protectRecalledDays: DEFAULT_SURGEON_RETIREMENT_PROTECT_RECALLED_DAYS,
    protectMinImportance: DEFAULT_SURGEON_RETIREMENT_PROTECT_MIN_IMPORTANCE,
    skipRecentlyEvaluatedDays: DEFAULT_SURGEON_SKIP_RECENTLY_EVALUATED_DAYS,
  };
}

/**
 * Returns whether a credentials block contains at least one secret.
 *
 * @param credentials - Candidate credentials block.
 * @returns True when the block should be persisted.
 */
function hasStoredCredentials(credentials: AgenrStoredCredentials | undefined): credentials is AgenrStoredCredentials {
  return Boolean(credentials?.openaiApiKey || credentials?.anthropicApiKey || credentials?.anthropicOauthToken);
}

/**
 * Returns whether a model override contains at least one field.
 *
 * @param value - Candidate model override.
 * @returns True when the override should be persisted.
 */
function hasModelConfig(value: ModelConfig | undefined): value is ModelConfig {
  return Boolean(value?.provider || value?.model);
}

/**
 * Returns whether a claim-extraction input block contains persisted values.
 *
 * @param value - Candidate claim-extraction block.
 * @returns True when the block should be persisted.
 */
function hasClaimExtractionInput(value: AgenrClaimExtractionConfig): boolean {
  return (
    value.enabled !== undefined ||
    value.confidenceThreshold !== undefined ||
    value.eligibleTypes !== undefined ||
    value.concurrency !== undefined ||
    hasModelConfig(value.model)
  );
}

/**
 * Returns whether a surgeon input block contains persisted values.
 *
 * @param value - Candidate surgeon block.
 * @returns True when the block should be persisted.
 */
function hasSurgeonInput(value: SurgeonConfig): boolean {
  return (
    hasModelConfig(value.model) ||
    value.costCap !== undefined ||
    value.dailyCostCap !== undefined ||
    value.contextLimit !== undefined ||
    value.customInstructions !== undefined ||
    value.passes?.retirement !== undefined
  );
}

/**
 * Converts resolved claim-extraction settings back into the sparse persisted shape.
 *
 * @param value - Resolved claim-extraction settings.
 * @returns Sparse persisted shape, or undefined when all defaults apply.
 */
function toClaimExtractionInput(value: ResolvedAgenrClaimExtractionConfig): AgenrClaimExtractionConfig | undefined {
  const input: AgenrClaimExtractionConfig = {
    ...(value.enabled !== true ? { enabled: value.enabled } : {}),
    ...(value.confidenceThreshold !== DEFAULT_CLAIM_EXTRACTION_CONFIDENCE_THRESHOLD ? { confidenceThreshold: value.confidenceThreshold } : {}),
    ...(!sameEligibleTypes(value.eligibleTypes, DEFAULT_CLAIM_EXTRACTION_ELIGIBLE_TYPES) ? { eligibleTypes: [...value.eligibleTypes] } : {}),
    ...(value.concurrency !== DEFAULT_CLAIM_EXTRACTION_CONCURRENCY ? { concurrency: value.concurrency } : {}),
    ...(hasModelConfig(value.model) ? { model: value.model } : {}),
  };

  return hasClaimExtractionInput(input) ? input : undefined;
}

/**
 * Converts resolved surgeon settings back into the sparse persisted shape.
 *
 * @param value - Resolved surgeon settings.
 * @returns Sparse persisted shape, or undefined when all defaults apply.
 */
function toSurgeonInput(value: ResolvedSurgeonConfig): SurgeonConfig | undefined {
  const retirement = value.passes.retirement;
  const retirementInput: NonNullable<NonNullable<SurgeonConfig["passes"]>["retirement"]> = {
    ...(retirement.protectRecalledDays !== DEFAULT_SURGEON_RETIREMENT_PROTECT_RECALLED_DAYS ? { protectRecalledDays: retirement.protectRecalledDays } : {}),
    ...(retirement.protectMinImportance !== DEFAULT_SURGEON_RETIREMENT_PROTECT_MIN_IMPORTANCE ? { protectMinImportance: retirement.protectMinImportance } : {}),
    ...(retirement.skipRecentlyEvaluatedDays !== DEFAULT_SURGEON_SKIP_RECENTLY_EVALUATED_DAYS
      ? { skipRecentlyEvaluatedDays: retirement.skipRecentlyEvaluatedDays }
      : {}),
  };

  const input: SurgeonConfig = {
    ...(hasModelConfig(value.model) ? { model: value.model } : {}),
    ...(value.costCap !== DEFAULT_SURGEON_COST_CAP ? { costCap: value.costCap } : {}),
    ...(value.dailyCostCap !== DEFAULT_SURGEON_DAILY_COST_CAP ? { dailyCostCap: value.dailyCostCap } : {}),
    ...(value.contextLimit !== DEFAULT_SURGEON_CONTEXT_LIMIT ? { contextLimit: value.contextLimit } : {}),
    ...(value.customInstructions ? { customInstructions: value.customInstructions } : {}),
    ...(Object.keys(retirementInput).length > 0
      ? {
          passes: {
            retirement: retirementInput,
          },
        }
      : {}),
  };

  return hasSurgeonInput(input) ? input : undefined;
}
