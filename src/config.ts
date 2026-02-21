import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveModel } from "./llm/models.js";
import type { AgenrAuthMethod, AgenrConfig, AgenrProvider } from "./types.js";
import { normalizeLabel } from "./utils/string.js";

export type ConfigSetKey = "provider" | "model" | "auth";
export type StoredCredentialKeyName = "anthropic" | "anthropic-token" | "openai";

export interface AuthMethodDefinition {
  id: AgenrAuthMethod;
  provider: AgenrProvider;
  title: string;
  setupDescription: string;
  preferredModels: string[];
}

export const AUTH_METHOD_DEFINITIONS: readonly AuthMethodDefinition[] = [
  {
    id: "anthropic-oauth",
    provider: "anthropic",
    title: "Anthropic -- Claude subscription (OAuth)",
    setupDescription:
      "Uses your Claude Pro/Team subscription via Claude CLI credentials. No per-token cost. Requires Claude Code CLI.",
    preferredModels: ["claude-opus-4-6", "claude-sonnet-4-20250514", "claude-haiku-3-5-20241022"],
  },
  {
    id: "anthropic-token",
    provider: "anthropic",
    title: "Anthropic -- Claude subscription (long-lived token)",
    setupDescription:
      "Uses a long-lived token from `claude setup-token`. No per-token cost. Simpler setup.",
    preferredModels: ["claude-opus-4-6", "claude-sonnet-4-20250514", "claude-haiku-3-5-20241022"],
  },
  {
    id: "anthropic-api-key",
    provider: "anthropic",
    title: "Anthropic -- API key",
    setupDescription: "Standard API key from console.anthropic.com. Pay per token.",
    preferredModels: ["claude-sonnet-4-20250514", "claude-opus-4-6", "claude-haiku-3-5-20241022"],
  },
  {
    id: "openai-subscription",
    provider: "openai-codex",
    title: "OpenAI -- Subscription (via Codex CLI)",
    setupDescription:
      "Uses your ChatGPT Plus subscription via Codex CLI credentials. No per-token cost. Requires Codex CLI.",
    preferredModels: ["gpt-5.3-codex", "o3-codex"],
  },
  {
    id: "openai-api-key",
    provider: "openai",
    title: "OpenAI -- API key",
    setupDescription: "Standard API key from platform.openai.com. Pay per token.",
    preferredModels: ["gpt-5.2-codex", "gpt-4o", "openai/gpt-4.1-nano", "gpt-4o-mini"],
  },
] as const;

const AUTH_METHOD_SET = new Set<AgenrAuthMethod>(AUTH_METHOD_DEFINITIONS.map((item) => item.id));
const PROVIDER_SET = new Set<AgenrProvider>(["anthropic", "openai", "openai-codex"]);
const CONFIG_FILE_MODE = 0o600;
const CONFIG_DIR_MODE = 0o700;
const DEFAULT_EMBEDDING_PROVIDER = "openai";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_EMBEDDING_DIMENSIONS = 1024;
const DEFAULT_FORGETTING_SCORE_THRESHOLD = 0.05;
const DEFAULT_FORGETTING_MAX_AGE_DAYS = 60;

function resolveUserPath(inputPath: string): string {
  if (!inputPath.startsWith("~")) {
    return inputPath;
  }
  return path.join(os.homedir(), inputPath.slice(1));
}

function resolveDefaultKnowledgeDbPath(): string {
  return path.join(os.homedir(), ".agenr", "knowledge.db");
}

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.AGENR_CONFIG_PATH?.trim();
  if (explicit) {
    return resolveUserPath(explicit);
  }
  return path.join(os.homedir(), ".agenr", "config.json");
}

export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.dirname(resolveConfigPath(env));
}

export function isAgenrAuthMethod(value: string): value is AgenrAuthMethod {
  return AUTH_METHOD_SET.has(value as AgenrAuthMethod);
}

export function isAgenrProvider(value: string): value is AgenrProvider {
  return PROVIDER_SET.has(value as AgenrProvider);
}

export function authMethodToProvider(auth: AgenrAuthMethod): AgenrProvider {
  return AUTH_METHOD_DEFINITIONS.find((item) => item.id === auth)?.provider ?? "anthropic";
}

export function getAuthMethodDefinition(auth: AgenrAuthMethod): AuthMethodDefinition {
  const found = AUTH_METHOD_DEFINITIONS.find((item) => item.id === auth);
  if (!found) {
    throw new Error(`Unsupported auth method \"${auth}\".`);
  }
  return found;
}

function normalizeStoredCredentials(input: unknown): AgenrConfig["credentials"] | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  const normalized: NonNullable<AgenrConfig["credentials"]> = {};

  if (typeof record.anthropicApiKey === "string" && record.anthropicApiKey.trim()) {
    normalized.anthropicApiKey = record.anthropicApiKey.trim();
  }

  if (typeof record.anthropicOauthToken === "string" && record.anthropicOauthToken.trim()) {
    normalized.anthropicOauthToken = record.anthropicOauthToken.trim();
  }

  if (typeof record.openaiApiKey === "string" && record.openaiApiKey.trim()) {
    normalized.openaiApiKey = record.openaiApiKey.trim();
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeEmbeddingConfig(input: unknown): NonNullable<AgenrConfig["embedding"]> {
  const normalized: NonNullable<AgenrConfig["embedding"]> = {
    provider: DEFAULT_EMBEDDING_PROVIDER,
    model: DEFAULT_EMBEDDING_MODEL,
    dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
  };

  if (!input || typeof input !== "object") {
    return normalized;
  }

  const record = input as Record<string, unknown>;

  if (record.provider === "openai") {
    normalized.provider = record.provider;
  }

  if (typeof record.model === "string" && record.model.trim()) {
    normalized.model = record.model.trim();
  }

  if (typeof record.dimensions === "number" && Number.isFinite(record.dimensions) && record.dimensions > 0) {
    normalized.dimensions = Math.floor(record.dimensions);
  }

  if (typeof record.apiKey === "string" && record.apiKey.trim()) {
    normalized.apiKey = record.apiKey.trim();
  }

  return normalized;
}

function normalizeDbConfig(input: unknown): NonNullable<AgenrConfig["db"]> {
  const normalized: NonNullable<AgenrConfig["db"]> = {
    path: resolveDefaultKnowledgeDbPath(),
  };

  if (!input || typeof input !== "object") {
    return normalized;
  }

  const record = input as Record<string, unknown>;
  if (typeof record.path === "string" && record.path.trim()) {
    normalized.path = record.path.trim();
  }

  return normalized;
}

function normalizeForgettingConfig(input: unknown): NonNullable<AgenrConfig["forgetting"]> {
  const normalized: NonNullable<AgenrConfig["forgetting"]> = {
    protect: [],
    scoreThreshold: DEFAULT_FORGETTING_SCORE_THRESHOLD,
    maxAgeDays: DEFAULT_FORGETTING_MAX_AGE_DAYS,
    enabled: true,
  };

  if (!input || typeof input !== "object") {
    return normalized;
  }

  const record = input as Record<string, unknown>;

  if (Array.isArray(record.protect)) {
    normalized.protect = record.protect
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  if (
    typeof record.scoreThreshold === "number" &&
    Number.isFinite(record.scoreThreshold) &&
    record.scoreThreshold >= 0 &&
    record.scoreThreshold <= 1
  ) {
    normalized.scoreThreshold = record.scoreThreshold;
  }

  if (
    typeof record.maxAgeDays === "number" &&
    Number.isFinite(record.maxAgeDays) &&
    record.maxAgeDays >= 0
  ) {
    normalized.maxAgeDays = Math.floor(record.maxAgeDays);
  }

  if (typeof record.enabled === "boolean") {
    normalized.enabled = record.enabled;
  }

  return normalized;
}

function normalizeDedupConfig(input: unknown): AgenrConfig["dedup"] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  const normalized: NonNullable<AgenrConfig["dedup"]> = {};

  if (typeof record.aggressive === "boolean") {
    normalized.aggressive = record.aggressive;
  }

  if (typeof record.threshold === "number" && Number.isFinite(record.threshold) && record.threshold >= 0 && record.threshold <= 1) {
    normalized.threshold = record.threshold;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeLabelProjectMap(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const out: Record<string, string> = {};
  for (const [rawLabel, rawProject] of Object.entries(input as Record<string, unknown>)) {
    if (typeof rawProject !== "string") {
      continue;
    }

    const label = normalizeLabel(rawLabel);
    const project = rawProject.trim();

    if (!label || !project) {
      continue;
    }

    out[label] = project;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizeConfig(input: unknown): AgenrConfig {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const normalized: AgenrConfig = {
    embedding: normalizeEmbeddingConfig(record.embedding),
    db: normalizeDbConfig(record.db),
    forgetting: normalizeForgettingConfig(record.forgetting),
  };

  if (typeof record.auth === "string") {
    const auth = record.auth.trim();
    if (isAgenrAuthMethod(auth)) {
      normalized.auth = auth;
    }
  }

  if (typeof record.provider === "string") {
    const provider = record.provider.trim().toLowerCase();
    if (isAgenrProvider(provider)) {
      normalized.provider = provider;
    }
  }

  if (typeof record.model === "string" && record.model.trim()) {
    normalized.model = record.model.trim();
  }

  const credentials = normalizeStoredCredentials(record.credentials);
  if (credentials) {
    normalized.credentials = credentials;
  }

  const labelProjectMap = normalizeLabelProjectMap(record.labelProjectMap);
  if (labelProjectMap) {
    normalized.labelProjectMap = labelProjectMap;
  }

  const dedup = normalizeDedupConfig(record.dedup);
  if (dedup) {
    normalized.dedup = dedup;
  }

  return normalized;
}

function ensureConfigDir(env: NodeJS.ProcessEnv = process.env): void {
  const configDir = resolveConfigDir(env);
  fs.mkdirSync(configDir, { recursive: true, mode: CONFIG_DIR_MODE });

  try {
    fs.chmodSync(configDir, CONFIG_DIR_MODE);
  } catch {
    // Best-effort permission hardening.
  }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AgenrConfig | null {
  const configPath = resolveConfigPath(env);

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to parse config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return normalizeConfig(parsed);
}

export function writeConfig(config: AgenrConfig, env: NodeJS.ProcessEnv = process.env): void {
  ensureConfigDir(env);
  const configPath = resolveConfigPath(env);
  const normalized = normalizeConfig(config);
  fs.writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: "utf8",
    mode: CONFIG_FILE_MODE,
  });

  try {
    fs.chmodSync(configPath, CONFIG_FILE_MODE);
  } catch {
    // Best-effort permission hardening.
  }
}

export function mergeConfigPatch(current: AgenrConfig | null, patch: AgenrConfig): AgenrConfig {
  const merged: AgenrConfig = {
    ...(current ?? {}),
    ...patch,
  };

  if (current?.credentials || patch.credentials) {
    merged.credentials = {
      ...(current?.credentials ?? {}),
      ...(patch.credentials ?? {}),
    };

    if (Object.keys(merged.credentials).length === 0) {
      delete merged.credentials;
    }
  }

  if (current?.embedding || patch.embedding) {
    merged.embedding = {
      ...(current?.embedding ?? {}),
      ...(patch.embedding ?? {}),
    };
  }

  if (current?.db || patch.db) {
    merged.db = {
      ...(current?.db ?? {}),
      ...(patch.db ?? {}),
    };
  }

  if (current?.forgetting || patch.forgetting) {
    merged.forgetting = {
      ...(current?.forgetting ?? {}),
      ...(patch.forgetting ?? {}),
    };
  }

  if (current?.dedup || patch.dedup) {
    merged.dedup = {
      ...(current?.dedup ?? {}),
      ...(patch.dedup ?? {}),
    };
  }

  return normalizeConfig(merged);
}

function modelIsValid(provider: AgenrProvider, model: string): boolean {
  try {
    resolveModel(provider, model);
    return true;
  } catch {
    return false;
  }
}

function normalizeValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Value cannot be empty.");
  }
  return trimmed;
}

export function isCompleteConfig(config: AgenrConfig | null): config is Required<Pick<AgenrConfig, "auth" | "provider" | "model">> & AgenrConfig {
  if (!config?.auth || !config.provider || !config.model) {
    return false;
  }

  return authMethodToProvider(config.auth) === config.provider;
}

export function setConfigKey(current: AgenrConfig | null, key: ConfigSetKey, value: string): { config: AgenrConfig; warnings: string[] } {
  const warnings: string[] = [];
  const next = mergeConfigPatch(current, {});
  const normalizedValue = normalizeValue(value);

  if (key === "auth") {
    if (!isAgenrAuthMethod(normalizedValue)) {
      throw new Error(
        `Invalid auth method \"${value}\". Expected one of: anthropic-oauth, anthropic-token, anthropic-api-key, openai-subscription, openai-api-key.`,
      );
    }

    next.auth = normalizedValue;
    next.provider = authMethodToProvider(normalizedValue);

    if (next.model && !modelIsValid(next.provider, next.model)) {
      warnings.push(
        `Warning: model \"${next.model}\" is not available for provider \"${next.provider}\". Update it with: agenr config set model <model>.`,
      );
    }

    return { config: next, warnings };
  }

  if (key === "provider") {
    const provider = normalizedValue.toLowerCase();
    if (!isAgenrProvider(provider)) {
      throw new Error(`Invalid provider \"${value}\". Expected one of: anthropic, openai, openai-codex.`);
    }

    if (next.auth) {
      const expectedProvider = authMethodToProvider(next.auth);
      if (provider !== expectedProvider) {
        throw new Error(
          `Provider \"${provider}\" is incompatible with auth \"${next.auth}\". Use \`agenr config set auth <method>\` to switch auth/provider together.`,
        );
      }
    }

    next.provider = provider;

    if (next.model && !modelIsValid(next.provider, next.model)) {
      warnings.push(
        `Warning: model \"${next.model}\" is not available for provider \"${next.provider}\". Update it with: agenr config set model <model>.`,
      );
    }

    return { config: next, warnings };
  }

  if (!next.provider) {
    throw new Error("Cannot set model before provider. Configure auth first: agenr config set auth <method>");
  }

  const resolved = resolveModel(next.provider, normalizedValue);
  next.model = resolved.modelId;

  return { config: next, warnings };
}

export function setStoredCredential(
  current: AgenrConfig | null,
  keyName: StoredCredentialKeyName,
  secret: string,
): AgenrConfig {
  const normalizedSecret = normalizeValue(secret);
  const next = mergeConfigPatch(current, {});
  const credentials = {
    ...(next.credentials ?? {}),
  };

  if (keyName === "anthropic") {
    credentials.anthropicApiKey = normalizedSecret;
  } else if (keyName === "anthropic-token") {
    credentials.anthropicOauthToken = normalizedSecret;
  } else if (keyName === "openai") {
    credentials.openaiApiKey = normalizedSecret;
  } else {
    throw new Error(
      `Invalid key name \"${keyName}\". Expected one of: anthropic, anthropic-token, openai.`,
    );
  }

  next.credentials = credentials;
  return next;
}

export function maskSecret(secret: string | undefined): string {
  if (!secret) {
    return "(not set)";
  }

  const trimmed = secret.trim();
  if (!trimmed) {
    return "(not set)";
  }

  return `****${trimmed.slice(-4)}`;
}

export function describeAuth(auth: AgenrAuthMethod): string {
  if (auth === "anthropic-oauth") {
    return "Anthropic subscription (OAuth)";
  }
  if (auth === "anthropic-token") {
    return "Anthropic subscription (long-lived token)";
  }
  if (auth === "anthropic-api-key") {
    return "Anthropic API key";
  }
  if (auth === "openai-subscription") {
    return "OpenAI subscription (Codex CLI)";
  }
  return "OpenAI API key";
}
