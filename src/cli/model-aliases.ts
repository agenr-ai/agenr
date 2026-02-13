import type { LlmProvider } from "./types";

const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-5",
  gpt4: "gpt-4.1",
  codex: "gpt-5.2-codex",
  o3: "o3",
  "o4-mini": "o4-mini",
};

const DEFAULT_MODEL_BY_PROVIDER: Record<LlmProvider, string> = {
  "openai-codex": "gpt-5.2-codex",
  anthropic: "claude-opus-4-6",
  openai: "gpt-4.1",
};

export function normalizeModelAlias(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return trimmed;

  const alias = MODEL_ALIASES[trimmed.toLowerCase()];
  return alias ?? trimmed;
}

export function resolveModel(provider: LlmProvider, configuredModel: string | null, override?: string): string {
  if (override && override.trim()) {
    return normalizeModelAlias(override);
  }

  if (configuredModel && configuredModel.trim()) {
    return normalizeModelAlias(configuredModel);
  }

  return DEFAULT_MODEL_BY_PROVIDER[provider];
}
