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
import { hasModelConfig, parseModelConfig, parseProvider } from "./parse-model-config.js";
import { createDefaultDreamingConfig, parseDreamingConfig, toDreamingInput } from "./parse-dreaming-config.js";
import {
  authMethodToProvider,
  DEFAULT_API_PORT,
  DEFAULT_AGENR_FEATURE_FLAGS,
  DEFAULT_CLAIM_EXTRACTION_CONCURRENCY,
  DEFAULT_CLAIM_EXTRACTION_CONFIDENCE_THRESHOLD,
  DEFAULT_CLAIM_EXTRACTION_ELIGIBLE_TYPES,
  isAgenrAuthMethod,
  isDurableKind,
  sameEligibleKinds,
  type AgenrClaimExtractionConfig,
  type AgenrConfigInput,
  type AgenrStoredCredentials,
  type ResolvedAgenrClaimExtractionConfig,
  type ResolvedAgenrConfig,
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

  if ("surgeon" in value) {
    pushIssue(issues, "surgeon", 'Removed field. Rename the top-level "surgeon" block to "dreaming", then delete surgeon.');
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
 * Parses one optional list of eligible durable types.
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
    pushIssue(issues, path, "Expected an array of durable types.");
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
 * Returns whether a credentials block contains at least one secret.
 *
 * @param credentials - Candidate credentials block.
 * @returns True when the block should be persisted.
 */
function hasStoredCredentials(credentials: AgenrStoredCredentials | undefined): credentials is AgenrStoredCredentials {
  return Boolean(credentials?.openaiApiKey || credentials?.anthropicApiKey || credentials?.anthropicOauthToken);
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
