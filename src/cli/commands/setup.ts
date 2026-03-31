import { getModels } from "@mariozechner/pi-ai";
import type { Command } from "commander";

import { EMBEDDING_MODEL, createEmbeddingClient, resolveEmbeddingApiKey } from "../../adapters/embeddings.js";
import { createLlmClient, probeLlmCredentials, resolveLlmCredentials, resolveModel, type LlmCredentialProbeResult } from "../../adapters/llm.js";
import {
  authMethodToProvider,
  getAuthMethodDefinition,
  type AgenrAuthMethod,
  type AgenrConfig,
  type AgenrProvider,
  type AgenrStoredCredentials,
  type ModelConfig,
  configFileExists,
  readConfig,
  resolveConfigPath,
  resolveDbPath,
  writeConfig,
} from "../../config.js";
import { banner, cliPrompts, formatLabel, formatPathForDisplay, resolveUserPath, ui, type WizardPrompts } from "../ui.js";

const CONNECTION_TEST_TIMEOUT_MS = 5_000;
const PRIMARY_AUTH_METHODS: readonly AgenrAuthMethod[] = ["openai-api-key", "anthropic-api-key"];
const ADVANCED_AUTH_METHODS: readonly AgenrAuthMethod[] = ["anthropic-oauth", "anthropic-token", "openai-subscription"];

/**
 * Providers exposed by setup and init helpers.
 */
export type SetupProvider = AgenrProvider;

/**
 * Model metadata shown in setup model pickers.
 */
export interface SetupModelDescriptor {
  /** Provider-local model identifier. */
  id: string;
  /** Human-readable model name. */
  name?: string;
}

/**
 * Result returned by LLM and embedding connection tests.
 */
export interface ConnectionTestResult {
  /** Whether the test succeeded. */
  ok: boolean;
  /** Optional human-readable error when the test failed. */
  error?: string;
}

/**
 * Runtime hooks used by the setup flow for testability.
 */
export interface SetupRuntime {
  /** Resolves the effective config file path. */
  resolveConfigPath(): string;
  /** Resolves the effective database path. */
  resolveDbPath(config?: AgenrConfig): string;
  /** Persists the updated config. */
  writeConfig(config: AgenrConfig): void;
  /** Lists available models for one setup provider. */
  getModelsForProvider(provider: SetupProvider): SetupModelDescriptor[];
  /** Probes credentials for one auth method. */
  probeCredentials(auth: AgenrAuthMethod, config?: AgenrConfig): LlmCredentialProbeResult;
  /** Verifies that the chosen LLM credential works. */
  testLlmConnection(provider: SetupProvider, modelId: string, apiKey: string): Promise<ConnectionTestResult>;
  /** Verifies that the embedding credential works. */
  testEmbeddingConnection(apiKey: string, modelId: string): Promise<ConnectionTestResult>;
  /** Explains whether the saved config can run agenr commands immediately. */
  getSetupReadiness(config: AgenrConfig): { ready: boolean; guidance?: string };
}

/**
 * Options for the reusable setup core flow.
 */
export interface SetupCoreOptions {
  /** Existing config values used for defaults and key reuse prompts. */
  existingConfig?: AgenrConfig;
  /** Prompt implementation used by the interactive flow. */
  prompts?: WizardPrompts;
  /** Runtime dependencies used by the interactive flow. */
  runtime?: SetupRuntime;
}

/**
 * Successful result from the setup core flow.
 */
export interface SetupCoreResult {
  /** Persisted agenr config. */
  config: AgenrConfig;
  /** Config file path written by setup. */
  configPath: string;
  /** Database path stored in the config. */
  dbPath: string;
  /** Selected auth method. */
  auth: AgenrAuthMethod;
  /** Selected default provider. */
  provider: SetupProvider;
  /** Selected default model. */
  model: string;
  /** Whether embeddings reuse the primary OpenAI key. */
  embeddingUsesPrimaryKey: boolean;
  /** Whether the saved config can run agenr commands immediately. */
  ready: boolean;
  /** Human-readable blocker when the saved config is not ready yet. */
  readinessGuidance?: string;
}

/** Internal credential result used while collecting setup inputs. */
interface SelectedPrimaryCredential {
  /** Credential string used for verification and runtime access. */
  apiKey?: string;
  /** Whether the credential should be written into agenr config. */
  shouldPersist: boolean;
}

const defaultSetupRuntime: SetupRuntime = {
  resolveConfigPath: () => resolveConfigPath(),
  resolveDbPath: (config) => resolveDbPath(config),
  writeConfig: (config) => writeConfig(config),
  getModelsForProvider: (provider) =>
    getModels(provider)
      .map((model) => ({
        id: model.id,
        name: model.name,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  probeCredentials: (auth, config) =>
    probeLlmCredentials({
      auth,
      storedCredentials: config?.credentials,
    }),
  testLlmConnection: async (provider, modelId, apiKey) => {
    try {
      const client = createLlmClient(provider, modelId, { apiKey });
      await withTimeout(
        client.complete("You are a connection test. Reply with OK.", "Reply with OK."),
        CONNECTION_TEST_TIMEOUT_MS,
        "LLM connection test timed out.",
      );
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: formatUnknownError(error),
      };
    }
  },
  testEmbeddingConnection: async (apiKey, modelId) => {
    try {
      const client = createEmbeddingClient(apiKey, modelId);
      const vectors = await withTimeout(client.embed(["connection test"]), CONNECTION_TEST_TIMEOUT_MS, "Embedding connection test timed out.");
      if (vectors.length !== 1 || vectors[0] === undefined || vectors[0].length === 0) {
        return { ok: false, error: "Embedding API returned an empty vector." };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: formatUnknownError(error),
      };
    }
  },
  getSetupReadiness: (config) => getSetupReadiness(config),
};

/**
 * Registers the `agenr setup` command.
 *
 * @param program - Root Commander program to extend.
 */
export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Configure auth, models, embeddings, and the agenr database path")
    .action(async () => {
      await runSetupCommand();
    });
}

/**
 * Runs the full `agenr setup` command, including existing-config detection.
 */
export async function runSetupCommand(): Promise<void> {
  const prompts = cliPrompts;
  const runtime = defaultSetupRuntime;
  prompts.intro(banner());

  try {
    const existingConfigPath = runtime.resolveConfigPath();
    const existingConfig = readConfig();
    const hasExistingConfig = configFileExists();

    if (hasExistingConfig) {
      const summary = formatExistingConfig(existingConfig, existingConfigPath, runtime.resolveDbPath(existingConfig));
      prompts.note(summary, "Current config");

      const reconfigure = await prompts.confirm({
        message: "Reconfigure agenr now?",
        initialValue: true,
      });

      if (prompts.isCancel(reconfigure)) {
        prompts.cancel("Setup cancelled.");
        return;
      }

      if (!reconfigure) {
        prompts.outro("Setup unchanged.");
        return;
      }
    }

    const result = await runSetupCore({
      existingConfig: hasExistingConfig ? existingConfig : undefined,
      prompts,
      runtime,
    });

    if (!result) {
      prompts.cancel("Setup cancelled.");
      return;
    }

    if (!result.ready) {
      const pendingCredentialGuidance = result.readinessGuidance ?? "Additional credentials are still required before agenr can run.";
      prompts.outro(`Setup saved. ${pendingCredentialGuidance}`);
      return;
    }

    prompts.outro(`Next: ${ui.bold('agenr recall "test"')} or ${ui.bold("agenr ingest <path>")}`);
  } catch (error) {
    process.exitCode = 1;
    prompts.log.error(formatUnknownError(error));
    prompts.outro(ui.error("Setup failed"));
  }
}

/**
 * Runs the reusable interactive setup flow without banner/outro handling.
 *
 * @param options - Existing config, prompts, and runtime hooks.
 * @returns Saved config details, or `null` when the user cancels.
 */
export async function runSetupCore(options: SetupCoreOptions = {}): Promise<SetupCoreResult | null> {
  const prompts = options.prompts ?? cliPrompts;
  const runtime = options.runtime ?? defaultSetupRuntime;
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

  const overrides = await promptTaskModelOverrides(prompts, runtime, {
    defaultAuth: auth,
    defaultModel: model,
    existingConfig,
  });
  if (overrides === null) {
    return null;
  }

  const defaultDbPath = normalizeOptionalString(existingConfig?.dbPath) ?? runtime.resolveDbPath(existingConfig);
  const dbPathInput = await prompts.text({
    message: "Database path:",
    initialValue: defaultDbPath,
    placeholder: defaultDbPath,
    validate: (value) => {
      return value?.trim().length ? undefined : "Database path cannot be empty.";
    },
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
    extractionModel: overrides.extractionModel,
    dedupModel: overrides.dedupModel,
    episodeModel: overrides.episodeModel,
    surgeonModel: overrides.surgeonModel,
    dbPath,
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
 * Formats the current persisted config for display without exposing secrets.
 *
 * @param config - Existing config values.
 * @param configPath - Resolved config file path.
 * @param dbPath - Effective database path.
 * @returns Multi-line summary string.
 */
export function formatExistingConfig(config: AgenrConfig, configPath: string, dbPath: string): string {
  const lines = [
    formatLabel("Config", formatPathForDisplay(configPath)),
    formatLabel("Auth", config.auth ? describeAuthMethod(config.auth) : "(not set)"),
    formatLabel("Provider", config.provider ?? "(not set)"),
    formatLabel("Model", config.model ?? "(not set)"),
    formatLabel("LLM credentials", describePrimaryCredentialConfig(config)),
    formatLabel("Embeddings", describeEmbeddingConfig(config)),
    formatLabel("Database", formatPathForDisplay(dbPath)),
  ];

  if (config.extractionModel?.provider || config.extractionModel?.model) {
    lines.push(formatLabel("Extraction override", formatModelRef(config.extractionModel)));
  }

  if (config.dedupModel?.provider || config.dedupModel?.model) {
    lines.push(formatLabel("Dedup override", formatModelRef(config.dedupModel)));
  }

  if (config.episodeModel?.provider || config.episodeModel?.model) {
    lines.push(formatLabel("Episode override", formatModelRef(config.episodeModel)));
  }

  if (config.surgeon?.model?.provider || config.surgeon?.model?.model) {
    lines.push(formatLabel("Surgeon override", formatModelRef(config.surgeon.model)));
  }

  return lines.join("\n");
}

/**
 * Returns whether a config already has the minimum fields needed for init/setup.
 *
 * @param config - Existing config values to inspect.
 * @param env - Process environment used for credential fallback checks.
 * @returns True when the config is ready to run agenr commands.
 */
export function isSetupConfigured(config: AgenrConfig | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return getSetupReadiness(config, env).ready;
}

/**
 * Explains whether the current config can run agenr commands immediately.
 *
 * @param config - Existing config values to inspect.
 * @param env - Process environment used for credential fallback checks.
 * @returns Readiness plus a human-readable blocker when unavailable.
 */
export function getSetupReadiness(config: AgenrConfig | undefined, env: NodeJS.ProcessEnv = process.env): { ready: boolean; guidance?: string } {
  const provider = normalizeProvider(config?.provider);
  const model = normalizeOptionalString(config?.model);
  if (!provider || !model) {
    return {
      ready: false,
      guidance: "Provider and model must both be configured.",
    };
  }

  try {
    const providersToValidate = new Set<string>([
      provider,
      resolveModel(config, "extraction").provider,
      resolveModel(config, "dedup").provider,
      resolveModel(config, "episode").provider,
    ]);

    for (const providerName of providersToValidate) {
      resolveLlmCredentials(config, providerName, env);
    }

    resolveEmbeddingApiKey(config);
    return { ready: true };
  } catch (error) {
    return {
      ready: false,
      guidance: formatUnknownError(error),
    };
  }
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
  return getAuthMethodDefinition(auth)
    .preferredModels.map((modelId) => availableById.get(modelId))
    .filter((model): model is SetupModelDescriptor => model !== undefined);
}

/** Prompts for the auth method, including the advanced submenu. */
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

/** Collects the primary extraction credential for the selected auth method. */
async function preparePrimaryCredential(
  prompts: WizardPrompts,
  runtime: SetupRuntime,
  auth: AgenrAuthMethod,
  existingConfig: AgenrConfig | undefined,
  provider: SetupProvider,
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

/** Returns whether one auth method expects a manually entered credential. */
function authRequiresManualCredential(auth: AgenrAuthMethod): boolean {
  return auth === "openai-api-key" || auth === "anthropic-api-key" || auth === "anthropic-token";
}

/** Prompts for a manually entered primary credential, optionally reusing config. */
async function promptManualCredential(prompts: WizardPrompts, auth: AgenrAuthMethod, existingConfig?: AgenrConfig): Promise<string | null> {
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

/** Prompts for the separate OpenAI embedding key when the auth method needs one. */
async function promptEmbeddingApiKey(prompts: WizardPrompts, existingConfig?: AgenrConfig): Promise<string | null> {
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

/** Lets the user pick the default model for the selected auth method. */
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

/** Verifies a manually entered credential, allowing re-entry, retry, or skip. */
async function verifyManualPrimaryCredential(
  prompts: WizardPrompts,
  runtime: SetupRuntime,
  auth: AgenrAuthMethod,
  provider: SetupProvider,
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

/** Verifies an auto-detected credential, allowing retry or skip. */
async function verifyDetectedPrimaryCredential(
  prompts: WizardPrompts,
  runtime: SetupRuntime,
  auth: AgenrAuthMethod,
  provider: SetupProvider,
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

/** Verifies embeddings when the same OpenAI key is reused. */
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

/** Verifies embeddings when setup collects a separate OpenAI key. */
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

/** Prompts for optional task-specific model overrides. */
async function promptTaskModelOverrides(
  prompts: WizardPrompts,
  runtime: SetupRuntime,
  options: {
    defaultAuth: AgenrAuthMethod;
    defaultModel: string;
    existingConfig?: AgenrConfig;
  },
): Promise<{ extractionModel?: ModelConfig; dedupModel?: ModelConfig; episodeModel?: ModelConfig; surgeonModel?: ModelConfig } | null> {
  const customize = await prompts.confirm({
    message: "Customize task-specific models? (Advanced)",
    initialValue: false,
  });

  if (prompts.isCancel(customize)) {
    return null;
  }

  if (!customize) {
    return {
      extractionModel: options.existingConfig?.extractionModel,
      dedupModel: options.existingConfig?.dedupModel,
      episodeModel: options.existingConfig?.episodeModel,
      surgeonModel: options.existingConfig?.surgeon?.model,
    };
  }

  const extractionModel = await promptStageOverride(prompts, runtime, {
    label: "Extraction",
    defaultAuth: options.defaultAuth,
    defaultModel: options.defaultModel,
    current: options.existingConfig?.extractionModel,
    existingConfig: options.existingConfig,
  });
  if (extractionModel === null) {
    return null;
  }

  const dedupModel = await promptStageOverride(prompts, runtime, {
    label: "Dedup",
    defaultAuth: options.defaultAuth,
    defaultModel: options.defaultModel,
    current: options.existingConfig?.dedupModel,
    existingConfig: options.existingConfig,
  });
  if (dedupModel === null) {
    return null;
  }

  const episodeModel = await promptStageOverride(prompts, runtime, {
    label: "Episode",
    defaultAuth: options.defaultAuth,
    defaultModel: options.defaultModel,
    current: options.existingConfig?.episodeModel,
    existingConfig: options.existingConfig,
  });
  if (episodeModel === null) {
    return null;
  }

  const surgeonModel = await promptStageOverride(prompts, runtime, {
    label: "Surgeon",
    defaultAuth: options.defaultAuth,
    defaultModel: options.defaultModel,
    current: options.existingConfig?.surgeon?.model,
    existingConfig: options.existingConfig,
  });
  if (surgeonModel === null) {
    return null;
  }

  return { extractionModel, dedupModel, episodeModel, surgeonModel };
}

/** Prompts for one stage-specific provider/model override. */
async function promptStageOverride(
  prompts: WizardPrompts,
  runtime: SetupRuntime,
  options: {
    label: string;
    defaultAuth: AgenrAuthMethod;
    defaultModel: string;
    current?: ModelConfig;
    existingConfig?: AgenrConfig;
  },
): Promise<ModelConfig | undefined | null> {
  const defaultRef = `${describeAuthMethod(options.defaultAuth)} / ${options.defaultModel}`;
  const currentProvider = normalizeProvider(options.current?.provider);
  const currentModel = normalizeOptionalString(options.current?.model) ?? options.defaultModel;
  const currentAuth = resolveStageAuthChoice(currentProvider, options.defaultAuth);
  const hasExplicitOverride = normalizeOptionalString(options.current?.provider) !== undefined || normalizeOptionalString(options.current?.model) !== undefined;

  const action = await prompts.select<"default" | "custom">({
    message: `${options.label} model override:`,
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
      message: `Choose the ${options.label.toLowerCase()} auth profile:`,
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

/** Builds the config that should be persisted after setup finishes. */
function buildNextConfig(
  existingConfig: AgenrConfig | undefined,
  values: {
    auth: AgenrAuthMethod;
    provider: SetupProvider;
    model: string;
    primaryCredential?: string;
    embeddingApiKey?: string;
    extractionModel?: ModelConfig;
    dedupModel?: ModelConfig;
    episodeModel?: ModelConfig;
    surgeonModel?: ModelConfig;
    dbPath: string;
  },
): AgenrConfig {
  const nextCredentials = mergeStoredCredentials(existingConfig?.credentials, {
    auth: values.auth,
    primaryCredential: values.primaryCredential,
    embeddingApiKey: values.embeddingApiKey,
  });
  const nextSurgeon = buildNextSurgeonConfig(existingConfig?.surgeon, values.surgeonModel);

  return {
    ...existingConfig,
    auth: values.auth,
    provider: values.provider,
    model: values.model,
    ...(nextCredentials ? { credentials: nextCredentials } : { credentials: undefined }),
    ...(values.extractionModel ? { extractionModel: values.extractionModel } : { extractionModel: undefined }),
    ...(values.dedupModel ? { dedupModel: values.dedupModel } : { dedupModel: undefined }),
    ...(values.episodeModel ? { episodeModel: values.episodeModel } : { episodeModel: undefined }),
    ...(nextSurgeon ? { surgeon: nextSurgeon } : { surgeon: undefined }),
    dbPath: values.dbPath,
  };
}

/** Formatting options for the saved-configuration summary. */
interface SavedConfigSummaryOptions {
  /** Whether embeddings reuse the main OpenAI key. */
  embeddingUsesPrimaryKey: boolean;
  /** Previously loaded config, when setup is reconfiguring an existing file. */
  previousConfig?: AgenrConfig;
  /** Whether the saved config can run agenr commands immediately. */
  ready: boolean;
  /** Human-readable blocker when the saved config still needs credentials. */
  pendingCredentialGuidance?: string;
}

/**
 * Formats the saved config note shown after setup completes.
 *
 * Unchanged override lines are omitted when setup is reconfiguring an existing
 * config so the user does not see the same override rendered twice in one run.
 */
function formatSavedConfigSummary(config: AgenrConfig, configPath: string, dbPath: string, options: SavedConfigSummaryOptions): string {
  const lines = [
    formatLabel("Config", formatPathForDisplay(configPath)),
    formatLabel("Auth", config.auth ? describeAuthMethod(config.auth) : "(not set)"),
    formatLabel("Provider", config.provider ?? "(not set)"),
    formatLabel("Model", config.model ?? "(not set)"),
    formatLabel(
      "Embeddings",
      options.embeddingUsesPrimaryKey ? `OpenAI ${EMBEDDING_MODEL} using the primary API key` : `OpenAI ${EMBEDDING_MODEL} using a separate key`,
    ),
    formatLabel("Database", formatPathForDisplay(dbPath)),
    formatLabel("Status", options.ready ? "Ready to use" : "Needs additional credentials before use"),
  ];

  if (!options.ready && options.pendingCredentialGuidance) {
    lines.push(formatLabel("Next action", options.pendingCredentialGuidance));
  }

  appendChangedOverrideLine(lines, "Extraction override", config.extractionModel, options.previousConfig?.extractionModel);
  appendChangedOverrideLine(lines, "Dedup override", config.dedupModel, options.previousConfig?.dedupModel);
  appendChangedOverrideLine(lines, "Episode override", config.episodeModel, options.previousConfig?.episodeModel);
  appendChangedOverrideLine(lines, "Surgeon override", config.surgeon?.model, options.previousConfig?.surgeon?.model);

  return lines.join("\n");
}

/** Resolves the auth-aware model list for one setup auth method. */
function resolveSetupModelsForAuth(runtime: SetupRuntime, auth: AgenrAuthMethod): SetupModelDescriptor[] {
  const provider = authMethodToProvider(auth);
  const filtered = filterSetupModelsForAuth(auth, runtime.getModelsForProvider(provider));
  if (filtered.length === 0) {
    throw new Error(`No setup models are available for auth method "${auth}".`);
  }

  return filtered;
}

/** Returns the first filtered model used during connection tests. */
function resolveProbeModel(auth: AgenrAuthMethod, runtime: SetupRuntime): string {
  return resolveSetupModelsForAuth(runtime, auth)[0].id;
}

/** Provides short display hints for model picker options. */
function hintForModel(provider: SetupProvider, modelId: string, fallbackName?: string): string | undefined {
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
  existingConfig?: AgenrConfig,
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

/** Logs a short runtime note when an override needs different credentials. */
function maybeLogStageCredentialRequirement(prompts: WizardPrompts, auth: AgenrAuthMethod, defaultAuth: AgenrAuthMethod): void {
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

/** Maps an override provider back into the auth profile used to pick models for setup. */
function resolveStageAuthChoice(provider: SetupProvider | undefined, defaultAuth: AgenrAuthMethod): AgenrAuthMethod | undefined {
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

/** Returns the stored manual credential associated with one auth method. */
function resolveStoredCredentialForAuth(config: AgenrConfig | undefined, auth: AgenrAuthMethod): string | undefined {
  switch (auth) {
    case "openai-api-key":
      return normalizeOptionalString(config?.credentials?.openaiApiKey);
    case "anthropic-api-key":
      return normalizeOptionalString(config?.credentials?.anthropicApiKey);
    case "anthropic-token":
      return normalizeOptionalString(config?.credentials?.anthropicOauthToken);
    case "anthropic-oauth":
    case "openai-subscription":
      return undefined;
  }
}

/** Returns the stored OpenAI key reused for embeddings when available. */
function resolveStoredEmbeddingCredential(config: AgenrConfig | undefined): string | undefined {
  return normalizeOptionalString(config?.credentials?.openaiApiKey);
}

/** Formats the primary-credential status shown in setup summaries. */
function describePrimaryCredentialConfig(config: AgenrConfig): string {
  const auth = normalizeAuthMethod(config.auth);
  if (!auth) {
    return "not set";
  }

  if (auth === "openai-api-key") {
    return hasSecret(resolveStoredCredentialForAuth(config, auth)) ? "stored OpenAI API key" : "not set";
  }

  if (auth === "anthropic-api-key") {
    return hasSecret(resolveStoredCredentialForAuth(config, auth)) ? "stored Anthropic API key" : "not set";
  }

  if (auth === "anthropic-token") {
    return hasSecret(resolveStoredCredentialForAuth(config, auth)) ? "stored Anthropic long-lived token" : "not set";
  }

  return auth === "anthropic-oauth" ? "auto-detected from Claude Code" : "auto-detected from Codex CLI";
}

/** Formats the embedding section shown in existing-config notes. */
function describeEmbeddingConfig(config: AgenrConfig): string {
  if (hasSecret(resolveStoredEmbeddingCredential(config))) {
    return normalizeAuthMethod(config.auth) === "openai-api-key" ? "uses the primary OpenAI key" : "separate OpenAI key configured";
  }

  const auth = normalizeAuthMethod(config.auth);
  if (auth && auth !== "openai-api-key") {
    return "missing separate OpenAI key";
  }

  return "not configured";
}

/** Merges manual credentials into the persisted config shape. */
function mergeStoredCredentials(
  existingCredentials: AgenrStoredCredentials | undefined,
  values: {
    auth: AgenrAuthMethod;
    primaryCredential?: string;
    embeddingApiKey?: string;
  },
): AgenrStoredCredentials | undefined {
  const next: AgenrStoredCredentials = {
    ...(existingCredentials ?? {}),
  };

  const normalizedPrimaryCredential = normalizeOptionalString(values.primaryCredential);
  if (normalizedPrimaryCredential) {
    if (values.auth === "openai-api-key") {
      next.openaiApiKey = normalizedPrimaryCredential;
    } else if (values.auth === "anthropic-api-key") {
      next.anthropicApiKey = normalizedPrimaryCredential;
    } else if (values.auth === "anthropic-token") {
      next.anthropicOauthToken = normalizedPrimaryCredential;
    }
  }

  const normalizedEmbeddingApiKey = normalizeOptionalString(values.embeddingApiKey);
  if (normalizedEmbeddingApiKey) {
    next.openaiApiKey = normalizedEmbeddingApiKey;
  }

  return pruneStoredCredentials(next);
}

/** Builds the persisted surgeon config while avoiding empty nested objects. */
function buildNextSurgeonConfig(
  existingSurgeon: AgenrConfig["surgeon"] | undefined,
  surgeonModel: ModelConfig | undefined,
): AgenrConfig["surgeon"] | undefined {
  if (!existingSurgeon && !surgeonModel) {
    return undefined;
  }

  const nextSurgeon = {
    ...(existingSurgeon ?? {}),
    ...(surgeonModel ? { model: surgeonModel } : { model: undefined }),
  };

  return hasPersistedSurgeonConfig(nextSurgeon) ? nextSurgeon : undefined;
}

/** Returns whether the surgeon config contains any persisted values. */
function hasPersistedSurgeonConfig(config: AgenrConfig["surgeon"] | undefined): config is NonNullable<AgenrConfig["surgeon"]> {
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

/** Removes empty credential fields before config persistence. */
function pruneStoredCredentials(credentials: AgenrStoredCredentials): AgenrStoredCredentials | undefined {
  const next: AgenrStoredCredentials = {
    ...(hasSecret(credentials.openaiApiKey) ? { openaiApiKey: credentials.openaiApiKey?.trim() } : {}),
    ...(hasSecret(credentials.anthropicApiKey) ? { anthropicApiKey: credentials.anthropicApiKey?.trim() } : {}),
    ...(hasSecret(credentials.anthropicOauthToken) ? { anthropicOauthToken: credentials.anthropicOauthToken?.trim() } : {}),
  };

  return Object.keys(next).length > 0 ? next : undefined;
}

/** Adds one override-summary line when the value changed during reconfiguration. */
function appendChangedOverrideLine(lines: string[], label: string, current: ModelConfig | undefined, previous: ModelConfig | undefined): void {
  const currentHasOverride = hasModelOverride(current);
  const previousHasOverride = hasModelOverride(previous);

  if (!currentHasOverride && !previousHasOverride) {
    return;
  }

  if (sameModelRef(current, previous)) {
    return;
  }

  lines.push(formatLabel(label, currentHasOverride ? formatModelRef(current) : "Use default model"));
}

/** Returns whether one model config contains an explicit provider/model override. */
function hasModelOverride(config: ModelConfig | undefined): boolean {
  return normalizeOptionalString(config?.provider) !== undefined || normalizeOptionalString(config?.model) !== undefined;
}

/** Returns whether two model references resolve to the same provider/model pair. */
function sameModelRef(left: ModelConfig | undefined, right: ModelConfig | undefined): boolean {
  return (
    normalizeOptionalString(left?.provider) === normalizeOptionalString(right?.provider) &&
    normalizeOptionalString(left?.model) === normalizeOptionalString(right?.model)
  );
}

/** Formats a provider/model reference for display. */
function formatModelRef(config: ModelConfig | undefined): string {
  const provider = normalizeOptionalString(config?.provider) ?? "(provider not set)";
  const model = normalizeOptionalString(config?.model) ?? "(model not set)";
  return `${provider}/${model}`;
}

/** Returns the human-readable label for one auth method. */
function describeAuthMethod(auth: AgenrAuthMethod): string {
  return getAuthMethodDefinition(auth).title;
}

/** Returns the label used when asking to reuse a stored manual credential. */
function manualCredentialLabel(auth: AgenrAuthMethod): string {
  if (auth === "anthropic-token") {
    return "Anthropic long-lived token";
  }

  return describeAuthMethod(auth);
}

/** Returns the password prompt label for one manual auth method. */
function promptForManualCredential(auth: AgenrAuthMethod): string {
  if (auth === "anthropic-token") {
    return "Enter Anthropic long-lived token:";
  }

  if (auth === "anthropic-api-key") {
    return "Enter Anthropic API key:";
  }

  return "Enter OpenAI API key:";
}

/** Validates hidden-secret prompt input. */
function validateSecret(value: string | undefined): string | undefined {
  return value?.trim().length ? undefined : "Value cannot be empty.";
}

/** True when a secret-like string is present. */
function hasSecret(value: string | undefined): boolean {
  return normalizeOptionalString(value) !== undefined;
}

/** Normalizes supported provider values from config. */
function normalizeProvider(value: string | undefined): SetupProvider | undefined {
  const normalized = normalizeOptionalString(value);
  if (normalized === "openai" || normalized === "openai-codex" || normalized === "anthropic") {
    return normalized;
  }

  return undefined;
}

/** Normalizes supported auth-method values from config. */
function normalizeAuthMethod(value: string | undefined): AgenrAuthMethod | undefined {
  const normalized = normalizeOptionalString(value);
  if (
    normalized === "openai-api-key" ||
    normalized === "openai-subscription" ||
    normalized === "anthropic-api-key" ||
    normalized === "anthropic-oauth" ||
    normalized === "anthropic-token"
  ) {
    return normalized;
  }

  return undefined;
}

/** Normalizes optional strings into trimmed values. */
function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Races one promise against a timeout. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });

  return await Promise.race([promise, timeout]);
}

/** Converts unknown thrown values into readable error messages. */
function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
