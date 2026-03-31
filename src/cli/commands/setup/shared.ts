import { getAuthMethodDefinition, type AgenrAuthMethod, type AgenrConfig, type ModelConfig } from "../../../config.js";
import type { SetupProvider } from "./types.js";

/**
 * Returns the human-readable label for one auth method.
 *
 * @param auth - Auth method to describe.
 * @returns Display label used in setup prompts.
 */
export function describeAuthMethod(auth: AgenrAuthMethod): string {
  return getAuthMethodDefinition(auth).title;
}

/**
 * Returns the label used when asking to reuse a stored manual credential.
 *
 * @param auth - Auth method being reused.
 * @returns Human-readable credential label.
 */
export function manualCredentialLabel(auth: AgenrAuthMethod): string {
  if (auth === "anthropic-token") {
    return "Anthropic long-lived token";
  }

  return describeAuthMethod(auth);
}

/**
 * Returns the password prompt label for one manual auth method.
 *
 * @param auth - Auth method that needs a manual secret.
 * @returns Prompt text shown to the user.
 */
export function promptForManualCredential(auth: AgenrAuthMethod): string {
  if (auth === "anthropic-token") {
    return "Enter Anthropic long-lived token:";
  }

  if (auth === "anthropic-api-key") {
    return "Enter Anthropic API key:";
  }

  return "Enter OpenAI API key:";
}

/**
 * Validates hidden-secret prompt input.
 *
 * @param value - Candidate secret input.
 * @returns Validation error, or undefined when the value is acceptable.
 */
export function validateSecret(value: string | undefined): string | undefined {
  return value?.trim().length ? undefined : "Value cannot be empty.";
}

/**
 * True when a secret-like string is present.
 *
 * @param value - Candidate secret input.
 * @returns True when the value contains a non-empty secret.
 */
export function hasSecret(value: string | undefined): boolean {
  return normalizeOptionalString(value) !== undefined;
}

/**
 * Formats a provider/model reference for display.
 *
 * @param config - Optional model reference to format.
 * @returns Stable `provider/model` text.
 */
export function formatModelRef(config: ModelConfig | undefined): string {
  const provider = normalizeOptionalString(config?.provider) ?? "(provider not set)";
  const model = normalizeOptionalString(config?.model) ?? "(model not set)";
  return `${provider}/${model}`;
}

/**
 * Returns whether one model config contains an explicit provider/model override.
 *
 * @param config - Optional model configuration.
 * @returns True when the config sets either provider or model.
 */
export function hasModelOverride(config: ModelConfig | undefined): boolean {
  return normalizeOptionalString(config?.provider) !== undefined || normalizeOptionalString(config?.model) !== undefined;
}

/**
 * Returns whether two model references resolve to the same provider/model pair.
 *
 * @param left - Left model configuration.
 * @param right - Right model configuration.
 * @returns True when both references normalize to the same values.
 */
export function sameModelRef(left: ModelConfig | undefined, right: ModelConfig | undefined): boolean {
  return (
    normalizeOptionalString(left?.provider) === normalizeOptionalString(right?.provider) &&
    normalizeOptionalString(left?.model) === normalizeOptionalString(right?.model)
  );
}

/**
 * Returns the stored manual credential associated with one auth method.
 *
 * @param config - Existing config values to inspect.
 * @param auth - Auth method whose stored credential should be read.
 * @returns Stored credential, or undefined when absent.
 */
export function resolveStoredCredentialForAuth(config: AgenrConfig | undefined, auth: AgenrAuthMethod): string | undefined {
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

/**
 * Returns the stored OpenAI key reused for embeddings when available.
 *
 * @param config - Existing config values to inspect.
 * @returns Stored embedding key, or undefined when absent.
 */
export function resolveStoredEmbeddingCredential(config: AgenrConfig | undefined): string | undefined {
  return normalizeOptionalString(config?.credentials?.openaiApiKey);
}

/**
 * Normalizes supported provider values from config.
 *
 * @param value - Candidate provider string.
 * @returns Normalized setup provider, or undefined when unsupported.
 */
export function normalizeProvider(value: string | undefined): SetupProvider | undefined {
  const normalized = normalizeOptionalString(value);
  if (normalized === "openai" || normalized === "openai-codex" || normalized === "anthropic") {
    return normalized;
  }

  return undefined;
}

/**
 * Normalizes supported auth-method values from config.
 *
 * @param value - Candidate auth-method string.
 * @returns Normalized auth method, or undefined when unsupported.
 */
export function normalizeAuthMethod(value: string | undefined): AgenrAuthMethod | undefined {
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

/**
 * Normalizes optional strings into trimmed values.
 *
 * @param value - Candidate string.
 * @returns Trimmed value, or undefined when blank.
 */
export function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Races one promise against a timeout.
 *
 * @param promise - Promise to await.
 * @param timeoutMs - Timeout in milliseconds.
 * @param message - Error message used when the timeout wins.
 * @returns Original promise result when it resolves in time.
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });

  return await Promise.race([promise, timeout]);
}

/**
 * Converts unknown thrown values into readable error messages.
 *
 * @param error - Unknown thrown value.
 * @returns Human-readable error message.
 */
export function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
