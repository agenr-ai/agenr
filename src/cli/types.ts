export type LlmProviderPreference = "codex" | "claude-code" | "openai-api" | "anthropic-api";
export type LlmProvider = "openai-codex" | "anthropic" | "openai";
export type ApiKeyProvider = "openai" | "anthropic";
export type LlmAuthMode = "oauth" | "subscription-token" | "api-key";

export interface AgenrConfig {
  llm: {
    provider: LlmProviderPreference;
    model: string | null;
    subscriptionToken: string | null;
    apiKeys: Record<ApiKeyProvider, string | null>;
  };
  generation: {
    maxIterations: number;
    autoVerify: boolean;
  };
}

export interface ConfigOverrides {
  provider?: LlmProviderPreference;
  model?: string;
}

export type CredentialSource = "codex-cli" | "claude-cli" | "subscription-token" | "api-key";

export interface ResolvedCredentials {
  provider: LlmProvider;
  source: CredentialSource;
  authMode: LlmAuthMode;
  token: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
  baseUrl: string;
}

export interface ResolvedLlmRuntime {
  provider: LlmProvider;
  source: CredentialSource;
  authMode: LlmAuthMode;
  token: string;
  refreshToken?: string;
  model: string;
  expiresAt?: number;
  accountId?: string;
  baseUrl: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface DocumentationPage {
  url: string;
  title: string;
  text: string;
}

export interface GenerationOptions {
  platformName: string;
  docsUrl?: string;
  providerOverride?: LlmProviderPreference;
  modelOverride?: string;
  adapterOutputPath?: string;
  verbose?: boolean;
  showThinking?: boolean;
  skipDiscovery?: boolean;
  rediscover?: boolean;
}

export interface GeneratedArtifacts {
  interactionProfileJson: string;
  adapterTypescript: string;
}
