import { getModel, type Api, type Model } from "@mariozechner/pi-ai";
import type { AgenrProvider, ResolvedModel } from "../types.js";

const PROVIDERS = new Set<AgenrProvider>(["anthropic", "openai", "openai-codex"]);

const MODEL_ALIASES: Record<AgenrProvider, Record<string, string>> = {
  anthropic: {
    opus: "claude-opus-4-6",
    sonnet: "claude-sonnet-4-20250514",
    "claude-opus": "claude-opus-4-6",
  },
  openai: {
    gpt: "gpt-5.2-codex",
    "gpt-codex": "gpt-5.2-codex",
    "gpt-4.1-nano": "openai/gpt-4.1-nano",
    "gpt-4.1-mini": "openai/gpt-4.1-mini",
    "gpt-4.1": "openai/gpt-4.1",
    "gpt-5-nano": "openai/gpt-5-nano",
  },
  "openai-codex": {
    codex: "gpt-5.3-codex",
    "gpt-codex": "gpt-5.3-codex",
  },
};

export function isAgenrProvider(value: string): value is AgenrProvider {
  return PROVIDERS.has(value as AgenrProvider);
}

export function normalizeProvider(value: string): AgenrProvider {
  const normalized = value.trim().toLowerCase();
  if (!isAgenrProvider(normalized)) {
    throw new Error(
      `Unsupported provider \"${value}\". Expected one of: anthropic, openai, openai-codex.`,
    );
  }
  return normalized;
}

function normalizeModelId(provider: AgenrProvider, model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    throw new Error("Model cannot be empty.");
  }

  const aliasKey = trimmed.toLowerCase();
  return MODEL_ALIASES[provider][aliasKey] ?? trimmed;
}

export function resolveModel(providerRaw: string, modelRaw: string): ResolvedModel {
  const provider = normalizeProvider(providerRaw);
  const modelId = normalizeModelId(provider, modelRaw);
  const fallbackModelId = modelId.startsWith(`${provider}/`) ? modelId.slice(provider.length + 1) : undefined;
  const candidateModelIds = [modelId, fallbackModelId].filter((value): value is string => Boolean(value));

  let model: Model<Api> | undefined;
  for (const candidateId of candidateModelIds) {
    try {
      const candidate = getModel(provider, candidateId as never) as Model<Api>;
      if (candidate && typeof candidate.id === "string" && candidate.id.trim()) {
        model = candidate;
        break;
      }
    } catch {
      // Try the next candidate model id.
    }
  }

  if (!model) {
    throw new Error(
      `Model \"${modelId}\" is not available for provider \"${provider}\" in @mariozechner/pi-ai.`,
    );
  }

  return {
    provider,
    modelId,
    model,
  };
}
