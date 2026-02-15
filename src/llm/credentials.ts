import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgenrAuthMethod, AgenrStoredCredentials, ResolvedCredentials } from "../types.js";

interface CredentialCandidate {
  token: string;
  source: string;
}

export interface CredentialProbeResult {
  available: boolean;
  source?: string;
  credentials?: ResolvedCredentials;
  guidance: string;
}

type ParsedCodexAuth = {
  accessToken: string;
  source: string;
};

type ParsedClaudeAuth = {
  accessToken: string;
  source: string;
};

function safeReadJson(filePath: string): unknown {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveUserPath(inputPath: string): string {
  if (!inputPath.startsWith("~")) {
    return inputPath;
  }
  return path.join(os.homedir(), inputPath.slice(1));
}

function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME?.trim();
  if (home) {
    return resolveUserPath(home);
  }
  return os.homedir();
}

function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const codexHome = env.CODEX_HOME ? resolveUserPath(env.CODEX_HOME) : "~/.codex";
  const resolved = resolveUserPath(codexHome);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function parseCodexFromFile(env: NodeJS.ProcessEnv = process.env): ParsedCodexAuth | null {
  const authPath = path.join(resolveCodexHome(env), "auth.json");
  const parsed = safeReadJson(authPath);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const tokens = record.tokens as Record<string, unknown> | undefined;
  if (!tokens || typeof tokens !== "object") {
    return null;
  }

  const accessToken = tokens.access_token;
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    return null;
  }

  return { accessToken, source: `file:${authPath}` };
}

function resolveCodexKeychainAccount(env: NodeJS.ProcessEnv = process.env): string {
  const hash = createHash("sha256").update(resolveCodexHome(env)).digest("hex");
  return `cli|${hash.slice(0, 16)}`;
}

function parseCodexFromKeychain(env: NodeJS.ProcessEnv = process.env): ParsedCodexAuth | null {
  if (process.platform !== "darwin") {
    return null;
  }

  try {
    const account = resolveCodexKeychainAccount(env);
    const raw = execSync(`security find-generic-password -s "Codex Auth" -a "${account}" -w`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const tokens = parsed.tokens as Record<string, unknown> | undefined;
    const accessToken = tokens?.access_token;
    if (typeof accessToken !== "string" || !accessToken.trim()) {
      return null;
    }

    return { accessToken, source: "keychain:Codex Auth" };
  } catch {
    return null;
  }
}

function parseClaudeCredentialRecord(parsed: unknown, source: string): ParsedClaudeAuth | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const claudeOauth = record.claudeAiOauth as Record<string, unknown> | undefined;
  if (!claudeOauth || typeof claudeOauth !== "object") {
    return null;
  }

  const accessToken = claudeOauth.accessToken;
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    return null;
  }

  return { accessToken, source };
}

function parseClaudeFromFiles(env: NodeJS.ProcessEnv = process.env): ParsedClaudeAuth | null {
  const homeDir = resolveHomeDir(env);
  const candidates = [
    path.join(homeDir, ".claude", ".credentials.json"),
    path.join(homeDir, ".claude", "credentials.json"),
  ];

  for (const candidate of candidates) {
    const parsed = safeReadJson(candidate);
    const result = parseClaudeCredentialRecord(parsed, `file:${candidate}`);
    if (result) {
      return result;
    }
  }

  return null;
}

function parseClaudeFromKeychain(): ParsedClaudeAuth | null {
  if (process.platform !== "darwin") {
    return null;
  }

  try {
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();

    return parseClaudeCredentialRecord(JSON.parse(raw), "keychain:Claude Code-credentials");
  } catch {
    return null;
  }
}

function candidateFromToken(token: string | undefined, source: string): CredentialCandidate | null {
  const normalized = token?.trim();
  if (!normalized) {
    return null;
  }
  return {
    token: normalized,
    source,
  };
}

function resolveAnthropicOauthCredentials(env: NodeJS.ProcessEnv): CredentialCandidate | null {
  const file = parseClaudeFromFiles(env);
  if (file) {
    return {
      token: file.accessToken,
      source: file.source,
    };
  }

  const keychain = parseClaudeFromKeychain();
  if (keychain) {
    return {
      token: keychain.accessToken,
      source: keychain.source,
    };
  }

  return null;
}

function resolveAnthropicTokenCredentials(
  stored: AgenrStoredCredentials | undefined,
  env: NodeJS.ProcessEnv,
): CredentialCandidate | null {
  return (
    candidateFromToken(env.ANTHROPIC_OAUTH_TOKEN, "env:ANTHROPIC_OAUTH_TOKEN") ??
    candidateFromToken(stored?.anthropicOauthToken, "config:credentials.anthropicOauthToken")
  );
}

function resolveAnthropicApiKeyCredentials(
  stored: AgenrStoredCredentials | undefined,
  env: NodeJS.ProcessEnv,
): CredentialCandidate | null {
  return (
    candidateFromToken(env.ANTHROPIC_API_KEY, "env:ANTHROPIC_API_KEY") ??
    candidateFromToken(stored?.anthropicApiKey, "config:credentials.anthropicApiKey")
  );
}

function resolveOpenAISubscriptionCredentials(env: NodeJS.ProcessEnv): CredentialCandidate | null {
  const file = parseCodexFromFile(env);
  if (file) {
    return {
      token: file.accessToken,
      source: file.source,
    };
  }

  const keychain = parseCodexFromKeychain(env);
  if (keychain) {
    return {
      token: keychain.accessToken,
      source: keychain.source,
    };
  }

  return null;
}

function resolveOpenAIApiKeyCredentials(
  stored: AgenrStoredCredentials | undefined,
  env: NodeJS.ProcessEnv,
): CredentialCandidate | null {
  return (
    candidateFromToken(env.OPENAI_API_KEY, "env:OPENAI_API_KEY") ??
    candidateFromToken(stored?.openaiApiKey, "config:credentials.openaiApiKey")
  );
}

export function credentialSetupGuidance(auth: AgenrAuthMethod): string {
  if (auth === "anthropic-oauth") {
    return [
      "Claude CLI credentials not found.",
      "Install Claude Code CLI: npm install -g @anthropic-ai/claude-code",
      "Then sign in: claude",
    ].join(" ");
  }

  if (auth === "anthropic-token") {
    return [
      "No long-lived Anthropic token found.",
      "Generate one with: claude setup-token",
      "Then store it: agenr config set-key anthropic-token <token>",
    ].join(" ");
  }

  if (auth === "anthropic-api-key") {
    return [
      "No Anthropic API key found.",
      "Get a key from console.anthropic.com",
      "Then store it: agenr config set-key anthropic <key>",
    ].join(" ");
  }

  if (auth === "openai-subscription") {
    return [
      "Codex CLI credentials not found or expired.",
      "Run: codex auth",
    ].join(" ");
  }

  return [
    "No OpenAI API key found.",
    "Get a key from platform.openai.com",
    "Then store it: agenr config set-key openai <key>",
  ].join(" ");
}

function resolveCredentialCandidate(params: {
  auth: AgenrAuthMethod;
  storedCredentials?: AgenrStoredCredentials;
  env?: NodeJS.ProcessEnv;
}): CredentialCandidate | null {
  const env = params.env ?? process.env;

  if (params.auth === "anthropic-oauth") {
    return resolveAnthropicOauthCredentials(env);
  }

  if (params.auth === "anthropic-token") {
    return resolveAnthropicTokenCredentials(params.storedCredentials, env);
  }

  if (params.auth === "anthropic-api-key") {
    return resolveAnthropicApiKeyCredentials(params.storedCredentials, env);
  }

  if (params.auth === "openai-subscription") {
    return resolveOpenAISubscriptionCredentials(env);
  }

  return resolveOpenAIApiKeyCredentials(params.storedCredentials, env);
}

export function probeCredentials(params: {
  auth: AgenrAuthMethod;
  storedCredentials?: AgenrStoredCredentials;
  env?: NodeJS.ProcessEnv;
}): CredentialProbeResult {
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
    },
  };
}

export function resolveCredentials(params: {
  auth: AgenrAuthMethod;
  storedCredentials?: AgenrStoredCredentials;
  env?: NodeJS.ProcessEnv;
}): ResolvedCredentials {
  const probe = probeCredentials(params);
  if (!probe.available || !probe.credentials) {
    throw new Error(`${probe.guidance} Run: agenr auth status`);
  }

  return probe.credentials;
}
