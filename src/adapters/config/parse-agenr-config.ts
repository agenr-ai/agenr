import {
  parseOptionalBoolean,
  parseOptionalIntegerInRange,
  parseOptionalTrimmedString,
  pushIssue,
  pushUnexpectedFields,
  isRecord,
  type ValidationIssue,
} from "../shared/validation.js";
import { parseFeatureFlags, toFeatureFlagInput } from "./parse-feature-flags.js";
import {
  authMethodToProvider,
  DEFAULT_API_PORT,
  DEFAULT_AGENR_FEATURE_FLAGS,
  DEFAULT_CLAIM_EXTRACTION_CONCURRENCY,
  DEFAULT_CLAIM_EXTRACTION_CONFIDENCE_THRESHOLD,
  DEFAULT_CLAIM_EXTRACTION_ELIGIBLE_TYPES,
  DEFAULT_DREAMING_CONTEXT_LIMIT_TOKENS,
  DEFAULT_DREAMING_CONTEXT_LOOKUP_MAX_NEIGHBORS,
  DEFAULT_DREAMING_DAILY_COST_CAP,
  DEFAULT_DREAMING_DEEP_INTERVAL_HOURS,
  DEFAULT_DREAMING_EXTRACT_MAX_CHUNKS,
  DEFAULT_DREAMING_EXTRACT_MAX_SESSIONS,
  DEFAULT_DREAMING_IMPORTANCE_THRESHOLD,
  DEFAULT_DREAMING_MAX_PROFILE_DURABLES,
  DEFAULT_DREAMING_MIN_INTERVAL_MINUTES,
  DEFAULT_DREAMING_PRUNE_PROTECT_MIN_IMPORTANCE,
  DEFAULT_DREAMING_PRUNE_PROTECT_RECALLED_DAYS,
  isAgenrAuthMethod,
  isAgenrProvider,
  isDurableKind,
  sameEligibleKinds,
  type AgenrClaimExtractionConfig,
  type AgenrConfigInput,
  type AgenrStoredCredentials,
  type ModelConfig,
  type ResolvedAgenrClaimExtractionConfig,
  type ResolvedAgenrConfig,
  type ResolvedDreamingConfig,
  type ResolvedDreamingPruneConfig,
  type DreamingConfig,
} from "./types.js";
import type { DurableKind } from "../../core/types.js";

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
    ...(hasModelConfig(config.crossEncoderModel) ? { crossEncoderModel: config.crossEncoderModel } : {}),
  };

  const features = toFeatureFlagInput(config.features);
  if (features) {
    input.features = features;
  }

  const claimExtraction = toClaimExtractionInput(config.claimExtraction);
  if (claimExtraction) {
    input.claimExtraction = claimExtraction;
  }

  const dreaming = toDreamingInput(config.dreaming);
  if (dreaming) {
    input.dreaming = dreaming;
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
  const dreamingDefaults = createDefaultDreamingConfig();

  if (value === undefined) {
    return {
      ok: true,
      input: {},
      resolved: {
        claimExtraction: claimDefaults,
        dreaming: dreamingDefaults,
        features: { ...DEFAULT_AGENR_FEATURE_FLAGS },
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
  const crossEncoderModel = parseModelConfig(value.crossEncoderModel, "crossEncoderModel", issues);
  const claimExtraction = parseClaimExtractionConfig(value.claimExtraction, "claimExtraction", issues);
  const dreaming = parseDreamingConfig(value.dreaming, "dreaming", issues);
  const features = parseFeatureFlags(value.features, "features", issues);
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
    ...(crossEncoderModel ? { crossEncoderModel } : {}),
    ...(claimExtraction.input ? { claimExtraction: claimExtraction.input } : {}),
    ...(dreaming.input ? { dreaming: dreaming.input } : {}),
    ...(features.input ? { features: features.input } : {}),
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
      ...(crossEncoderModel ? { crossEncoderModel } : {}),
      claimExtraction: claimExtraction.resolved,
      dreaming: dreaming.resolved,
      features: features.resolved,
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
    "crossEncoderModel",
    "claimExtraction",
    "dreaming",
    "features",
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
 * Parses the nested dreaming block.
 *
 * @param value - Raw nested value.
 * @param path - Stable issue path.
 * @param issues - Mutable issue collection.
 * @returns Canonical persisted values plus the resolved runtime block.
 */
function parseDreamingConfig(value: unknown, path: string, issues: ValidationIssue[]): { input?: DreamingConfig; resolved: ResolvedDreamingConfig } {
  const defaults = createDefaultDreamingConfig();
  if (value === undefined) {
    return { resolved: defaults };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return { resolved: defaults };
  }

  const startIndex = issues.length;
  pushUnexpectedFields(value, new Set(["model", "dailyCostCap", "contextLimitTokens", "customInstructions", "tiers", "stages", "triggers"]), path, issues);

  const model = parseModelConfig(value.model, `${path}.model`, issues);
  const dailyCostCap = parseOptionalNonNegativeNumber(value.dailyCostCap, `${path}.dailyCostCap`, issues);
  const contextLimitTokens = parseOptionalIntegerInRange(value.contextLimitTokens, `${path}.contextLimitTokens`, issues, { min: 0 });
  const customInstructions = parseOptionalTrimmedString(value.customInstructions, `${path}.customInstructions`, issues);
  const tiers = parseDreamingTiersConfig(value.tiers, `${path}.tiers`, issues);
  const stages = parseDreamingStagesConfig(value.stages, `${path}.stages`, issues);
  const triggers = parseDreamingTriggersConfig(value.triggers, `${path}.triggers`, issues);

  if (issues.length > startIndex) {
    return { resolved: defaults };
  }

  const input: DreamingConfig = {
    ...(model ? { model } : {}),
    ...(dailyCostCap !== undefined ? { dailyCostCap } : {}),
    ...(contextLimitTokens !== undefined ? { contextLimitTokens } : {}),
    ...(customInstructions ? { customInstructions } : {}),
    ...(tiers.input ? { tiers: tiers.input } : {}),
    ...(stages.input ? { stages: stages.input } : {}),
    ...(triggers.input ? { triggers: triggers.input } : {}),
  };

  return {
    ...(hasDreamingInput(input) ? { input } : {}),
    resolved: {
      ...(model ? { model } : {}),
      dailyCostCap: dailyCostCap ?? defaults.dailyCostCap,
      contextLimitTokens: contextLimitTokens ?? defaults.contextLimitTokens,
      ...(customInstructions ? { customInstructions } : {}),
      tiers: tiers.resolved,
      stages: stages.resolved,
      triggers: triggers.resolved,
    },
  };
}

/** Parses the nested dreaming tier enablement block. */
function parseDreamingTiersConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): { input?: NonNullable<DreamingConfig["tiers"]>; resolved: ResolvedDreamingConfig["tiers"] } {
  const defaults = createDefaultDreamingConfig().tiers;
  if (value === undefined) {
    return { resolved: defaults };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return { resolved: defaults };
  }

  const startIndex = issues.length;
  pushUnexpectedFields(value, new Set(["light", "standard", "deep"]), path, issues);
  const light = parseDreamingTierEnabledConfig(value.light, `${path}.light`, issues);
  const standard = parseDreamingTierEnabledConfig(value.standard, `${path}.standard`, issues);
  const deep = parseDreamingDeepTierConfig(value.deep, `${path}.deep`, issues);

  if (issues.length > startIndex) {
    return { resolved: defaults };
  }

  const input: NonNullable<DreamingConfig["tiers"]> = {
    ...(light.input ? { light: light.input } : {}),
    ...(standard.input ? { standard: standard.input } : {}),
    ...(deep.input ? { deep: deep.input } : {}),
  };

  return {
    ...(Object.keys(input).length > 0 ? { input } : {}),
    resolved: {
      light: { enabled: light.resolved.enabled ?? defaults.light.enabled },
      standard: { enabled: standard.resolved.enabled ?? defaults.standard.enabled },
      deep: {
        enabled: deep.resolved.enabled ?? defaults.deep.enabled,
        intervalHours: deep.resolved.intervalHours ?? defaults.deep.intervalHours,
      },
    },
  };
}

/** Parses enablement for one dreaming tier. */
function parseDreamingTierEnabledConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): { input?: { enabled?: boolean }; resolved: { enabled?: boolean } } {
  if (value === undefined) {
    return { resolved: {} };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return { resolved: {} };
  }

  pushUnexpectedFields(value, new Set(["enabled"]), path, issues);
  const enabled = parseOptionalBoolean(value.enabled, `${path}.enabled`, issues);
  const input = enabled !== undefined ? { enabled } : {};
  return {
    ...(Object.keys(input).length > 0 ? { input } : {}),
    resolved: input,
  };
}

/** Parses the deep dreaming tier settings. */
function parseDreamingDeepTierConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): { input?: NonNullable<NonNullable<DreamingConfig["tiers"]>["deep"]>; resolved: Partial<ResolvedDreamingConfig["tiers"]["deep"]> } {
  if (value === undefined) {
    return { resolved: {} };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return { resolved: {} };
  }

  pushUnexpectedFields(value, new Set(["enabled", "intervalHours"]), path, issues);
  const enabled = parseOptionalBoolean(value.enabled, `${path}.enabled`, issues);
  const intervalHours = parseOptionalIntegerInRange(value.intervalHours, `${path}.intervalHours`, issues, { min: 1 });
  const input: NonNullable<NonNullable<DreamingConfig["tiers"]>["deep"]> = {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(intervalHours !== undefined ? { intervalHours } : {}),
  };

  return {
    ...(Object.keys(input).length > 0 ? { input } : {}),
    resolved: input,
  };
}

/** Parses the nested dreaming stage configuration block. */
function parseDreamingStagesConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): { input?: NonNullable<DreamingConfig["stages"]>; resolved: ResolvedDreamingConfig["stages"] } {
  const defaults = createDefaultDreamingConfig().stages;
  if (value === undefined) {
    return { resolved: defaults };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return { resolved: defaults };
  }

  const startIndex = issues.length;
  pushUnexpectedFields(value, new Set(["extract", "project", "prune"]), path, issues);
  const extract = parseDreamingExtractConfig(value.extract, `${path}.extract`, issues);
  const project = parseDreamingProjectConfig(value.project, `${path}.project`, issues);
  const prune = parseDreamingPruneConfig(value.prune, `${path}.prune`, issues);

  if (issues.length > startIndex) {
    return { resolved: defaults };
  }

  const input: NonNullable<DreamingConfig["stages"]> = {
    ...(extract.input ? { extract: extract.input } : {}),
    ...(project.input ? { project: project.input } : {}),
    ...(prune.input ? { prune: prune.input } : {}),
  };

  return {
    ...(Object.keys(input).length > 0 ? { input } : {}),
    resolved: {
      extract: extract.resolved,
      project: project.resolved,
      prune: prune.resolved,
    },
  };
}

/** Parses the dreaming extract stage settings. */
function parseDreamingExtractConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): { input?: NonNullable<NonNullable<DreamingConfig["stages"]>["extract"]>; resolved: ResolvedDreamingConfig["stages"]["extract"] } {
  const defaults = createDefaultDreamingConfig().stages.extract;
  if (value === undefined) {
    return { resolved: defaults };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return { resolved: defaults };
  }

  const startIndex = issues.length;
  pushUnexpectedFields(value, new Set(["maxSessionsPerRun", "maxChunksPerSession", "contextLookup"]), path, issues);
  const maxSessionsPerRun = parseOptionalIntegerInRange(value.maxSessionsPerRun, `${path}.maxSessionsPerRun`, issues, { min: 1 });
  const maxChunksPerSession = parseOptionalIntegerInRange(value.maxChunksPerSession, `${path}.maxChunksPerSession`, issues, { min: 1 });
  const contextLookup = parseDreamingContextLookupConfig(value.contextLookup, `${path}.contextLookup`, issues);

  if (issues.length > startIndex) {
    return { resolved: defaults };
  }

  const input: NonNullable<NonNullable<DreamingConfig["stages"]>["extract"]> = {
    ...(maxSessionsPerRun !== undefined ? { maxSessionsPerRun } : {}),
    ...(maxChunksPerSession !== undefined ? { maxChunksPerSession } : {}),
    ...(contextLookup.input ? { contextLookup: contextLookup.input } : {}),
  };

  return {
    ...(Object.keys(input).length > 0 ? { input } : {}),
    resolved: {
      maxSessionsPerRun: maxSessionsPerRun ?? defaults.maxSessionsPerRun,
      maxChunksPerSession: maxChunksPerSession ?? defaults.maxChunksPerSession,
      contextLookup: contextLookup.resolved,
    },
  };
}

/** Parses context-lookup settings for dreaming extraction. */
function parseDreamingContextLookupConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): {
  input?: NonNullable<NonNullable<NonNullable<DreamingConfig["stages"]>["extract"]>["contextLookup"]>;
  resolved: ResolvedDreamingConfig["stages"]["extract"]["contextLookup"];
} {
  const defaults = createDefaultDreamingConfig().stages.extract.contextLookup;
  if (value === undefined) {
    return { resolved: defaults };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return { resolved: defaults };
  }

  pushUnexpectedFields(value, new Set(["enabled", "maxNeighborsPerCandidate"]), path, issues);
  const enabled = parseOptionalBoolean(value.enabled, `${path}.enabled`, issues);
  const maxNeighborsPerCandidate = parseOptionalIntegerInRange(value.maxNeighborsPerCandidate, `${path}.maxNeighborsPerCandidate`, issues, { min: 1 });
  const input: NonNullable<NonNullable<NonNullable<DreamingConfig["stages"]>["extract"]>["contextLookup"]> = {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(maxNeighborsPerCandidate !== undefined ? { maxNeighborsPerCandidate } : {}),
  };

  return {
    ...(Object.keys(input).length > 0 ? { input } : {}),
    resolved: {
      enabled: enabled ?? defaults.enabled,
      maxNeighborsPerCandidate: maxNeighborsPerCandidate ?? defaults.maxNeighborsPerCandidate,
    },
  };
}

/** Parses dreaming profile projection settings. */
function parseDreamingProjectConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): { input?: NonNullable<NonNullable<DreamingConfig["stages"]>["project"]>; resolved: ResolvedDreamingConfig["stages"]["project"] } {
  const defaults = createDefaultDreamingConfig().stages.project;
  if (value === undefined) {
    return { resolved: defaults };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return { resolved: defaults };
  }

  pushUnexpectedFields(value, new Set(["maxProfileDurables"]), path, issues);
  const maxProfileDurables = parseOptionalIntegerInRange(value.maxProfileDurables, `${path}.maxProfileDurables`, issues, { min: 1 });
  const input: NonNullable<NonNullable<DreamingConfig["stages"]>["project"]> = {
    ...(maxProfileDurables !== undefined ? { maxProfileDurables } : {}),
  };

  return {
    ...(Object.keys(input).length > 0 ? { input } : {}),
    resolved: {
      maxProfileDurables: maxProfileDurables ?? defaults.maxProfileDurables,
    },
  };
}

/**
 * Parses the nested `dreaming.stages.prune` block.
 *
 * @param value - Raw prune config value.
 * @param path - Stable issue path.
 * @param issues - Mutable issue collection.
 * @returns Canonical persisted values plus the resolved runtime block.
 */
function parseDreamingPruneConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): { input?: NonNullable<NonNullable<DreamingConfig["stages"]>["prune"]>; resolved: ResolvedDreamingPruneConfig } {
  const defaults = createDefaultDreamingPruneConfig();
  if (value === undefined) {
    return { resolved: defaults };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return { resolved: defaults };
  }

  const startIndex = issues.length;
  pushUnexpectedFields(value, new Set(["protectRecalledDays", "protectMinImportance"]), path, issues);

  const protectRecalledDays = parseOptionalIntegerInRange(value.protectRecalledDays, `${path}.protectRecalledDays`, issues, { min: 0 });
  const protectMinImportance = parseOptionalIntegerInRange(value.protectMinImportance, `${path}.protectMinImportance`, issues, { min: 0 });

  if (issues.length > startIndex) {
    return { resolved: defaults };
  }

  const input: NonNullable<NonNullable<DreamingConfig["stages"]>["prune"]> = {
    ...(protectRecalledDays !== undefined ? { protectRecalledDays } : {}),
    ...(protectMinImportance !== undefined ? { protectMinImportance } : {}),
  };

  return {
    ...(Object.keys(input).length > 0 ? { input } : {}),
    resolved: {
      protectRecalledDays: protectRecalledDays ?? defaults.protectRecalledDays,
      protectMinImportance: protectMinImportance ?? defaults.protectMinImportance,
    },
  };
}

/** Parses background trigger settings for dreaming. */
function parseDreamingTriggersConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): { input?: NonNullable<DreamingConfig["triggers"]>; resolved: ResolvedDreamingConfig["triggers"] } {
  const defaults = createDefaultDreamingConfig().triggers;
  if (value === undefined) {
    return { resolved: defaults };
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Expected an object.");
    return { resolved: defaults };
  }

  const startIndex = issues.length;
  pushUnexpectedFields(value, new Set(["postSessionLightDream", "importanceThreshold", "minIntervalMinutes"]), path, issues);
  const postSessionLightDream = parseOptionalBoolean(value.postSessionLightDream, `${path}.postSessionLightDream`, issues);
  const importanceThreshold = parseOptionalIntegerInRange(value.importanceThreshold, `${path}.importanceThreshold`, issues, { min: 0 });
  const minIntervalMinutes = parseOptionalIntegerInRange(value.minIntervalMinutes, `${path}.minIntervalMinutes`, issues, { min: 0 });

  if (issues.length > startIndex) {
    return { resolved: defaults };
  }

  const input: NonNullable<DreamingConfig["triggers"]> = {
    ...(postSessionLightDream !== undefined ? { postSessionLightDream } : {}),
    ...(importanceThreshold !== undefined ? { importanceThreshold } : {}),
    ...(minIntervalMinutes !== undefined ? { minIntervalMinutes } : {}),
  };

  return {
    ...(Object.keys(input).length > 0 ? { input } : {}),
    resolved: {
      postSessionLightDream: postSessionLightDream ?? defaults.postSessionLightDream,
      importanceThreshold: importanceThreshold ?? defaults.importanceThreshold,
      minIntervalMinutes: minIntervalMinutes ?? defaults.minIntervalMinutes,
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
function parseEligibleTypes(value: unknown, path: string, issues: ValidationIssue[]): DurableKind[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    pushIssue(issues, path, "Expected an array of entry types.");
    return undefined;
  }

  const normalized: DurableKind[] = [];
  const seen = new Set<DurableKind>();

  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") {
      pushIssue(issues, `${path}.${index}`, "Expected a supported entry type.");
      continue;
    }

    const trimmed = item.trim();
    if (!isDurableKind(trimmed)) {
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
 * Returns the default resolved dreaming config.
 *
 * @returns Dreaming defaults used at runtime.
 */
function createDefaultDreamingConfig(): ResolvedDreamingConfig {
  return {
    dailyCostCap: DEFAULT_DREAMING_DAILY_COST_CAP,
    contextLimitTokens: DEFAULT_DREAMING_CONTEXT_LIMIT_TOKENS,
    tiers: {
      light: { enabled: true },
      standard: { enabled: true },
      deep: { enabled: true, intervalHours: DEFAULT_DREAMING_DEEP_INTERVAL_HOURS },
    },
    stages: {
      extract: {
        maxSessionsPerRun: DEFAULT_DREAMING_EXTRACT_MAX_SESSIONS,
        maxChunksPerSession: DEFAULT_DREAMING_EXTRACT_MAX_CHUNKS,
        contextLookup: {
          enabled: true,
          maxNeighborsPerCandidate: DEFAULT_DREAMING_CONTEXT_LOOKUP_MAX_NEIGHBORS,
        },
      },
      project: { maxProfileDurables: DEFAULT_DREAMING_MAX_PROFILE_DURABLES },
      prune: createDefaultDreamingPruneConfig(),
    },
    triggers: {
      postSessionLightDream: true,
      importanceThreshold: DEFAULT_DREAMING_IMPORTANCE_THRESHOLD,
      minIntervalMinutes: DEFAULT_DREAMING_MIN_INTERVAL_MINUTES,
    },
  };
}

/**
 * Returns the default prune-stage config.
 *
 * @returns Prune-stage defaults used at runtime.
 */
function createDefaultDreamingPruneConfig(): ResolvedDreamingPruneConfig {
  return {
    protectRecalledDays: DEFAULT_DREAMING_PRUNE_PROTECT_RECALLED_DAYS,
    protectMinImportance: DEFAULT_DREAMING_PRUNE_PROTECT_MIN_IMPORTANCE,
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
 * Returns whether a dreaming input block contains persisted values.
 *
 * @param value - Candidate dreaming block.
 * @returns True when the block should be persisted.
 */
function hasDreamingInput(value: DreamingConfig): boolean {
  return (
    hasModelConfig(value.model) ||
    value.dailyCostCap !== undefined ||
    value.contextLimitTokens !== undefined ||
    value.customInstructions !== undefined ||
    value.tiers !== undefined ||
    value.stages?.extract !== undefined ||
    value.stages?.project !== undefined ||
    value.stages?.prune !== undefined ||
    value.triggers !== undefined
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
    ...(!sameEligibleKinds(value.eligibleTypes, DEFAULT_CLAIM_EXTRACTION_ELIGIBLE_TYPES) ? { eligibleTypes: [...value.eligibleTypes] } : {}),
    ...(value.concurrency !== DEFAULT_CLAIM_EXTRACTION_CONCURRENCY ? { concurrency: value.concurrency } : {}),
    ...(hasModelConfig(value.model) ? { model: value.model } : {}),
  };

  return hasClaimExtractionInput(input) ? input : undefined;
}

/**
 * Converts resolved dreaming settings back into the sparse persisted shape.
 *
 * @param value - Resolved dreaming settings.
 * @returns Sparse persisted shape, or undefined when all defaults apply.
 */
function toDreamingInput(value: ResolvedDreamingConfig): DreamingConfig | undefined {
  const tiers = value.tiers;
  const tiersInput: NonNullable<DreamingConfig["tiers"]> = {
    ...(tiers.light.enabled !== true ? { light: { enabled: tiers.light.enabled } } : {}),
    ...(tiers.standard.enabled !== true ? { standard: { enabled: tiers.standard.enabled } } : {}),
    ...(tiers.deep.enabled !== true || tiers.deep.intervalHours !== DEFAULT_DREAMING_DEEP_INTERVAL_HOURS
      ? {
          deep: {
            ...(tiers.deep.enabled !== true ? { enabled: tiers.deep.enabled } : {}),
            ...(tiers.deep.intervalHours !== DEFAULT_DREAMING_DEEP_INTERVAL_HOURS ? { intervalHours: tiers.deep.intervalHours } : {}),
          },
        }
      : {}),
  };

  const extract = value.stages.extract;
  const contextLookup = extract.contextLookup;
  const contextLookupInput: NonNullable<NonNullable<NonNullable<DreamingConfig["stages"]>["extract"]>["contextLookup"]> = {
    ...(contextLookup.enabled !== true ? { enabled: contextLookup.enabled } : {}),
    ...(contextLookup.maxNeighborsPerCandidate !== DEFAULT_DREAMING_CONTEXT_LOOKUP_MAX_NEIGHBORS
      ? { maxNeighborsPerCandidate: contextLookup.maxNeighborsPerCandidate }
      : {}),
  };
  const extractInput: NonNullable<NonNullable<DreamingConfig["stages"]>["extract"]> = {
    ...(extract.maxSessionsPerRun !== DEFAULT_DREAMING_EXTRACT_MAX_SESSIONS ? { maxSessionsPerRun: extract.maxSessionsPerRun } : {}),
    ...(extract.maxChunksPerSession !== DEFAULT_DREAMING_EXTRACT_MAX_CHUNKS ? { maxChunksPerSession: extract.maxChunksPerSession } : {}),
    ...(Object.keys(contextLookupInput).length > 0 ? { contextLookup: contextLookupInput } : {}),
  };

  const project = value.stages.project;
  const projectInput: NonNullable<NonNullable<DreamingConfig["stages"]>["project"]> = {
    ...(project.maxProfileDurables !== DEFAULT_DREAMING_MAX_PROFILE_DURABLES ? { maxProfileDurables: project.maxProfileDurables } : {}),
  };

  const prune = value.stages.prune;
  const pruneInput: NonNullable<NonNullable<DreamingConfig["stages"]>["prune"]> = {
    ...(prune.protectRecalledDays !== DEFAULT_DREAMING_PRUNE_PROTECT_RECALLED_DAYS ? { protectRecalledDays: prune.protectRecalledDays } : {}),
    ...(prune.protectMinImportance !== DEFAULT_DREAMING_PRUNE_PROTECT_MIN_IMPORTANCE ? { protectMinImportance: prune.protectMinImportance } : {}),
  };

  const triggers = value.triggers;
  const triggersInput: NonNullable<DreamingConfig["triggers"]> = {
    ...(triggers.postSessionLightDream !== true ? { postSessionLightDream: triggers.postSessionLightDream } : {}),
    ...(triggers.importanceThreshold !== DEFAULT_DREAMING_IMPORTANCE_THRESHOLD ? { importanceThreshold: triggers.importanceThreshold } : {}),
    ...(triggers.minIntervalMinutes !== DEFAULT_DREAMING_MIN_INTERVAL_MINUTES ? { minIntervalMinutes: triggers.minIntervalMinutes } : {}),
  };

  const stagesInput: NonNullable<DreamingConfig["stages"]> = {
    ...(Object.keys(extractInput).length > 0 ? { extract: extractInput } : {}),
    ...(Object.keys(projectInput).length > 0 ? { project: projectInput } : {}),
    ...(Object.keys(pruneInput).length > 0 ? { prune: pruneInput } : {}),
  };

  const input: DreamingConfig = {
    ...(hasModelConfig(value.model) ? { model: value.model } : {}),
    ...(value.dailyCostCap !== DEFAULT_DREAMING_DAILY_COST_CAP ? { dailyCostCap: value.dailyCostCap } : {}),
    ...(value.contextLimitTokens !== DEFAULT_DREAMING_CONTEXT_LIMIT_TOKENS ? { contextLimitTokens: value.contextLimitTokens } : {}),
    ...(value.customInstructions ? { customInstructions: value.customInstructions } : {}),
    ...(Object.keys(tiersInput).length > 0 ? { tiers: tiersInput } : {}),
    ...(Object.keys(stagesInput).length > 0 ? { stages: stagesInput } : {}),
    ...(Object.keys(triggersInput).length > 0 ? { triggers: triggersInput } : {}),
  };

  return hasDreamingInput(input) ? input : undefined;
}
