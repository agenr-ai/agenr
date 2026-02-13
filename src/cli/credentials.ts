import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OAuthCredentials } from "@mariozechner/pi-ai";

import { resolveOAuthApiKey } from "./pi-ai-client";
import type { AgenrConfig, ApiKeyProvider, LlmProvider, LlmProviderPreference, ResolvedCredentials } from "./types";

const ONE_HOUR_MS = 60 * 60 * 1000;
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_BASE_URL = "https://api.openai.com";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const OPENAI_CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";

type OAuthProvider = "openai-codex" | "anthropic";

type OAuthCredentialSource = "codex-cli" | "claude-cli";

interface DiscoveredOAuthCredential {
  source: OAuthCredentialSource;
  authPath: string;
  credentials: OAuthCredentials;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readJsonFile(pathname: string): unknown {
  try {
    if (!fs.existsSync(pathname)) return null;
    const raw = fs.readFileSync(pathname, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJsonFile(pathname: string, payload: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function readNonEmptyString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = readString(record, key);
    if (value) return value;
  }
  return "";
}

function resolveUserPath(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function resolveCodexHomePath(): string {
  const configured = process.env.CODEX_HOME;
  const homePath = configured ? resolveUserPath(configured) : resolveUserPath("~/.codex");

  try {
    return fs.realpathSync.native(homePath);
  } catch {
    return homePath;
  }
}

function resolveCodexAuthPath(): string {
  return path.join(resolveCodexHomePath(), "auth.json");
}

function resolveClaudeCredentialPaths(): string[] {
  return [
    path.join(os.homedir(), ".claude", "credentials.json"),
    path.join(os.homedir(), ".claude", ".credentials.json"),
  ];
}

function normalizeExpiresAt(expiresAt: number): number {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return Date.now();
  if (expiresAt > 1e12) return expiresAt;
  if (expiresAt > 1e9) return expiresAt * 1000;
  return expiresAt;
}

function coerceExpiresAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return normalizeExpiresAt(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      return normalizeExpiresAt(numeric);
    }

    const parsedDate = Date.parse(trimmed);
    if (Number.isFinite(parsedDate) && parsedDate > 0) {
      return parsedDate;
    }
  }

  return null;
}

function deriveExpiryFromFile(pathname: string): number {
  try {
    const stat = fs.statSync(pathname);
    return stat.mtimeMs + ONE_HOUR_MS;
  } catch {
    return Date.now() + ONE_HOUR_MS;
  }
}

function parseProviderMapCredential(record: Record<string, unknown>, provider: OAuthProvider): OAuthCredentials | null {
  const providerRecord = asRecord(record[provider]);
  if (!providerRecord) return null;

  const entryType = readString(providerRecord, "type");
  if (entryType && entryType !== "oauth") return null;

  const access = readNonEmptyString(providerRecord, ["access", "accessToken", "access_token"]);
  const refresh = readNonEmptyString(providerRecord, ["refresh", "refreshToken", "refresh_token"]);
  const expires = coerceExpiresAt(providerRecord.expires ?? providerRecord.expiresAt ?? providerRecord.expires_at);

  if (!access || !refresh || !expires) return null;

  const credentials: OAuthCredentials = {
    access,
    refresh,
    expires,
  };

  const accountId = readNonEmptyString(providerRecord, ["accountId", "account_id"]);
  if (accountId) {
    credentials.accountId = accountId;
  }

  return credentials;
}

function parseCodexCredential(raw: unknown, authPath: string): OAuthCredentials | null {
  const record = asRecord(raw);
  if (!record) return null;

  const mappedCredential = parseProviderMapCredential(record, "openai-codex");
  if (mappedCredential) return mappedCredential;

  const tokens = asRecord(record.tokens);
  if (!tokens) return null;

  const access = readNonEmptyString(tokens, ["access_token", "accessToken", "access"]);
  const refresh = readNonEmptyString(tokens, ["refresh_token", "refreshToken", "refresh"]);
  if (!access || !refresh) return null;

  const expires =
    coerceExpiresAt(tokens.expires_at ?? tokens.expiresAt ?? record.expires_at ?? record.expiresAt ?? record.last_refresh) ??
    deriveExpiryFromFile(authPath);

  const credentials: OAuthCredentials = {
    access,
    refresh,
    expires,
  };

  const accountId = readNonEmptyString(tokens, ["account_id", "accountId"]);
  if (accountId) {
    credentials.accountId = accountId;
  }

  return credentials;
}

function parseClaudeCredential(raw: unknown, authPath: string): OAuthCredentials | null {
  const record = asRecord(raw);
  if (!record) return null;

  const mappedCredential = parseProviderMapCredential(record, "anthropic");
  if (mappedCredential) return mappedCredential;

  const oauth = asRecord(record.claudeAiOauth);
  if (!oauth) return null;

  const access = readNonEmptyString(oauth, ["accessToken", "access_token", "access"]);
  if (!access) return null;

  const refresh = readNonEmptyString(oauth, ["refreshToken", "refresh_token", "refresh"]);
  const expires = coerceExpiresAt(oauth.expiresAt ?? oauth.expires_at ?? oauth.expires) ?? deriveExpiryFromFile(authPath);

  return {
    access,
    refresh,
    expires,
  };
}

function readCodexCliCredential(): DiscoveredOAuthCredential | null {
  const authPath = resolveCodexAuthPath();
  const raw = readJsonFile(authPath);
  const credentials = parseCodexCredential(raw, authPath);
  if (!credentials) return null;

  return {
    source: "codex-cli",
    authPath,
    credentials,
  };
}

function readClaudeKeychainCredential(): DiscoveredOAuthCredential | null {
  if (process.platform !== "darwin") return null;
  try {
    const raw = execSync(
      "security find-generic-password -s 'Claude Code-credentials' -w",
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const credentials = parseClaudeCredential(parsed, "keychain:Claude Code-credentials");
    if (credentials) {
      return {
        source: "claude-cli",
        authPath: "keychain:Claude Code-credentials",
        credentials,
      };
    }
  } catch {
    // Keychain not available or no entry found
  }
  return null;
}

function readClaudeCliCredential(): DiscoveredOAuthCredential | null {
  for (const authPath of resolveClaudeCredentialPaths()) {
    const raw = readJsonFile(authPath);
    const credentials = parseClaudeCredential(raw, authPath);
    if (credentials) {
      return {
        source: "claude-cli",
        authPath,
        credentials,
      };
    }
  }

  // Fall back to macOS Keychain (Claude Code stores OAuth tokens there)
  return readClaudeKeychainCredential();
}

function oauthCredentialsChanged(previous: OAuthCredentials, next: OAuthCredentials): boolean {
  const previousAccountId = typeof previous.accountId === "string" ? previous.accountId : "";
  const nextAccountId = typeof next.accountId === "string" ? next.accountId : "";

  return (
    previous.access !== next.access ||
    previous.refresh !== next.refresh ||
    normalizeExpiresAt(previous.expires) !== normalizeExpiresAt(next.expires) ||
    previousAccountId !== nextAccountId
  );
}

function persistCodexCredential(authPath: string, credentials: OAuthCredentials): void {
  const existing = asRecord(readJsonFile(authPath)) ?? {};
  const existingTokens = asRecord(existing.tokens) ?? {};

  existingTokens.access_token = credentials.access;
  existingTokens.refresh_token = credentials.refresh;

  if (typeof credentials.accountId === "string" && credentials.accountId.trim()) {
    existingTokens.account_id = credentials.accountId.trim();
  }

  existing.tokens = existingTokens;
  existing.last_refresh = new Date().toISOString();

  writeJsonFile(authPath, existing);
}

function persistClaudeCredential(authPath: string, credentials: OAuthCredentials): void {
  const existing = asRecord(readJsonFile(authPath)) ?? {};
  const existingOauth = asRecord(existing.claudeAiOauth) ?? {};

  existingOauth.accessToken = credentials.access;
  existingOauth.refreshToken = credentials.refresh;
  existingOauth.expiresAt = normalizeExpiresAt(credentials.expires);

  existing.claudeAiOauth = existingOauth;

  writeJsonFile(authPath, existing);
}

function persistOAuthCredential(discovered: DiscoveredOAuthCredential, credentials: OAuthCredentials): void {
  try {
    if (discovered.authPath.startsWith("keychain:")) {
      // Claude keychain entries are not file paths. Avoid writing refreshed tokens to disk.
      return;
    }

    if (discovered.source === "codex-cli") {
      persistCodexCredential(discovered.authPath, credentials);
      return;
    }

    persistClaudeCredential(discovered.authPath, credentials);
  } catch {
    // Ignore write failures: we can still continue with in-memory credentials for this run.
  }
}

export function detectProviderFromApiKey(apiKey: string): ApiKeyProvider {
  return apiKey.startsWith("sk-ant") ? "anthropic" : "openai";
}

function isAnthropicSubscriptionToken(token: string): boolean {
  return token.includes("sk-ant-oat");
}

function isLikelyAnthropicApiKey(token: string): boolean {
  return token.startsWith("sk-ant-") && !isAnthropicSubscriptionToken(token);
}

function extractOpenAICodexAccountId(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const accountId = payload?.[OPENAI_CODEX_JWT_CLAIM_PATH]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.trim().length > 0 ? accountId.trim() : null;
  } catch {
    return null;
  }
}

export function detectProviderFromSubscriptionToken(token: string): "anthropic" | "openai-codex" | null {
  if (isAnthropicSubscriptionToken(token)) {
    return "anthropic";
  }

  if (extractOpenAICodexAccountId(token)) {
    return "openai-codex";
  }

  return null;
}

function resolveBaseUrl(provider: LlmProvider): string {
  if (provider === "openai-codex") return OPENAI_CODEX_BASE_URL;
  if (provider === "anthropic") return ANTHROPIC_BASE_URL;
  return OPENAI_BASE_URL;
}

function resolveSubscriptionTokenCredentials(
  token: string,
  mismatchNotes: string[],
  sourceLabel: string,
): ResolvedCredentials | null {
  const provider = detectProviderFromSubscriptionToken(token);
  if (!provider) {
    if (isLikelyAnthropicApiKey(token)) {
      mismatchNotes.push(
        `${sourceLabel} looks like an Anthropic API key, not a Claude subscription token. Use 'agenr config set api-key anthropic <key>'.`,
      );
    } else {
      mismatchNotes.push(`${sourceLabel} format was not recognized as a supported subscription token.`);
    }
    return null;
  }

  if (provider === "openai-codex") {
    mismatchNotes.push(
      `${sourceLabel} looks like a Codex subscription JWT token. Agenr uses Codex CLI OAuth for provider 'codex'.`,
    );
    return null;
  }

  return {
    provider: "anthropic",
    source: "subscription-token",
    authMode: "subscription-token",
    token,
    baseUrl: resolveBaseUrl("anthropic"),
  };
}

function resolveProviderApiKeyCredentials(
  provider: ApiKeyProvider,
  token: string,
  mismatchNotes: string[],
  sourceLabel: string,
): ResolvedCredentials | null {
  const subscriptionProvider = detectProviderFromSubscriptionToken(token);
  if (subscriptionProvider) {
    if (subscriptionProvider === "openai-codex") {
      mismatchNotes.push(
        `${sourceLabel} looks like a Codex subscription JWT token. Use provider 'codex' (Codex CLI OAuth) instead of api-key auth.`,
      );
    } else {
      mismatchNotes.push(
        `${sourceLabel} looks like a ${subscriptionProvider} subscription token. Use 'agenr config set subscription-token <token>' instead.`,
      );
    }
    return null;
  }

  const detectedProvider = detectProviderFromApiKey(token);
  if (provider === "anthropic" && detectedProvider !== "anthropic") {
    mismatchNotes.push(`${sourceLabel} is not an Anthropic API key format.`);
    return null;
  }

  if (provider === "openai" && detectedProvider === "anthropic") {
    mismatchNotes.push(`${sourceLabel} is an Anthropic API key, not an OpenAI-family key.`);
    return null;
  }

  const runtimeProvider: LlmProvider = provider === "openai" ? "openai" : "anthropic";

  return {
    provider: runtimeProvider,
    source: "api-key",
    authMode: "api-key",
    token,
    baseUrl: resolveBaseUrl(runtimeProvider),
  };
}

function buildNoCredentialsErrorMessage(
  providerPreference: LlmProviderPreference,
  mismatchNotes: string[],
): string {
  const switchHelp =
    "To use another provider, run: agenr config set provider <openai-api|codex|claude-code|anthropic-api>.";

  let providerHelp: string;
  if (providerPreference === "codex") {
    providerHelp = "No codex credentials found. Sign in via Codex CLI OAuth.";
  } else if (providerPreference === "openai-api") {
    providerHelp =
      "No openai-api credentials found. Set AGENR_LLM_OPENAI_API_KEY or OPENAI_API_KEY, or run: agenr config set api-key openai <key>.";
  } else if (providerPreference === "anthropic-api") {
    providerHelp =
      "No anthropic-api credentials found. Set AGENR_LLM_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY, or run: agenr config set api-key anthropic <key>.";
  } else {
    providerHelp =
      "No claude-code credentials found. Run 'claude login' (or re-login), set AGENR_LLM_SUBSCRIPTION_TOKEN, or run: agenr config set subscription-token <token>.";
  }

  return `${providerHelp} ${switchHelp}${mismatchNotes.length > 0 ? ` (${mismatchNotes.join(" ")})` : ""}`;
}

function apiKeyEnvVarNames(provider: ApiKeyProvider): string[] {
  return provider === "openai"
    ? ["AGENR_LLM_OPENAI_API_KEY", "OPENAI_API_KEY"]
    : ["AGENR_LLM_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"];
}

function readProviderApiKeyEnv(provider: ApiKeyProvider): string {
  for (const envName of apiKeyEnvVarNames(provider)) {
    const value = process.env[envName]?.trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function apiKeyEnvVarName(provider: ApiKeyProvider): string {
  return apiKeyEnvVarNames(provider).join(" or ");
}

async function resolveOAuthCredentials(
  provider: OAuthProvider,
  discovered: DiscoveredOAuthCredential,
  mismatchNotes: string[],
): Promise<ResolvedCredentials | null> {
  try {
    const result = await resolveOAuthApiKey(provider, discovered.credentials);
    if (!result) return null;

    if (oauthCredentialsChanged(discovered.credentials, result.newCredentials)) {
      persistOAuthCredential(discovered, result.newCredentials);
    }

    const accountId =
      typeof result.newCredentials.accountId === "string" && result.newCredentials.accountId.trim().length > 0
        ? result.newCredentials.accountId.trim()
        : undefined;

    return {
      provider,
      source: discovered.source,
      authMode: "oauth",
      token: result.apiKey,
      refreshToken: result.newCredentials.refresh,
      expiresAt: normalizeExpiresAt(result.newCredentials.expires),
      accountId,
      baseUrl: resolveBaseUrl(provider),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const sourceLabel = discovered.source === "codex-cli" ? "Codex CLI" : "Claude Code CLI";
    mismatchNotes.push(`${sourceLabel} OAuth unavailable (${message}).`);
    return null;
  }
}

export async function resolveCredentials(
  config: AgenrConfig,
  providerOverride?: LlmProviderPreference,
): Promise<ResolvedCredentials> {
  const providerPreference = providerOverride ?? config.llm.provider;
  const mismatchNotes: string[] = [];

  if (providerPreference === "codex") {
    const codex = readCodexCliCredential();
    if (codex) {
      const resolved = await resolveOAuthCredentials("openai-codex", codex, mismatchNotes);
      if (resolved) {
        return resolved;
      }
    }
    throw new Error(buildNoCredentialsErrorMessage(providerPreference, mismatchNotes));
  }

  if (providerPreference === "claude-code") {
    const claude = readClaudeCliCredential();
    if (claude) {
      const resolved = await resolveOAuthCredentials("anthropic", claude, mismatchNotes);
      if (resolved) {
        return resolved;
      }
    }

    const envSubscriptionToken = process.env.AGENR_LLM_SUBSCRIPTION_TOKEN?.trim();
    if (envSubscriptionToken) {
      const resolved = resolveSubscriptionTokenCredentials(
        envSubscriptionToken,
        mismatchNotes,
        "AGENR_LLM_SUBSCRIPTION_TOKEN",
      );
      if (resolved) {
        return resolved;
      }
    }

    const configuredSubscriptionToken = config.llm.subscriptionToken?.trim();
    if (configuredSubscriptionToken) {
      const resolved = resolveSubscriptionTokenCredentials(
        configuredSubscriptionToken,
        mismatchNotes,
        "Configured subscription token",
      );
      if (resolved) {
        return resolved;
      }
    }

    throw new Error(buildNoCredentialsErrorMessage(providerPreference, mismatchNotes));
  }

  if (providerPreference === "openai-api" || providerPreference === "anthropic-api") {
    const apiProvider: ApiKeyProvider = providerPreference === "openai-api" ? "openai" : "anthropic";

    const envApiKey = readProviderApiKeyEnv(apiProvider);
    if (envApiKey) {
      const resolved = resolveProviderApiKeyCredentials(
        apiProvider,
        envApiKey,
        mismatchNotes,
        apiKeyEnvVarName(apiProvider),
      );
      if (resolved) {
        return resolved;
      }
    }

    const configuredApiKey = config.llm.apiKeys[apiProvider]?.trim();
    if (configuredApiKey) {
      const resolved = resolveProviderApiKeyCredentials(
        apiProvider,
        configuredApiKey,
        mismatchNotes,
        `Configured API key (${apiProvider})`,
      );
      if (resolved) {
        return resolved;
      }
    }

    throw new Error(buildNoCredentialsErrorMessage(providerPreference, mismatchNotes));
  }

  throw new Error(buildNoCredentialsErrorMessage(providerPreference, mismatchNotes));
}

export function formatCredentialSummary(credentials: ResolvedCredentials): string {
  const sourceLabel =
    credentials.source === "codex-cli"
      ? "OAuth (via Codex CLI)"
      : credentials.source === "claude-cli"
        ? "OAuth (via Claude Code CLI)"
        : credentials.source === "subscription-token"
          ? "Subscription token"
        : "API key";

  if (!credentials.expiresAt) {
    return sourceLabel;
  }

  return `${sourceLabel} (expires ${new Date(credentials.expiresAt).toISOString()})`;
}
