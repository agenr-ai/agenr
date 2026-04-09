import { authMethodToProvider, type AgenrAuthMethod, type AgenrConfigInput, type ModelConfig } from "../../../config.js";
import { formatLabel, type WizardPrompts } from "../../ui.js";
import { describeAuthMethod, formatModelRef, hasModelOverride, normalizeOptionalString, normalizeProvider, sameModelRef } from "./shared.js";
import type { SetupModelDescriptor, SetupProvider, SetupRuntime } from "./types.js";

/**
 * Setup model stages that can reuse or override the default model.
 */
export type SetupModelStageId = "extraction" | "dedup" | "episode" | "claim" | "surgeon";

/**
 * Per-stage override selections gathered during setup.
 */
export type SetupStageOverrides = Record<SetupModelStageId, ModelConfig | undefined>;

/**
 * Static metadata for one setup model stage.
 */
export interface SetupModelStageDefinition {
  /** Stable stage identifier. */
  id: SetupModelStageId;
  /** Human-readable stage label shown in prompts. */
  label: string;
  /** Summary label used in config notes. */
  summaryLabel: string;
  /**
   * Reads the current override for this stage.
   *
   * @param config - Config values to inspect.
   * @returns Current model override, or undefined when none is set.
   */
  readOverride(config: AgenrConfigInput | undefined): ModelConfig | undefined;
  /**
   * Applies one override to a config snapshot.
   *
   * @param config - Base config snapshot.
   * @param override - Stage override to persist.
   * @returns Updated config snapshot.
   */
  applyOverride(config: AgenrConfigInput, override: ModelConfig | undefined): AgenrConfigInput;
}

/**
 * Single registry for every setup model stage.
 */
// eslint-disable-next-line jsdoc/require-jsdoc
export const SETUP_MODEL_STAGES: readonly SetupModelStageDefinition[] = [
  {
    id: "extraction",
    label: "Extraction",
    summaryLabel: "Extraction override",
    readOverride: (config) => config?.extractionModel,
    applyOverride: (config, override) => ({
      ...config,
      extractionModel: override,
    }),
  },
  {
    id: "dedup",
    label: "Dedup",
    summaryLabel: "Dedup override",
    readOverride: (config) => config?.dedupModel,
    applyOverride: (config, override) => ({
      ...config,
      dedupModel: override,
    }),
  },
  {
    id: "episode",
    label: "Episode",
    summaryLabel: "Episode override",
    readOverride: (config) => config?.episodeModel,
    applyOverride: (config, override) => ({
      ...config,
      episodeModel: override,
    }),
  },
  {
    id: "claim",
    label: "Claim extraction",
    summaryLabel: "Claim extraction override",
    readOverride: (config) => config?.claimExtraction?.model,
    applyOverride: (config, override) => ({
      ...config,
      claimExtraction: buildNextClaimExtractionConfig(config.claimExtraction, override),
    }),
  },
  {
    id: "surgeon",
    label: "Surgeon",
    summaryLabel: "Surgeon override",
    readOverride: (config) => config?.surgeon?.model,
    applyOverride: (config, override) => ({
      ...config,
      surgeon: buildNextSurgeonConfig(config.surgeon, override),
    }),
  },
] as const;

/**
 * Reads the current stage overrides from one config snapshot.
 *
 * @param config - Existing config values to inspect.
 * @returns Stage overrides keyed by stage identifier.
 */
export function readSetupStageOverrides(config: AgenrConfigInput | undefined): SetupStageOverrides {
  return SETUP_MODEL_STAGES.reduce<SetupStageOverrides>(
    (overrides, stage) => ({
      ...overrides,
      [stage.id]: stage.readOverride(config),
    }),
    {
      extraction: undefined,
      dedup: undefined,
      episode: undefined,
      claim: undefined,
      surgeon: undefined,
    },
  );
}

/**
 * Applies the supplied stage overrides to one config snapshot.
 *
 * @param config - Base config snapshot.
 * @param overrides - Per-stage override selections.
 * @returns Updated config snapshot.
 */
export function applySetupStageOverrides(config: AgenrConfigInput, overrides: SetupStageOverrides): AgenrConfigInput {
  return SETUP_MODEL_STAGES.reduce((nextConfig, stage) => stage.applyOverride(nextConfig, overrides[stage.id]), config);
}

/**
 * Adds changed stage-override summary lines to one note buffer.
 *
 * @param lines - Summary lines to append to.
 * @param config - Current config values.
 * @param previousConfig - Previous config values when reconfiguring.
 * @returns Nothing.
 */
export function appendSetupStageSummaryLines(lines: string[], config: AgenrConfigInput, previousConfig?: AgenrConfigInput): void {
  for (const stage of SETUP_MODEL_STAGES) {
    const current = stage.readOverride(config);
    const previous = stage.readOverride(previousConfig);

    if (!hasModelOverride(current) && !hasModelOverride(previous)) {
      continue;
    }

    if (sameModelRef(current, previous)) {
      continue;
    }

    lines.push(formatLabel(stage.summaryLabel, hasModelOverride(current) ? formatModelRef(current) : "Use default model"));
  }
}

/**
 * Collects every explicitly configured override provider.
 *
 * @param config - Config values to inspect.
 * @returns Normalized provider identifiers in first-seen order.
 */
export function collectSetupStageProviders(config: AgenrConfigInput | undefined): string[] {
  const providers = new Set<string>();

  for (const stage of SETUP_MODEL_STAGES) {
    const provider = normalizeProvider(stage.readOverride(config)?.provider);
    if (provider) {
      providers.add(provider);
    }
  }

  return [...providers];
}

/**
 * Filters and orders the available setup models for one auth method.
 *
 * @param auth - Auth method whose model access is being resolved.
 * @param models - Full provider model list returned by pi-ai.
 * @returns Auth-aware, ordered model list shown by setup.
 */
export function filterSetupModelsForAuth(auth: AgenrAuthMethod, models: SetupModelDescriptor[]): SetupModelDescriptor[] {
  const availableById = new Map(models.map((model) => [model.id, model] as const));
  return getPreferredModelIds(auth)
    .map((modelId) => availableById.get(modelId))
    .filter((model): model is SetupModelDescriptor => model !== undefined);
}

/**
 * Resolves the auth-aware model list for one setup auth method.
 *
 * @param runtime - Setup runtime used to list provider models.
 * @param auth - Auth method being configured.
 * @returns Available models for this auth method.
 */
export function resolveSetupModelsForAuth(runtime: SetupRuntime, auth: AgenrAuthMethod): SetupModelDescriptor[] {
  const provider = authMethodToProvider(auth);
  const filtered = filterSetupModelsForAuth(auth, runtime.getModelsForProvider(provider));
  if (filtered.length === 0) {
    throw new Error(`No setup models are available for auth method "${auth}".`);
  }

  return filtered;
}

/**
 * Returns the first filtered model used during connection tests.
 *
 * @param auth - Auth method whose probe model should be selected.
 * @param runtime - Setup runtime used to list provider models.
 * @returns Model id used for connection testing.
 */
export function resolveProbeModel(auth: AgenrAuthMethod, runtime: SetupRuntime): string {
  return resolveSetupModelsForAuth(runtime, auth)[0].id;
}

/**
 * Builds the stage-override auth choices shown in the advanced override flow.
 *
 * Alternate auth profiles are only shown when setup can already resolve the
 * credentials they need at runtime.
 *
 * @param runtime - Setup runtime hooks used to probe credential availability.
 * @param defaultAuth - Default auth profile selected for the main model.
 * @param existingConfig - Existing config values used for credential probing.
 * @returns Available auth choices for task-specific overrides.
 */
export function buildStageAuthOptions(
  runtime: SetupRuntime,
  defaultAuth: AgenrAuthMethod,
  existingConfig?: AgenrConfigInput,
): Array<{ value: AgenrAuthMethod; label: string; hint?: string }> {
  const seen = new Set<AgenrAuthMethod>();
  const options: Array<{ value: AgenrAuthMethod; label: string; hint?: string }> = [];

  const push = (auth: AgenrAuthMethod, hint?: string): void => {
    if (seen.has(auth)) {
      return;
    }

    seen.add(auth);
    options.push({
      value: auth,
      label: describeAuthMethod(auth),
      ...(hint ? { hint } : {}),
    });
  };

  push(defaultAuth, "current default");

  if (defaultAuth !== "openai-api-key" && runtime.probeCredentials("openai-api-key", existingConfig).available) {
    push("openai-api-key", defaultAuth === "openai-subscription" ? "enables API-key-only OpenAI models" : "requires an OpenAI API key");
  }

  if (authMethodToProvider(defaultAuth) !== "anthropic" && runtime.probeCredentials("anthropic-api-key", existingConfig).available) {
    push("anthropic-api-key", "requires an Anthropic API key");
  }

  return options;
}

/**
 * Logs a short runtime note when an override needs different credentials.
 *
 * @param prompts - Prompt implementation used by setup.
 * @param auth - Auth profile chosen for the override.
 * @param defaultAuth - Default auth profile selected for the main model.
 * @returns Nothing.
 */
export function maybeLogStageCredentialRequirement(prompts: WizardPrompts, auth: AgenrAuthMethod, defaultAuth: AgenrAuthMethod): void {
  if (auth === defaultAuth) {
    return;
  }

  if (auth === "openai-api-key") {
    prompts.log.info("OpenAI API-key overrides use credentials.openaiApiKey or OPENAI_API_KEY at runtime.");
    return;
  }

  if (auth === "anthropic-api-key") {
    prompts.log.info("Anthropic API-key overrides use credentials.anthropicApiKey or ANTHROPIC_API_KEY at runtime.");
  }
}

/**
 * Maps an override provider back into the auth profile used to pick models for setup.
 *
 * @param provider - Override provider stored in config.
 * @param defaultAuth - Default auth profile selected for the main model.
 * @returns Matching setup auth profile, or undefined when none applies.
 */
export function resolveStageAuthChoice(provider: SetupProvider | undefined, defaultAuth: AgenrAuthMethod): AgenrAuthMethod | undefined {
  if (!provider) {
    return undefined;
  }

  if (provider === authMethodToProvider(defaultAuth)) {
    return defaultAuth;
  }

  if (provider === "openai") {
    return "openai-api-key";
  }

  if (provider === "openai-codex") {
    return "openai-subscription";
  }

  if (provider === "anthropic") {
    return authMethodToProvider(defaultAuth) === "anthropic" ? defaultAuth : "anthropic-api-key";
  }

  return undefined;
}

/**
 * Provides short display hints for model picker options.
 *
 * @param provider - Provider whose models are being shown.
 * @param modelId - Provider-local model id.
 * @param fallbackName - Optional model display name from pi-ai.
 * @returns Short hint text, or undefined when no hint is needed.
 */
export function hintForModel(provider: SetupProvider, modelId: string, fallbackName?: string): string | undefined {
  if (provider === "openai" || provider === "openai-codex") {
    if (modelId === "gpt-5.4-mini") {
      return "Recommended - strong quality/cost balance";
    }
    if (modelId === "gpt-5.4") {
      return "Higher quality, higher cost";
    }
    if (modelId === "gpt-5.4-nano") {
      return "Lower cost fallback";
    }
  }

  if (provider === "anthropic") {
    if (modelId.includes("sonnet")) {
      return "Recommended";
    }
    if (modelId.includes("opus")) {
      return "Higher quality, higher cost";
    }
    if (modelId.includes("haiku")) {
      return "Lower cost fallback";
    }
  }

  return fallbackName;
}

/**
 * Returns the ordered preferred-model list for one auth method.
 *
 * @param auth - Auth method being configured.
 * @returns Preferred model ids in display order.
 */
function getPreferredModelIds(auth: AgenrAuthMethod): readonly string[] {
  if (auth === "openai-api-key") {
    return ["gpt-5.4-mini", "gpt-5.4", "gpt-5.4-nano"];
  }

  if (auth === "openai-subscription") {
    return ["gpt-5.4-mini", "gpt-5.4"];
  }

  return ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"];
}

/**
 * Builds the persisted claim-extraction config while avoiding empty nested objects.
 *
 * @param existing - Existing claim-extraction config values.
 * @param model - Selected claim-extraction model override.
 * @returns Persistable claim-extraction config, or undefined when empty.
 */
function buildNextClaimExtractionConfig(
  existing: AgenrConfigInput["claimExtraction"] | undefined,
  model: ModelConfig | undefined,
): AgenrConfigInput["claimExtraction"] | undefined {
  if (!existing && !model) {
    return undefined;
  }

  const next = {
    ...(existing ?? {}),
    ...(model ? { model } : { model: undefined }),
  };

  return hasPersistedClaimExtractionConfig(next) ? next : undefined;
}

/**
 * Returns whether the claim-extraction config contains any persisted values.
 *
 * @param config - Candidate claim-extraction config.
 * @returns True when the config should be persisted.
 */
function hasPersistedClaimExtractionConfig(
  config: AgenrConfigInput["claimExtraction"] | undefined,
): config is NonNullable<AgenrConfigInput["claimExtraction"]> {
  if (!config) {
    return false;
  }

  return (
    hasModelOverride(config.model) ||
    config.enabled !== undefined ||
    config.confidenceThreshold !== undefined ||
    config.concurrency !== undefined ||
    (config.eligibleTypes !== undefined && config.eligibleTypes.length > 0)
  );
}

/**
 * Builds the persisted surgeon config while avoiding empty nested objects.
 *
 * @param existingSurgeon - Existing surgeon config values.
 * @param surgeonModel - Selected surgeon model override.
 * @returns Persistable surgeon config, or undefined when empty.
 */
function buildNextSurgeonConfig(
  existingSurgeon: AgenrConfigInput["surgeon"] | undefined,
  surgeonModel: ModelConfig | undefined,
): AgenrConfigInput["surgeon"] | undefined {
  if (!existingSurgeon && !surgeonModel) {
    return undefined;
  }

  const nextSurgeon = {
    ...(existingSurgeon ?? {}),
    ...(surgeonModel ? { model: surgeonModel } : { model: undefined }),
  };

  return hasPersistedSurgeonConfig(nextSurgeon) ? nextSurgeon : undefined;
}

/**
 * Returns whether the surgeon config contains any persisted values.
 *
 * @param config - Candidate surgeon config.
 * @returns True when the config should be persisted.
 */
function hasPersistedSurgeonConfig(config: AgenrConfigInput["surgeon"] | undefined): config is NonNullable<AgenrConfigInput["surgeon"]> {
  if (!config) {
    return false;
  }

  const retirementConfig = config.passes?.retirement;

  return (
    hasModelOverride(config.model) ||
    config.costCap !== undefined ||
    config.dailyCostCap !== undefined ||
    config.contextLimit !== undefined ||
    normalizeOptionalString(config.customInstructions) !== undefined ||
    retirementConfig?.protectRecalledDays !== undefined ||
    retirementConfig?.protectMinImportance !== undefined ||
    retirementConfig?.skipRecentlyEvaluatedDays !== undefined
  );
}
