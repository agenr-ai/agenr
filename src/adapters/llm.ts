import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { completeSimple, getEnvApiKey, getModel, type Api, type KnownProvider, type Model } from "@mariozechner/pi-ai";

import { authMethodToProvider, isAgenrAuthMethod, type AgenrAuthMethod, type AgenrConfig, type AgenrStoredCredentials } from "../config.js";
import type { LlmPort } from "../core/ports.js";

const DEFAULT_REASONING = "medium";
const require = createRequire(import.meta.url);

/** Optional runtime overrides for the pi-ai-backed LLM client. */
type CreateLlmClientOptions = {
  apiKey?: string;
  reasoning?: "medium" | "high";
};

/** Stringly typed `getModel` signature used to avoid provider narrowing friction. */
type GetModelWithStrings = (provider: string, modelId: string) => Model<Api>;

/** Candidate credential plus the source it came from. */
interface CredentialCandidate {
  token: string;
  source: string;
}

/**
 * Resolved LLM credential plus source metadata.
 */
export interface ResolvedLlmCredentials {
  /** Token or API key passed to pi-ai. */
  apiKey: string;
  /** Human-readable source string for logs and setup summaries. */
  source: string;
  /** Auth method used when the credential came from one configured auth profile. */
  auth?: AgenrAuthMethod;
}

/**
 * Result of probing one auth method's available credential sources.
 */
export interface LlmCredentialProbeResult {
  /** Whether a usable credential was found. */
  available: boolean;
  /** Human-readable source string when available. */
  source?: string;
  /** Human-readable setup guidance when unavailable. */
  guidance: string;
  /** Resolved credential when available. */
  credentials?: ResolvedLlmCredentials;
}

const getModelWithStrings = getModel as unknown as GetModelWithStrings;

/**
 * Probes all configured sources for one auth method.
 *
 * @param params - Auth method, stored config credentials, and environment.
 * @returns Availability, source metadata, and setup guidance.
 */
export function probeLlmCredentials(params: {
  auth: AgenrAuthMethod;
  storedCredentials?: AgenrStoredCredentials;
  env?: NodeJS.ProcessEnv;
}): LlmCredentialProbeResult {
  const candidate = resolveCredentialCandidate(params);
  if (!candidate) {
    return {
      available: false,
      guidance: credentialSetupGuidance(params.auth),
    };
  }

  return {
    available: true,
    source: candidate.source,
    guidance: "Credentials available.",
    credentials: {
      apiKey: candidate.token,
      source: candidate.source,
      auth: params.auth,
    },
  };
}

/**
 * Resolves a configured auth method into a concrete token or API key.
 *
 * @param params - Auth method, stored config credentials, and environment.
 * @returns Resolved credential plus its source metadata.
 * @throws Error When no credential source is available.
 */
export function resolveAuthCredentials(params: {
  auth: AgenrAuthMethod;
  storedCredentials?: AgenrStoredCredentials;
  env?: NodeJS.ProcessEnv;
}): ResolvedLlmCredentials {
  const probe = probeLlmCredentials(params);
  if (!probe.available || !probe.credentials) {
    throw new Error(probe.guidance);
  }

  return probe.credentials;
}

/**
 * Accumulated token and cost usage for an LLM client instance.
 */
export interface UsageStats {
  /** Number of completion calls made. */
  calls: number;
  /** Total prompt/input tokens sent. */
  inputTokens: number;
  /** Total completion/output tokens received. */
  outputTokens: number;
  /** Total cached input tokens read. */
  cacheReadTokens: number;
  /** Total cached input tokens written. */
  cacheWriteTokens: number;
  /** Total tokens consumed across all calls. */
  totalTokens: number;
  /** Total model cost in USD. */
  totalCost: number;
}

/**
 * Metadata exposed by the pi-ai-backed LLM client.
 */
export interface LlmClientMetadata {
  /** The resolved pi-ai model object. */
  model: Model<Api>;
  /** Context window size in tokens. */
  contextWindowTokens: number;
  /** Max output tokens exposed by the model metadata. */
  maxOutputTokens: number;
  /** Whether the model supports reasoning/thinking. */
  supportsReasoning: boolean;
  /** Accumulated usage stats since client creation. */
  usage: UsageStats;
}

/**
 * Creates an LLM client backed by pi-ai's non-streaming completion API.
 *
 * @param provider - Model provider name understood by pi-ai.
 * @param modelId - Model identifier within the provider.
 * @param options - Optional API key and reasoning overrides.
 * @returns Core LLM port implementation plus resolved model metadata.
 */
export function createLlmClient(provider: string, modelId: string, options: CreateLlmClientOptions = {}): LlmPort & { metadata: LlmClientMetadata } {
  const model = getModelWithStrings(provider, modelId);
  const metadata: LlmClientMetadata = {
    model,
    contextWindowTokens: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    supportsReasoning: model.reasoning,
    usage: createEmptyUsageStats(),
  };

  const resolvedApiKey = normalizeOptionalString(options.apiKey);

  const requestCompletion = async (systemPrompt: string, userMessage: string) => {
    const response = await completeSimple(
      model,
      {
        systemPrompt,
        messages: [
          {
            role: "user",
            content: userMessage,
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: resolvedApiKey,
        reasoning: metadata.supportsReasoning ? (options.reasoning ?? DEFAULT_REASONING) : undefined,
      },
    );

    accumulateUsage(metadata.usage, response.usage);

    if (response.stopReason === "error") {
      throw new Error(response.errorMessage ?? `LLM completion failed for ${provider}/${modelId}.`);
    }

    return response;
  };

  const complete = async (systemPrompt: string, userMessage: string): Promise<string> => {
    const response = await requestCompletion(systemPrompt, userMessage);
    return extractText(response);
  };

  return {
    metadata,
    complete,
    completeJson: async <T>(systemPrompt: string, userMessage: string): Promise<T> => {
      const response = await requestCompletion(systemPrompt, userMessage);
      const text = extractText(response);
      return JSON.parse(stripCodeFence(text)) as T;
    },
  };
}

/**
 * Pipeline stages that can carry per-stage model overrides.
 */
export type LlmStage = "extraction" | "dedup" | "episode" | "claim" | "cross_encoder";

/**
 * Resolves the provider and model configured for a pipeline stage.
 *
 * @param config - Optional agenr runtime configuration.
 * @param stage - Pipeline stage that needs an LLM model.
 * @returns Provider and model ID to use for the requested stage.
 */
export function resolveModel(config: AgenrConfig | undefined, stage: LlmStage): { provider: string; modelId: string } {
  const override = resolveStageOverride(config, stage);

  return {
    provider: normalizeOptionalString(override?.provider) ?? resolveStageDefaultProvider(config, stage),
    modelId: normalizeOptionalString(override?.model) ?? resolveStageDefaultModel(config, stage),
  };
}

/** Returns the persisted per-stage model override for one pipeline stage. */
function resolveStageOverride(config: AgenrConfig | undefined, stage: LlmStage): { provider?: string; model?: string } | undefined {
  switch (stage) {
    case "extraction":
      return config?.extractionModel;
    case "dedup":
      return config?.dedupModel;
    case "episode":
      return config?.episodeModel;
    case "claim":
      return config?.claimExtraction?.model ?? config?.extractionModel;
    case "cross_encoder":
      return config?.crossEncoderModel;
  }
}

/** Returns the default provider for one pipeline stage when no override is set. */
function resolveStageDefaultProvider(config: AgenrConfig | undefined, stage: LlmStage): string {
  // The cross-encoder adapter talks to OpenAI's chat completions directly to
  // use `logprobs` + `logit_bias`. Fall back to `openai` for that stage when
  // the top-level provider is something pi-ai-specific like `openai-codex`.
  if (stage === "cross_encoder") {
    const topLevel = normalizeOptionalString(config?.provider);
    if (!topLevel || topLevel === "openai-codex") {
      return "openai";
    }
    return topLevel;
  }

  return normalizeOptionalString(config?.provider) ?? "openai";
}

/** Returns the default model ID for one pipeline stage when no override is set. */
function resolveStageDefaultModel(config: AgenrConfig | undefined, stage: LlmStage): string {
  // Cross-encoder does not inherit the top-level default model because that
  // model may not support `logprobs`/`logit_bias`. Always use the stage
  // default unless the caller sets `crossEncoderModel.model` explicitly.
  if (stage === "cross_encoder") {
    return defaultModelForStage(stage);
  }

  return normalizeOptionalString(config?.model) ?? defaultModelForStage(stage);
}

/**
 * Resolves the credential used for one LLM provider.
 *
 * @param config - Optional agenr runtime configuration.
 * @param provider - Provider whose credential should be resolved.
 * @param env - Process environment used for env-var and home-dir lookups.
 * @returns Resolved credential plus source metadata.
 */
export function resolveLlmCredentials(config: AgenrConfig | undefined, provider: string, env: NodeJS.ProcessEnv = process.env): ResolvedLlmCredentials {
  const normalizedProvider = normalizeOptionalString(provider);
  if (!normalizedProvider) {
    throw new Error("Provider is required to resolve LLM credentials.");
  }

  const auth = normalizeAuthMethod(config?.auth);
  if (auth && authMethodToProvider(auth) === normalizedProvider) {
    return resolveAuthCredentials({
      auth,
      storedCredentials: config?.credentials,
      env,
    });
  }

  const fallback = resolveProviderCredentialCandidate(config, normalizedProvider, env);
  if (fallback) {
    return {
      apiKey: fallback.token,
      source: fallback.source,
    };
  }

  if (normalizedProvider === "openai-codex") {
    throw new Error("No OpenAI subscription credential found. Run `codex auth` or configure `auth` as `openai-api-key`.");
  }

  const exampleEnv = normalizedProvider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  throw new Error(`No credential found for provider "${normalizedProvider}". Set the appropriate auth method in config or provide ${exampleEnv}.`);
}

/**
 * Resolves the token or API key string used for one LLM provider.
 *
 * @param config - Optional agenr runtime configuration.
 * @param provider - Provider whose credential should be resolved.
 * @param env - Process environment used for env-var and home-dir lookups.
 * @returns Credential string passed to pi-ai.
 */
export function resolveLlmApiKey(config: AgenrConfig | undefined, provider: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveLlmCredentials(config, provider, env).apiKey;
}

/**
 * Removes a single outer Markdown code fence from model output.
 *
 * @param text - Raw text returned by the model.
 * @returns Text without an outer ``` or ```json fence.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]+?)\s*```$/i.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

/** Returns the default model ID for a given ingestion pipeline stage. */
function defaultModelForStage(stage: LlmStage): string {
  switch (stage) {
    case "extraction":
    case "episode":
    case "claim":
      return "gpt-5.4-mini";
    case "dedup":
    case "cross_encoder":
      // The cross-encoder needs an OpenAI chat model that supports
      // `logprobs` + `logit_bias` for the True/False relevance classifier.
      // `gpt-5.4-nano` aligns with agenr's preferred gpt-5.4 family and
      // shares the dedup stage default.
      return "gpt-5.4-nano";
  }
}

/** Normalizes optional strings into trimmed non-empty values. */
function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Normalizes an optional auth-method string into a supported agenr auth ID. */
function normalizeAuthMethod(value: string | undefined): AgenrAuthMethod | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized && isAgenrAuthMethod(normalized) ? normalized : undefined;
}

/** Safely reads and parses a JSON file, returning `null` on failure. */
function safeReadJson(filePath: string): unknown {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Resolves the effective home directory used by CLI credential probes. */
function resolveHomeDir(env: NodeJS.ProcessEnv): string {
  const home = normalizeOptionalString(env.HOME);
  return home ? resolveUserPath(home) : os.homedir();
}

/** Resolves the effective Codex home directory for auth probing. */
function resolveCodexHome(env: NodeJS.ProcessEnv): string {
  const configured = normalizeOptionalString(env.CODEX_HOME) ?? "~/.codex";
  const resolved = resolveUserPath(configured);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** Resolves `~`-prefixed user paths without depending on CLI helpers. */
function resolveUserPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") {
    return os.homedir();
  }

  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }

  if (trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }

  return path.resolve(trimmed);
}

/** Parses Codex CLI auth from `auth.json` when available. */
function parseCodexFromFile(env: NodeJS.ProcessEnv): CredentialCandidate | null {
  const authPath = path.join(resolveCodexHome(env), "auth.json");
  const parsed = safeReadJson(authPath);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const tokens = record.tokens as Record<string, unknown> | undefined;
  const accessToken = tokens?.access_token;
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    return null;
  }

  return {
    token: accessToken.trim(),
    source: `file:${authPath}`,
  };
}

/** Resolves the keychain account name used by Codex CLI on macOS. */
function resolveCodexKeychainAccount(env: NodeJS.ProcessEnv): string {
  const hash = createHash("sha256").update(resolveCodexHome(env)).digest("hex");
  return `cli|${hash.slice(0, 16)}`;
}

/** Parses Codex CLI auth from the macOS keychain when available. */
function parseCodexFromKeychain(env: NodeJS.ProcessEnv): CredentialCandidate | null {
  if (process.platform !== "darwin") {
    return null;
  }

  try {
    const account = resolveCodexKeychainAccount(env);
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const raw = execSync(`security find-generic-password -s "Codex Auth" -a "${account}" -w`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5_000,
    }).trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const tokens = parsed.tokens as Record<string, unknown> | undefined;
    const accessToken = tokens?.access_token;
    if (typeof accessToken !== "string" || !accessToken.trim()) {
      return null;
    }

    return {
      token: accessToken.trim(),
      source: "keychain:Codex Auth",
    };
  } catch {
    return null;
  }
}

/** Parses a Claude credential record from either disk or keychain JSON. */
function parseClaudeCredentialRecord(parsed: unknown, source: string): CredentialCandidate | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const claudeOauth = record.claudeAiOauth as Record<string, unknown> | undefined;
  const accessToken = claudeOauth?.accessToken;
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    return null;
  }

  return {
    token: accessToken.trim(),
    source,
  };
}

/** Parses Claude Code OAuth credentials from disk when available. */
function parseClaudeFromFiles(env: NodeJS.ProcessEnv): CredentialCandidate | null {
  const homeDir = resolveHomeDir(env);
  const candidates = [path.join(homeDir, ".claude", ".credentials.json"), path.join(homeDir, ".claude", "credentials.json")];

  for (const candidate of candidates) {
    const parsed = safeReadJson(candidate);
    const resolved = parseClaudeCredentialRecord(parsed, `file:${candidate}`);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

/** Parses Claude Code OAuth credentials from the macOS keychain when available. */
function parseClaudeFromKeychain(): CredentialCandidate | null {
  if (process.platform !== "darwin") {
    return null;
  }

  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5_000,
    }).trim();
    return parseClaudeCredentialRecord(JSON.parse(raw), "keychain:Claude Code-credentials");
  } catch {
    return null;
  }
}

/** Converts an optional token string into a typed credential candidate. */
function candidateFromToken(token: string | undefined, source: string): CredentialCandidate | null {
  const normalized = normalizeOptionalString(token);
  if (!normalized) {
    return null;
  }

  return {
    token: normalized,
    source,
  };
}

/** Resolves OpenAI API-key credentials from env or stored config. */
function resolveOpenAIApiKeyCandidate(storedCredentials: AgenrStoredCredentials | undefined, env: NodeJS.ProcessEnv): CredentialCandidate | null {
  return candidateFromToken(env.OPENAI_API_KEY, "env:OPENAI_API_KEY") ?? candidateFromToken(storedCredentials?.openaiApiKey, "config:credentials.openaiApiKey");
}

/** Resolves Anthropic API-key credentials from env or stored config. */
function resolveAnthropicApiKeyCandidate(storedCredentials: AgenrStoredCredentials | undefined, env: NodeJS.ProcessEnv): CredentialCandidate | null {
  return (
    candidateFromToken(env.ANTHROPIC_API_KEY, "env:ANTHROPIC_API_KEY") ??
    candidateFromToken(storedCredentials?.anthropicApiKey, "config:credentials.anthropicApiKey")
  );
}

/** Resolves Anthropic long-lived token credentials from env or config. */
function resolveAnthropicTokenCandidate(storedCredentials: AgenrStoredCredentials | undefined, env: NodeJS.ProcessEnv): CredentialCandidate | null {
  return (
    candidateFromToken(env.ANTHROPIC_OAUTH_TOKEN, "env:ANTHROPIC_OAUTH_TOKEN") ??
    candidateFromToken(storedCredentials?.anthropicOauthToken, "config:credentials.anthropicOauthToken")
  );
}

/** Resolves auto-detected Anthropic OAuth credentials. */
function resolveAnthropicOauthCandidate(env: NodeJS.ProcessEnv): CredentialCandidate | null {
  return parseClaudeFromFiles(env) ?? parseClaudeFromKeychain();
}

/** Resolves auto-detected OpenAI subscription credentials. */
function resolveOpenAiSubscriptionCandidate(env: NodeJS.ProcessEnv): CredentialCandidate | null {
  return parseCodexFromFile(env) ?? parseCodexFromKeychain(env);
}

/** Builds human-readable setup guidance for one auth method. */
function credentialSetupGuidance(auth: AgenrAuthMethod): string {
  switch (auth) {
    case "anthropic-oauth":
      return "Claude Code credentials not found. Install Claude Code CLI and sign in with `claude`.";
    case "anthropic-token":
      return "No Anthropic long-lived token found. Set ANTHROPIC_OAUTH_TOKEN or save credentials.anthropicOauthToken.";
    case "anthropic-api-key":
      return "No Anthropic API key found. Set ANTHROPIC_API_KEY or save credentials.anthropicApiKey.";
    case "openai-subscription":
      return "Codex CLI credentials not found or expired. Run `codex auth`.";
    case "openai-api-key":
      return "No OpenAI API key found. Set OPENAI_API_KEY or save credentials.openaiApiKey.";
  }
}

/** Resolves the credential candidate used by one configured auth method. */
function resolveCredentialCandidate(params: {
  auth: AgenrAuthMethod;
  storedCredentials?: AgenrStoredCredentials;
  env?: NodeJS.ProcessEnv;
}): CredentialCandidate | null {
  const env = params.env ?? process.env;
  switch (params.auth) {
    case "anthropic-oauth":
      return resolveAnthropicOauthCandidate(env);
    case "anthropic-token":
      return resolveAnthropicTokenCandidate(params.storedCredentials, env);
    case "anthropic-api-key":
      return resolveAnthropicApiKeyCandidate(params.storedCredentials, env);
    case "openai-subscription":
      return resolveOpenAiSubscriptionCandidate(env);
    case "openai-api-key":
      return resolveOpenAIApiKeyCandidate(params.storedCredentials, env);
  }
}

/** Resolves direct provider credentials when auth-specific matching does not apply. */
function resolveProviderCredentialCandidate(config: AgenrConfig | undefined, provider: string, env: NodeJS.ProcessEnv): CredentialCandidate | null {
  if (provider === "openai") {
    return resolveOpenAIApiKeyCandidate(config?.credentials, env);
  }

  if (provider === "anthropic") {
    const auth = normalizeAuthMethod(config?.auth);
    if (auth && authMethodToProvider(auth) === "anthropic") {
      return resolveCredentialCandidate({
        auth,
        storedCredentials: config?.credentials,
        env,
      });
    }

    return resolveAnthropicApiKeyCandidate(config?.credentials, env);
  }

  const envApiKey = getEnvApiKey(provider as KnownProvider) ?? getEnvApiKey(provider);
  return candidateFromToken(envApiKey, `env:${provider}`);
}

/** Creates a zeroed usage counter object for a new client. */
function createEmptyUsageStats(): UsageStats {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  };
}

/** Adds a completion response's usage metrics into the running totals. */
function accumulateUsage(
  target: UsageStats,
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
      total: number;
    };
  },
): void {
  target.calls += 1;
  target.inputTokens += usage.input;
  target.outputTokens += usage.output;
  target.cacheReadTokens += usage.cacheRead;
  target.cacheWriteTokens += usage.cacheWrite;
  target.totalTokens += usage.totalTokens;
  target.totalCost += usage.cost.total;
}

/** Concatenates text blocks from a pi-ai completion response. */
function extractText(response: Awaited<ReturnType<typeof completeSimple>>): string {
  const blocks: string[] = [];
  for (const contentBlock of response.content) {
    if (contentBlock.type === "text") {
      blocks.push(contentBlock.text);
    }
  }

  return blocks.join("");
}
