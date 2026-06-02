import { EMBEDDING_MODEL } from "../../../adapters/embeddings.js";
import { authMethodToProvider, getAuthMethodDefinition, type AgenrAuthMethod, type AgenrConfigInput, type ModelConfig } from "../../../config.js";
import { cliPrompts, resolveUserPath, ui, type WizardPrompts } from "../../ui.js";
import { buildNextConfig, formatSavedConfigSummary } from "./config.js";
import {
  buildStageAuthOptions,
  hintForModel,
  maybeLogStageCredentialRequirement,
  readSetupStageOverrides,
  resolveProbeModel,
  resolveSetupModelsForAuth,
  resolveStageAuthChoice,
  SETUP_MODEL_STAGES,
  type SetupModelStageDefinition,
  type SetupStageOverrides,
} from "./stages.js";
import {
  describeAuthMethod,
  formatModelRef,
  manualCredentialLabel,
  normalizeAuthMethod,
  normalizeOptionalString,
  normalizeProvider,
  promptForManualCredential,
  resolveStoredCredentialForAuth,
  resolveStoredEmbeddingCredential,
  validateSecret,
} from "./shared.js";
import type { SetupCoreOptions, SetupCoreResult, SetupRuntime } from "./types.js";

const PRIMARY_AUTH_METHODS: readonly AgenrAuthMethod[] = ["openai-api-key", "anthropic-api-key"];
const ADVANCED_AUTH_METHODS: readonly AgenrAuthMethod[] = ["anthropic-oauth", "anthropic-token", "openai-subscription"];

/**
 * Runs the reusable interactive setup flow without banner/outro handling.
 *
 * @param options - Existing config, prompts, and runtime hooks.
 * @returns Saved config details, or `null` when the user cancels.
 */
export async function runSetupCore(options: SetupCoreOptions = {}): Promise<SetupCoreResult | null> {
  const prompts = options.prompts ?? cliPrompts;
  const runtime = options.runtime;
  if (!runtime) {
    throw new Error("runSetupCore requires a setup runtime.");
  }

  const existingConfig = options.existingConfig;
  const configPath = runtime.resolveConfigPath();

  const auth = await selectAuthMethod(prompts, normalizeAuthMethod(existingConfig?.auth));
  if (auth === null) {
    return null;
  }

  prompts.log.info(getAuthMethodDefinition(auth).setupDescription);

  const provider = authMethodToProvider(auth);
  const probeModel = resolveProbeModel(auth, runtime);
  const primaryCredential = await preparePrimaryCredential(prompts, runtime, auth, existingConfig, provider, probeModel);
  if (primaryCredential === null) {
    return null;
  }

  const model = await selectAuthModel(prompts, runtime, auth, existingConfig?.model);
  if (model === null) {
    return null;
  }

  const embeddingUsesPrimaryKey = auth === "openai-api-key";
  let embeddingApiKey: string | undefined;

  if (embeddingUsesPrimaryKey) {
    if (!primaryCredential.apiKey) {
      throw new Error("OpenAI API-key auth requires a primary credential.");
    }

    const embeddingResult = await verifySharedEmbeddingKey(prompts, runtime, primaryCredential.apiKey);
    if (embeddingResult === null) {
      return null;
    }
  } else {
    prompts.log.info(`Embeddings use OpenAI ${EMBEDDING_MODEL} and need a separate OpenAI API key.`);
    const selectedEmbeddingKey = await promptEmbeddingApiKey(prompts, existingConfig);
    if (selectedEmbeddingKey === null) {
      return null;
    }

    const verifiedEmbeddingKey = await verifySeparateEmbeddingKey(prompts, runtime, selectedEmbeddingKey);
    if (verifiedEmbeddingKey === null) {
      return null;
    }

    embeddingApiKey = verifiedEmbeddingKey.apiKey;
  }

  const stageOverrides = await promptTaskModelOverrides(prompts, runtime, {
    defaultAuth: auth,
    defaultModel: model,
    existingConfig,
  });
  if (stageOverrides === null) {
    return null;
  }

  const defaultDbPath = normalizeOptionalString(existingConfig?.dbPath) ?? runtime.resolveDbPath(existingConfig);
  const dbPathInput = await prompts.text({
    message: "Database path:",
    initialValue: defaultDbPath,
    placeholder: defaultDbPath,
    validate: (value) => (value?.trim().length ? undefined : "Database path cannot be empty."),
  });

  if (prompts.isCancel(dbPathInput)) {
    return null;
  }

  const dbPath = resolveUserPath(dbPathInput);
  const nextConfig = buildNextConfig(existingConfig, {
    auth,
    provider,
    model,
    primaryCredential: primaryCredential.shouldPersist ? primaryCredential.apiKey : undefined,
    embeddingApiKey,
    stageOverrides,
    dbPath,
    populateAllFeatures: options.populateAllFeatures,
  });
  const readiness = runtime.getSetupReadiness(nextConfig);
  const ready = readiness.ready;

  runtime.writeConfig(nextConfig);

  prompts.note(
    formatSavedConfigSummary(nextConfig, configPath, dbPath, {
      embeddingUsesPrimaryKey,
      previousConfig: existingConfig,
      ready,
      pendingCredentialGuidance: readiness.guidance,
    }),
    "Configuration saved",
  );

  return {
    config: nextConfig,
    configPath,
    dbPath,
    auth,
    provider,
    model,
    embeddingUsesPrimaryKey,
    ready,
    ...(readiness.guidance ? { readinessGuidance: readiness.guidance } : {}),
  };
}

/**
 * Internal credential result used while collecting setup inputs.
 */
interface SelectedPrimaryCredential {
  /**
   * Credential string used for verification and runtime access.
   */
  apiKey?: string;
  /**
   * Whether the credential should be written into agenr config.
   */
  shouldPersist: boolean;
}

/**
 * Prompts for the auth method, including the advanced submenu.
 *
 * @param prompts - Prompt implementation used by setup.
 * @param existingAuth - Existing auth method used for defaults.
 * @returns Selected auth method, or `null` when cancelled.
 */
async function selectAuthMethod(prompts: WizardPrompts, existingAuth?: AgenrAuthMethod): Promise<AgenrAuthMethod | null> {
  while (true) {
    const primarySelection = await prompts.select<AgenrAuthMethod | "advanced-options">({
      message: "How would you like to authenticate?",
      options: [
        {
          value: "openai-api-key",
          label: describeAuthMethod("openai-api-key"),
          hint: "recommended for first-run setup",
        },
        {
          value: "anthropic-api-key",
          label: describeAuthMethod("anthropic-api-key"),
        },
        {
          value: "advanced-options",
          label: "Advanced options...",
        },
      ],
      initialValue: PRIMARY_AUTH_METHODS.includes(existingAuth ?? "openai-api-key") ? existingAuth : "openai-api-key",
    });

    if (prompts.isCancel(primarySelection)) {
      return null;
    }

    if (primarySelection !== "advanced-options") {
      return primarySelection;
    }

    const advancedSelection = await prompts.select<AgenrAuthMethod | "back">({
      message: "Advanced authentication:",
      options: [
        {
          value: "anthropic-oauth",
          label: describeAuthMethod("anthropic-oauth"),
          hint: "subscription credentials from Claude Code",
        },
        {
          value: "anthropic-token",
          label: describeAuthMethod("anthropic-token"),
        },
        {
          value: "openai-subscription",
          label: describeAuthMethod("openai-subscription"),
          hint: "subscription credentials from Codex CLI",
        },
        {
          value: "back",
          label: "Back",
        },
      ],
      initialValue: ADVANCED_AUTH_METHODS.includes(existingAuth ?? "anthropic-oauth") ? existingAuth : "anthropic-oauth",
    });

    if (prompts.isCancel(advancedSelection)) {
      return null;
    }

    if (advancedSelection === "back") {
      continue;
    }

    return advancedSelection;
  }
}

/**
 * Collects the primary extraction credential for the selected auth method.
 *
 * @param prompts - Prompt implementation used by setup.
 * @param runtime - Setup runtime hooks.
 * @param auth - Selected auth method.
 * @param existingConfig - Existing config values used for reuse prompts.
 * @param provider - Provider selected for the default model.
 * @param probeModel - Probe model used for connection testing.
 * @returns Selected credential details, or `null` when cancelled.
 */
async function preparePrimaryCredential(
  prompts: WizardPrompts,
  runtime: SetupRuntime,
  auth: AgenrAuthMethod,
  existingConfig: AgenrConfigInput | undefined,
  provider: SetupCoreResult["provider"],
  probeModel: string,
): Promise<SelectedPrimaryCredential | null> {
  if (authRequiresManualCredential(auth)) {
    const initialCredential = await promptManualCredential(prompts, auth, existingConfig);
    if (initialCredential === null) {
      return null;
    }

    const verified = await verifyManualPrimaryCredential(prompts, runtime, auth, provider, initialCredential, probeModel);
    if (verified === null) {
      return null;
    }

    return {
      apiKey: verified.apiKey,
      shouldPersist: true,
    };
  }

  const probe = runtime.probeCredentials(auth, existingConfig);
  if (!probe.available || !probe.credentials) {
    prompts.log.warn(probe.guidance);
    return {
      shouldPersist: false,
    };
  }

  prompts.log.info(`Detected credentials from ${probe.source ?? "an external credential store"}.`);
  const verified = await verifyDetectedPrimaryCredential(prompts, runtime, auth, provider, probe.credentials.apiKey, probeModel);
  if (verified === null) {
    return null;
  }

  return {
    apiKey: verified.apiKey,
    shouldPersist: false,
  };
}

/**
 * Returns whether one auth method expects a manually entered credential.
 *
 * @param auth - Auth method being configured.
 * @returns True when setup should prompt for a secret.
 */
function authRequiresManualCredential(auth: AgenrAuthMethod): boolean {
  return auth === "openai-api-key" || auth === "anthropic-api-key" || auth === "anthropic-token";
}

/**
 * Prompts for a manually entered primary credential, optionally reusing config.
 *
 * @param prompts - Prompt implementation used by setup.
 * @param auth - Auth method being configured.
 * @param existingConfig - Existing config values used for reuse prompts.
 * @returns Credential string, or `null` when cancelled.
 */
async function promptManualCredential(prompts: WizardPrompts, auth: AgenrAuthMethod, existingConfig?: AgenrConfigInput): Promise<string | null> {
  const existingCredential = resolveStoredCredentialForAuth(existingConfig, auth);
  if (existingCredential) {
    const useExisting = await prompts.confirm({
      message: `Use the existing ${manualCredentialLabel(auth)} from config?`,
      initialValue: true,
    });

    if (prompts.isCancel(useExisting)) {
      return null;
    }

    if (useExisting) {
      return existingCredential;
    }
  }

  const apiKey = await prompts.password({
    message: promptForManualCredential(auth),
    validate: validateSecret,
  });

  if (prompts.isCancel(apiKey)) {
    return null;
  }

  return apiKey.trim();
}

/**
 * Prompts for the separate OpenAI embedding key when the auth method needs one.
 *
 * @param prompts - Prompt implementation used by setup.
 * @param existingConfig - Existing config values used for reuse prompts.
 * @returns Embedding API key, or `null` when cancelled.
 */
async function promptEmbeddingApiKey(prompts: WizardPrompts, existingConfig?: AgenrConfigInput): Promise<string | null> {
  const existingEmbeddingKey = resolveStoredEmbeddingCredential(existingConfig);
  if (existingEmbeddingKey) {
    const useExisting = await prompts.confirm({
      message: "Use the existing OpenAI embedding API key from config?",
      initialValue: true,
    });

    if (prompts.isCancel(useExisting)) {
      return null;
    }

    if (useExisting) {
      return existingEmbeddingKey;
    }
  }

  const embeddingKey = await prompts.password({
    message: "Enter OpenAI API key for embeddings:",
    validate: validateSecret,
  });

  if (prompts.isCancel(embeddingKey)) {
    return null;
  }

  return embeddingKey.trim();
}

/**
 * Lets the user pick the default model for the selected auth method.
 *
 * @param prompts - Prompt implementation used by setup.
 * @param runtime - Setup runtime hooks.
 * @param auth - Auth method being configured.
 * @param existingModel - Existing model used for defaults.
 * @returns Selected model id, or `null` when cancelled.
 */
async function selectAuthModel(prompts: WizardPrompts, runtime: SetupRuntime, auth: AgenrAuthMethod, existingModel?: string): Promise<string | null> {
  const provider = authMethodToProvider(auth);
  const models = resolveSetupModelsForAuth(runtime, auth);
  const options = models.map((model) => ({
    value: model.id,
    label: model.id,
    hint: hintForModel(provider, model.id, model.name),
  }));

  const initialValue = options.some((option) => option.value === existingModel) ? existingModel : models[0]?.id;
  if (!initialValue) {
    throw new Error(`No setup models are available for auth method "${auth}".`);
  }

  const selected = await prompts.select<string>({
    message: "Choose your default model:",
    options,
    initialValue,
  });

  if (prompts.isCancel(selected)) {
    return null;
  }

  return selected;
}

/**
 * Verifies a manually entered credential, allowing re-entry, retry, or skip.
 *
 * @param prompts - Prompt implementation used by setup.
 * @param runtime - Setup runtime hooks.
 * @param auth - Auth method being verified.
 * @param provider - Provider selected for the default model.
 * @param initialApiKey - Initial credential value.
 * @param probeModel - Probe model used for connection testing.
 * @returns Verification outcome, or `null` when cancelled.
 */
async function verifyManualPrimaryCredential(
  prompts: WizardPrompts,
  runtime: SetupRuntime,
  auth: AgenrAuthMethod,
  provider: SetupCoreResult["provider"],
  initialApiKey: string,
  probeModel: string,
): Promise<{ apiKey: string; verified: boolean } | null> {
  let apiKey = initialApiKey;

  while (true) {
    const spinner = prompts.spinner();
    spinner.start(`Testing ${describeAuthMethod(auth)}...`);
    const result = await runtime.testLlmConnection(provider, probeModel, apiKey);

    if (result.ok) {
      spinner.stop(ui.success("Connection verified"));
      return { apiKey, verified: true };
    }

    spinner.stop(ui.error(`Connection failed: ${result.error ?? "unknown error"}`));
    const action = await prompts.select<"reenter" | "retry" | "skip">({
      message: "The provider connection test failed. What do you want to do?",
      options: [
        { value: "reenter", label: "Enter a new credential", hint: "recommended" },
        { value: "retry", label: "Retry the test" },
        { value: "skip", label: "Skip the test for now" },
      ],
    });

    if (prompts.isCancel(action)) {
      return null;
    }

    if (action === "skip") {
      prompts.log.warn("Skipping the provider connection test. You can verify it later by running a recall or ingest command.");
      return { apiKey, verified: false };
    }

    if (action === "retry") {
      continue;
    }

    const replacement = await prompts.password({
      message: promptForManualCredential(auth),
      validate: validateSecret,
    });

    if (prompts.isCancel(replacement)) {
      return null;
    }

    apiKey = replacement.trim();
  }
}

/**
 * Verifies an auto-detected credential, allowing retry or skip.
 *
 * @param prompts - Prompt implementation used by setup.
 * @param runtime - Setup runtime hooks.
 * @param auth - Auth method being verified.
 * @param provider - Provider selected for the default model.
 * @param apiKey - Detected credential value.
 * @param probeModel - Probe model used for connection testing.
 * @returns Verification outcome, or `null` when cancelled.
 */
async function verifyDetectedPrimaryCredential(
  prompts: WizardPrompts,
  runtime: SetupRuntime,
  auth: AgenrAuthMethod,
  provider: SetupCoreResult["provider"],
  apiKey: string,
  probeModel: string,
): Promise<{ apiKey: string; verified: boolean } | null> {
  while (true) {
    const spinner = prompts.spinner();
    spinner.start(`Testing ${describeAuthMethod(auth)}...`);
    const result = await runtime.testLlmConnection(provider, probeModel, apiKey);

    if (result.ok) {
      spinner.stop(ui.success("Connection verified"));
      return { apiKey, verified: true };
    }

    spinner.stop(ui.error(`Connection failed: ${result.error ?? "unknown error"}`));
    const action = await prompts.select<"retry" | "skip">({
      message: "The provider connection test failed. What do you want to do?",
      options: [
        { value: "retry", label: "Retry the test", hint: "recommended" },
        { value: "skip", label: "Skip the test for now" },
      ],
    });

    if (prompts.isCancel(action)) {
      return null;
    }

    if (action === "skip") {
      prompts.log.warn("Skipping the provider connection test. You can verify it later by running a recall or ingest command.");
      return { apiKey, verified: false };
    }
  }
}

/**
 * Verifies embeddings when the same OpenAI key is reused.
 *
 * @param prompts - Prompt implementation used by setup.
 * @param runtime - Setup runtime hooks.
 * @param apiKey - Shared OpenAI API key.
 * @returns Verification outcome, or `null` when cancelled.
 */
async function verifySharedEmbeddingKey(prompts: WizardPrompts, runtime: SetupRuntime, apiKey: string): Promise<{ verified: boolean } | null> {
  while (true) {
    const spinner = prompts.spinner();
    spinner.start(`Testing embeddings with OpenAI ${EMBEDDING_MODEL}...`);
    const result = await runtime.testEmbeddingConnection(apiKey, EMBEDDING_MODEL);

    if (result.ok) {
      spinner.stop(ui.success("Embeddings verified"));
      return { verified: true };
    }

    spinner.stop(ui.error(`Embeddings test failed: ${result.error ?? "unknown error"}`));
    const action = await prompts.select<"retry" | "skip">({
      message: "The embeddings test failed. What do you want to do?",
      options: [
        { value: "retry", label: "Retry the test", hint: "recommended" },
        { value: "skip", label: "Skip the test for now" },
      ],
    });

    if (prompts.isCancel(action)) {
      return null;
    }

    if (action === "skip") {
      prompts.log.warn("Skipping the embeddings test. OpenAI embeddings can be verified later during ingest.");
      return { verified: false };
    }
  }
}

/**
 * Verifies embeddings when setup collects a separate OpenAI key.
 *
 * @param prompts - Prompt implementation used by setup.
 * @param runtime - Setup runtime hooks.
 * @param initialApiKey - Initial embedding key value.
 * @returns Verification outcome, or `null` when cancelled.
 */
async function verifySeparateEmbeddingKey(
  prompts: WizardPrompts,
  runtime: SetupRuntime,
  initialApiKey: string,
): Promise<{ apiKey: string; verified: boolean } | null> {
  let apiKey = initialApiKey;

  while (true) {
    const spinner = prompts.spinner();
    spinner.start(`Testing embeddings with OpenAI ${EMBEDDING_MODEL}...`);
    const result = await runtime.testEmbeddingConnection(apiKey, EMBEDDING_MODEL);

    if (result.ok) {
      spinner.stop(ui.success("Embeddings verified"));
      return { apiKey, verified: true };
    }

    spinner.stop(ui.error(`Embeddings test failed: ${result.error ?? "unknown error"}`));
    const action = await prompts.select<"reenter" | "retry" | "skip">({
      message: "The embeddings test failed. What do you want to do?",
      options: [
        { value: "reenter", label: "Enter a new OpenAI key", hint: "recommended" },
        { value: "retry", label: "Retry the test" },
        { value: "skip", label: "Skip the test for now" },
      ],
    });

    if (prompts.isCancel(action)) {
      return null;
    }

    if (action === "skip") {
      prompts.log.warn("Skipping the embeddings test. OpenAI embeddings can be verified later during ingest.");
      return { apiKey, verified: false };
    }

    if (action === "retry") {
      continue;
    }

    const replacement = await prompts.password({
      message: "Enter OpenAI API key for embeddings:",
      validate: validateSecret,
    });

    if (prompts.isCancel(replacement)) {
      return null;
    }

    apiKey = replacement.trim();
  }
}

/**
 * Prompts for optional task-specific model overrides.
 *
 * @param prompts - Prompt implementation used by setup.
 * @param runtime - Setup runtime hooks.
 * @param options - Default model context plus existing config values.
 * @returns Per-stage override selections, or `null` when cancelled.
 */
async function promptTaskModelOverrides(
  prompts: WizardPrompts,
  runtime: SetupRuntime,
  options: {
    defaultAuth: AgenrAuthMethod;
    defaultModel: string;
    existingConfig?: AgenrConfigInput;
  },
): Promise<SetupStageOverrides | null> {
  const customize = await prompts.confirm({
    message: "Customize task-specific models? (Advanced)",
    initialValue: false,
  });

  if (prompts.isCancel(customize)) {
    return null;
  }

  if (!customize) {
    return readSetupStageOverrides(options.existingConfig);
  }

  const stageOverrides = readSetupStageOverrides(options.existingConfig);

  for (const stage of SETUP_MODEL_STAGES) {
    const override = await promptStageOverride(prompts, runtime, {
      stage,
      defaultAuth: options.defaultAuth,
      defaultModel: options.defaultModel,
      current: stageOverrides[stage.id],
      existingConfig: options.existingConfig,
    });
    if (override === null) {
      return null;
    }

    stageOverrides[stage.id] = override;
  }

  return stageOverrides;
}

/**
 * Prompts for one stage-specific provider/model override.
 *
 * @param prompts - Prompt implementation used by setup.
 * @param runtime - Setup runtime hooks.
 * @param options - Stage metadata plus default and existing values.
 * @returns Selected override, `undefined` for default, or `null` when cancelled.
 */
async function promptStageOverride(
  prompts: WizardPrompts,
  runtime: SetupRuntime,
  options: {
    stage: SetupModelStageDefinition;
    defaultAuth: AgenrAuthMethod;
    defaultModel: string;
    current?: ModelConfig;
    existingConfig?: AgenrConfigInput;
  },
): Promise<ModelConfig | undefined | null> {
  const defaultRef = `${describeAuthMethod(options.defaultAuth)} / ${options.defaultModel}`;
  const currentProvider = normalizeProvider(options.current?.provider);
  const currentModel = normalizeOptionalString(options.current?.model) ?? options.defaultModel;
  const currentAuth = resolveStageAuthChoice(currentProvider, options.defaultAuth);
  const hasExplicitOverride = normalizeOptionalString(options.current?.provider) !== undefined || normalizeOptionalString(options.current?.model) !== undefined;

  const action = await prompts.select<"default" | "custom">({
    message: `${options.stage.label} model override:`,
    options: [
      {
        value: "default",
        label: `Use default (${defaultRef})`,
      },
      {
        value: "custom",
        label: hasExplicitOverride && options.current ? `Update override (${formatModelRef(options.current)})` : "Set a custom override",
      },
    ],
    initialValue: hasExplicitOverride ? "custom" : "default",
  });

  if (prompts.isCancel(action)) {
    return null;
  }

  if (action === "default") {
    return undefined;
  }

  const authOptions = buildStageAuthOptions(runtime, options.defaultAuth, options.existingConfig);
  let auth: AgenrAuthMethod;
  if (authOptions.length === 1) {
    auth = authOptions[0].value;
  } else {
    const selectedAuth = await prompts.select<AgenrAuthMethod>({
      message: `Choose the ${options.stage.label.toLowerCase()} auth profile:`,
      options: authOptions,
      initialValue: authOptions.some((option) => option.value === currentAuth) ? currentAuth : options.defaultAuth,
    });

    if (prompts.isCancel(selectedAuth)) {
      return null;
    }

    auth = selectedAuth;
  }

  maybeLogStageCredentialRequirement(prompts, auth, options.defaultAuth);

  const model = await selectAuthModel(prompts, runtime, auth, currentModel);
  if (model === null) {
    return null;
  }

  const provider = authMethodToProvider(auth);
  if (provider === authMethodToProvider(options.defaultAuth) && model === options.defaultModel) {
    return undefined;
  }

  return {
    provider,
    model,
  };
}
