import { getModels } from "@mariozechner/pi-ai";
import type { Command } from "commander";

import { EMBEDDING_MODEL, createEmbeddingClient } from "../../adapters/embeddings.js";
import { createLlmClient } from "../../adapters/llm.js";
import { configFileExists, readConfig, resolveConfigPath, resolveDbPath, type AgenrConfig, type ModelConfig, writeConfig } from "../../config.js";
import { banner, cliPrompts, formatLabel, formatPathForDisplay, resolveUserPath, ui, type WizardPrompts } from "../ui.js";

const CONNECTION_TEST_TIMEOUT_MS = 5_000;
const DEFAULT_PROVIDER = "openai";
const SUPPORTED_PROVIDERS = ["openai", "anthropic"] as const;

/** Supported providers exposed by the setup wizard. */
export type SetupProvider = (typeof SUPPORTED_PROVIDERS)[number];

/** Model metadata shown in setup model pickers. */
export interface SetupModelDescriptor {
  /** Provider-local model identifier. */
  id: string;
  /** Human-readable model name. */
  name?: string;
}

/** Result returned by LLM and embedding connection tests. */
export interface ConnectionTestResult {
  /** Whether the test succeeded. */
  ok: boolean;
  /** Optional human-readable error when the test failed. */
  error?: string;
}

/** Runtime hooks used by the setup flow for testability. */
export interface SetupRuntime {
  /** Resolves the effective config file path. */
  resolveConfigPath(): string;
  /** Resolves the effective database path. */
  resolveDbPath(config?: AgenrConfig): string;
  /** Persists the updated config. */
  writeConfig(config: AgenrConfig): void;
  /** Lists available models for one setup provider. */
  getModelsForProvider(provider: SetupProvider): SetupModelDescriptor[];
  /** Verifies that the chosen LLM credential works. */
  testLlmConnection(provider: SetupProvider, modelId: string, apiKey: string): Promise<ConnectionTestResult>;
  /** Verifies that the embedding credential works. */
  testEmbeddingConnection(apiKey: string, modelId: string): Promise<ConnectionTestResult>;
}

/** Options for the reusable setup core flow. */
export interface SetupCoreOptions {
  /** Existing config values used for defaults and key reuse prompts. */
  existingConfig?: AgenrConfig;
  /** Prompt implementation used by the interactive flow. */
  prompts?: WizardPrompts;
  /** Runtime dependencies used by the interactive flow. */
  runtime?: SetupRuntime;
}

/** Successful result from the setup core flow. */
export interface SetupCoreResult {
  /** Persisted agenr config. */
  config: AgenrConfig;
  /** Config file path written by setup. */
  configPath: string;
  /** Database path stored in the config. */
  dbPath: string;
  /** Selected default provider. */
  provider: SetupProvider;
  /** Selected default model. */
  model: string;
  /** Whether embeddings reuse the primary OpenAI key. */
  embeddingUsesPrimaryKey: boolean;
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
      .sort(sortSetupModels(provider)),
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
};

/**
 * Registers the `agenr setup` command.
 *
 * @param program - Root Commander program to extend.
 */
export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Configure provider, API keys, models, and the agenr database path")
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

  const provider = await prompts.select<SetupProvider>({
    message: "Choose your default LLM provider:",
    options: [
      {
        value: "openai",
        label: "OpenAI",
        hint: "recommended for first-run setup",
      },
      {
        value: "anthropic",
        label: "Anthropic",
      },
    ],
    initialValue: normalizeProvider(existingConfig?.provider) ?? DEFAULT_PROVIDER,
  });

  if (prompts.isCancel(provider)) {
    return null;
  }

  let apiKey = await promptPrimaryApiKey(prompts, provider, existingConfig);
  if (apiKey === null) {
    return null;
  }

  const probeModel = resolveProbeModel(provider, runtime.getModelsForProvider(provider));
  const verifiedPrimaryKey = await verifyPrimaryApiKey(prompts, runtime, provider, apiKey, probeModel);
  if (verifiedPrimaryKey === null) {
    return null;
  }
  apiKey = verifiedPrimaryKey.apiKey;

  const model = await selectProviderModel(prompts, runtime, provider, existingConfig?.model);
  if (model === null) {
    return null;
  }

  let embeddingApiKey: string | undefined;
  let embeddingUsesPrimaryKey = provider === "openai";

  if (provider === "openai") {
    const embeddingResult = await verifySharedEmbeddingKey(prompts, runtime, apiKey);
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
    embeddingUsesPrimaryKey = false;
  }

  const overrides = await promptTaskModelOverrides(prompts, runtime, provider, model, existingConfig);
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
    provider,
    model,
    apiKey,
    embeddingApiKey,
    extractionModel: overrides.extractionModel,
    dedupModel: overrides.dedupModel,
    dbPath,
  });

  runtime.writeConfig(nextConfig);

  prompts.note(formatSavedConfigSummary(nextConfig, configPath, dbPath, embeddingUsesPrimaryKey), "Configuration saved");

  return {
    config: nextConfig,
    configPath,
    dbPath,
    provider,
    model,
    embeddingUsesPrimaryKey,
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
    formatLabel("Provider", config.provider ?? "(not set)"),
    formatLabel("Model", config.model ?? "(not set)"),
    formatLabel("LLM API key", hasSecret(config.apiKey) ? "configured" : "not set"),
    formatLabel("Embeddings", describeEmbeddingConfig(config)),
    formatLabel("Database", formatPathForDisplay(dbPath)),
  ];

  if (config.extractionModel?.provider || config.extractionModel?.model) {
    lines.push(formatLabel("Extraction override", formatModelRef(config.extractionModel)));
  }

  if (config.dedupModel?.provider || config.dedupModel?.model) {
    lines.push(formatLabel("Dedup override", formatModelRef(config.dedupModel)));
  }

  return lines.join("\n");
}

/**
 * Returns whether a config already has the minimum fields needed for init/setup.
 *
 * @param config - Existing config values to inspect.
 * @param env - Process environment used for embedding-key fallback checks.
 * @returns True when the config is ready to run agenr commands.
 */
export function isSetupConfigured(config: AgenrConfig | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const provider = normalizeProvider(config?.provider);
  const model = normalizeOptionalString(config?.model);
  const apiKey = normalizeOptionalString(config?.apiKey);
  if (!provider || !model || !apiKey) {
    return false;
  }

  if (provider === "openai") {
    return true;
  }

  return hasSecret(config?.embeddingApiKey) || hasSecret(env.OPENAI_API_KEY);
}

/** Prompts for the provider's primary API key, optionally reusing an existing one. */
async function promptPrimaryApiKey(prompts: WizardPrompts, provider: SetupProvider, existingConfig?: AgenrConfig): Promise<string | null> {
  const existingProvider = normalizeProvider(existingConfig?.provider);
  const existingApiKey = normalizeOptionalString(existingConfig?.apiKey);

  if (existingProvider === provider && existingApiKey) {
    const useExisting = await prompts.confirm({
      message: `Use the existing ${providerLabel(provider)} API key from config?`,
      initialValue: true,
    });

    if (prompts.isCancel(useExisting)) {
      return null;
    }

    if (useExisting) {
      return existingApiKey;
    }
  }

  const apiKey = await prompts.password({
    message: `Enter ${providerLabel(provider)} API key:`,
    validate: validateSecret,
  });

  if (prompts.isCancel(apiKey)) {
    return null;
  }

  return apiKey.trim();
}

/** Prompts for the separate OpenAI embedding key when Anthropic is selected. */
async function promptEmbeddingApiKey(prompts: WizardPrompts, existingConfig?: AgenrConfig): Promise<string | null> {
  const existingEmbeddingKey = normalizeOptionalString(existingConfig?.embeddingApiKey);
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

/** Lets the user pick the default model for the selected provider. */
async function selectProviderModel(prompts: WizardPrompts, runtime: SetupRuntime, provider: SetupProvider, existingModel?: string): Promise<string | null> {
  const models = runtime.getModelsForProvider(provider);
  if (models.length === 0) {
    throw new Error(`No setup models are available for provider "${provider}".`);
  }

  const options = models.map((model) => ({
    value: model.id,
    label: model.id,
    hint: hintForModel(provider, model.id, model.name),
  }));

  const initialValue = options.some((option) => option.value === existingModel) ? existingModel : resolveProbeModel(provider, models);
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

/** Verifies the provider key, allowing re-entry, retry, or skip. */
async function verifyPrimaryApiKey(
  prompts: WizardPrompts,
  runtime: SetupRuntime,
  provider: SetupProvider,
  initialApiKey: string,
  probeModel: string,
): Promise<{ apiKey: string; verified: boolean } | null> {
  let apiKey = initialApiKey;

  while (true) {
    const spinner = prompts.spinner();
    spinner.start(`Testing ${providerLabel(provider)} API key...`);
    const result = await runtime.testLlmConnection(provider, probeModel, apiKey);

    if (result.ok) {
      spinner.stop(ui.success("Connection verified"));
      return { apiKey, verified: true };
    }

    spinner.stop(ui.error(`Connection failed: ${result.error ?? "unknown error"}`));
    const action = await prompts.select<"reenter" | "retry" | "skip">({
      message: "The provider connection test failed. What do you want to do?",
      options: [
        { value: "reenter", label: "Enter a new API key", hint: "recommended" },
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
      message: `Enter ${providerLabel(provider)} API key:`,
      validate: validateSecret,
    });

    if (prompts.isCancel(replacement)) {
      return null;
    }

    apiKey = replacement.trim();
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

/** Verifies embeddings when Anthropic users provide a separate OpenAI key. */
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

/** Prompts for optional extraction and dedup model overrides. */
async function promptTaskModelOverrides(
  prompts: WizardPrompts,
  runtime: SetupRuntime,
  defaultProvider: SetupProvider,
  defaultModel: string,
  existingConfig?: AgenrConfig,
): Promise<{ extractionModel?: ModelConfig; dedupModel?: ModelConfig } | null> {
  const customize = await prompts.confirm({
    message: "Customize extraction or dedup models? (Advanced)",
    initialValue: false,
  });

  if (prompts.isCancel(customize)) {
    return null;
  }

  if (!customize) {
    return {};
  }

  const extractionModel = await promptStageOverride(prompts, runtime, {
    label: "Extraction",
    defaultProvider,
    defaultModel,
    current: existingConfig?.extractionModel,
  });
  if (extractionModel === null) {
    return null;
  }

  const dedupModel = await promptStageOverride(prompts, runtime, {
    label: "Dedup",
    defaultProvider,
    defaultModel,
    current: existingConfig?.dedupModel,
  });
  if (dedupModel === null) {
    return null;
  }

  return { extractionModel, dedupModel };
}

/** Prompts for one stage-specific provider/model override. */
async function promptStageOverride(
  prompts: WizardPrompts,
  runtime: SetupRuntime,
  options: {
    label: string;
    defaultProvider: SetupProvider;
    defaultModel: string;
    current?: ModelConfig;
  },
): Promise<ModelConfig | undefined | null> {
  const defaultRef = `${options.defaultProvider}/${options.defaultModel}`;
  const currentProvider = normalizeProvider(options.current?.provider) ?? options.defaultProvider;
  const currentModel = normalizeOptionalString(options.current?.model) ?? options.defaultModel;
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
        label: hasExplicitOverride ? `Update override (${currentProvider}/${currentModel})` : "Set a custom override",
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

  const provider = await prompts.select<SetupProvider>({
    message: `Choose the ${options.label.toLowerCase()} provider:`,
    options: [
      { value: "openai", label: "OpenAI" },
      { value: "anthropic", label: "Anthropic" },
    ],
    initialValue: currentProvider,
  });

  if (prompts.isCancel(provider)) {
    return null;
  }

  const model = await selectProviderModel(prompts, runtime, provider, currentModel);
  if (model === null) {
    return null;
  }

  if (provider === options.defaultProvider && model === options.defaultModel) {
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
    provider: SetupProvider;
    model: string;
    apiKey: string;
    embeddingApiKey?: string;
    extractionModel?: ModelConfig;
    dedupModel?: ModelConfig;
    dbPath: string;
  },
): AgenrConfig {
  return {
    ...existingConfig,
    provider: values.provider,
    model: values.model,
    apiKey: values.apiKey,
    ...(values.embeddingApiKey ? { embeddingApiKey: values.embeddingApiKey } : {}),
    ...(values.extractionModel ? { extractionModel: values.extractionModel } : {}),
    ...(values.dedupModel ? { dedupModel: values.dedupModel } : {}),
    dbPath: values.dbPath,
    ...(values.embeddingApiKey ? {} : { embeddingApiKey: undefined }),
    ...(values.extractionModel ? {} : { extractionModel: undefined }),
    ...(values.dedupModel ? {} : { dedupModel: undefined }),
  };
}

/** Formats the saved config note shown after setup completes. */
function formatSavedConfigSummary(config: AgenrConfig, configPath: string, dbPath: string, embeddingUsesPrimaryKey: boolean): string {
  const lines = [
    formatLabel("Config", formatPathForDisplay(configPath)),
    formatLabel("Provider", config.provider ?? "(not set)"),
    formatLabel("Model", config.model ?? "(not set)"),
    formatLabel(
      "Embeddings",
      embeddingUsesPrimaryKey ? `OpenAI ${EMBEDDING_MODEL} using the primary API key` : `OpenAI ${EMBEDDING_MODEL} using a separate key`,
    ),
    formatLabel("Database", formatPathForDisplay(dbPath)),
  ];

  if (config.extractionModel?.provider || config.extractionModel?.model) {
    lines.push(formatLabel("Extraction override", formatModelRef(config.extractionModel)));
  }

  if (config.dedupModel?.provider || config.dedupModel?.model) {
    lines.push(formatLabel("Dedup override", formatModelRef(config.dedupModel)));
  }

  return lines.join("\n");
}

/** Provides short display hints for model picker options. */
function hintForModel(provider: SetupProvider, modelId: string, fallbackName?: string): string | undefined {
  if (provider === "openai") {
    if (modelId === "gpt-5.4-mini") {
      return "Recommended - strong quality/cost balance";
    }
    if (modelId === "gpt-5.4") {
      return "Higher quality, higher cost";
    }
    if (modelId === "gpt-4.1-mini") {
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

/** Returns the probe model used during the pre-selection connection test. */
function resolveProbeModel(provider: SetupProvider, models: SetupModelDescriptor[]): string {
  const preferredOrder =
    provider === "openai" ? ["gpt-5.4-mini", "gpt-5.4", "gpt-4.1-mini"] : ["claude-sonnet-4-20250514", "claude-opus-4-6", "claude-haiku-3-5-20241022"];

  for (const preferred of preferredOrder) {
    if (models.some((model) => model.id === preferred)) {
      return preferred;
    }
  }

  const first = models[0]?.id;
  if (!first) {
    throw new Error(`No setup models are available for provider "${provider}".`);
  }

  return first;
}

/** Sorts setup models with provider-specific preferred IDs first. */
function sortSetupModels(provider: SetupProvider): (left: SetupModelDescriptor, right: SetupModelDescriptor) => number {
  const preferredOrder =
    provider === "openai"
      ? ["gpt-5.4-mini", "gpt-5.4", "gpt-4.1-mini", "gpt-5.4-nano", "o4-mini", "o3"]
      : ["claude-sonnet-4-20250514", "claude-opus-4-6", "claude-haiku-3-5-20241022"];

  return (left, right) => {
    const leftIndex = preferredOrder.indexOf(left.id);
    const rightIndex = preferredOrder.indexOf(right.id);

    if (leftIndex !== -1 || rightIndex !== -1) {
      if (leftIndex === -1) {
        return 1;
      }
      if (rightIndex === -1) {
        return -1;
      }
      return leftIndex - rightIndex;
    }

    return left.id.localeCompare(right.id);
  };
}

/** Formats the embedding section shown in existing-config notes. */
function describeEmbeddingConfig(config: AgenrConfig): string {
  if (hasSecret(config.embeddingApiKey)) {
    return "separate OpenAI key configured";
  }

  if (normalizeProvider(config.provider) === "openai" && hasSecret(config.apiKey)) {
    return "uses the primary OpenAI key";
  }

  if (normalizeProvider(config.provider) === "anthropic" && hasSecret(config.apiKey)) {
    return "missing separate OpenAI key";
  }

  return "not configured";
}

/** Formats a provider/model reference for display. */
function formatModelRef(config: ModelConfig | undefined): string {
  const provider = normalizeOptionalString(config?.provider) ?? "(provider not set)";
  const model = normalizeOptionalString(config?.model) ?? "(model not set)";
  return `${provider}/${model}`;
}

/** Returns the human-readable label for one provider. */
function providerLabel(provider: SetupProvider): string {
  return provider === "openai" ? "OpenAI" : "Anthropic";
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
  return SUPPORTED_PROVIDERS.find((provider) => provider === value?.trim());
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
