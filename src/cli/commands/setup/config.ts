import { EMBEDDING_MODEL, resolveEmbeddingApiKey } from "../../../adapters/embeddings.js";
import { resolveLlmCredentials } from "../../../adapters/llm.js";
import { type AgenrAuthMethod, type AgenrConfig, type AgenrStoredCredentials } from "../../../config.js";
import { formatLabel, formatPathForDisplay } from "../../ui.js";
import { appendSetupStageSummaryLines, applySetupStageOverrides, collectSetupStageProviders, type SetupStageOverrides } from "./stages.js";
import {
  describeAuthMethod,
  formatUnknownError,
  hasSecret,
  normalizeAuthMethod,
  normalizeOptionalString,
  resolveStoredCredentialForAuth,
  resolveStoredEmbeddingCredential,
} from "./shared.js";
import type { SetupProvider } from "./types.js";

/**
 * Inputs used to build the config persisted by setup.
 */
export interface BuildNextConfigValues {
  /** Selected auth method. */
  auth: AgenrAuthMethod;
  /** Selected default provider. */
  provider: SetupProvider;
  /** Selected default model. */
  model: string;
  /** Manually entered primary credential that should be persisted. */
  primaryCredential?: string;
  /** Optional separate OpenAI API key for embeddings. */
  embeddingApiKey?: string;
  /** Per-stage override selections. */
  stageOverrides: SetupStageOverrides;
  /** Database path to persist. */
  dbPath: string;
}

/**
 * Formatting options for the saved-configuration summary.
 */
export interface SavedConfigSummaryOptions {
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
 * Builds the config that should be persisted after setup finishes.
 *
 * @param existingConfig - Existing config values when reconfiguring.
 * @param values - Fresh setup selections that should be persisted.
 * @returns Persisted config snapshot.
 */
export function buildNextConfig(existingConfig: AgenrConfig | undefined, values: BuildNextConfigValues): AgenrConfig {
  const nextCredentials = mergeStoredCredentials(existingConfig?.credentials, {
    auth: values.auth,
    primaryCredential: values.primaryCredential,
    embeddingApiKey: values.embeddingApiKey,
  });

  const baseConfig: AgenrConfig = {
    ...existingConfig,
    auth: values.auth,
    provider: values.provider,
    model: values.model,
    ...(nextCredentials ? { credentials: nextCredentials } : { credentials: undefined }),
    dbPath: values.dbPath,
  };

  return applySetupStageOverrides(baseConfig, values.stageOverrides);
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

  appendSetupStageSummaryLines(lines, config);
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
  const provider = normalizeOptionalString(config?.provider);
  const model = normalizeOptionalString(config?.model);
  if (!provider || !model) {
    return {
      ready: false,
      guidance: "Provider and model must both be configured.",
    };
  }

  try {
    const providersToValidate = new Set<string>([provider, ...collectSetupStageProviders(config)]);

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
 * Formats the saved config note shown after setup completes.
 *
 * Unchanged override lines are omitted when setup is reconfiguring an existing
 * config so the user does not see the same override rendered twice in one run.
 *
 * @param config - Newly saved config snapshot.
 * @param configPath - Resolved config file path.
 * @param dbPath - Effective database path.
 * @param options - Summary rendering options.
 * @returns Multi-line saved-config summary.
 */
export function formatSavedConfigSummary(config: AgenrConfig, configPath: string, dbPath: string, options: SavedConfigSummaryOptions): string {
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

  appendSetupStageSummaryLines(lines, config, options.previousConfig);
  return lines.join("\n");
}

/**
 * Formats the primary-credential status shown in setup summaries.
 *
 * @param config - Config values to describe.
 * @returns Human-readable primary-credential summary.
 */
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

/**
 * Formats the embedding section shown in existing-config notes.
 *
 * @param config - Config values to describe.
 * @returns Human-readable embedding summary.
 */
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

/**
 * Merges manual credentials into the persisted config shape.
 *
 * @param existingCredentials - Existing stored credentials.
 * @param values - Fresh credential values collected during setup.
 * @returns Credential payload ready for persistence.
 */
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

/**
 * Removes empty credential fields before config persistence.
 *
 * @param credentials - Candidate credential payload.
 * @returns Persistable credential object, or undefined when empty.
 */
function pruneStoredCredentials(credentials: AgenrStoredCredentials): AgenrStoredCredentials | undefined {
  const next: AgenrStoredCredentials = {
    ...(hasSecret(credentials.openaiApiKey) ? { openaiApiKey: credentials.openaiApiKey?.trim() } : {}),
    ...(hasSecret(credentials.anthropicApiKey) ? { anthropicApiKey: credentials.anthropicApiKey?.trim() } : {}),
    ...(hasSecret(credentials.anthropicOauthToken) ? { anthropicOauthToken: credentials.anthropicOauthToken?.trim() } : {}),
  };

  return Object.keys(next).length > 0 ? next : undefined;
}
