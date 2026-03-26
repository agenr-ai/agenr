import { completeSimple, getEnvApiKey, getModel, type Api, type KnownProvider, type Model } from "@mariozechner/pi-ai";

import type { AgenrConfig } from "../config.js";
import type { LlmPort } from "../core/ports.js";

const DEFAULT_REASONING = "medium";

type CreateLlmClientOptions = {
  apiKey?: string;
  reasoning?: "medium" | "high";
};

type GetModelWithStrings = (provider: string, modelId: string) => Model<Api>;

const getModelWithStrings = getModel as unknown as GetModelWithStrings;

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

  const complete = async (systemPrompt: string, userMessage: string): Promise<string> => {
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

    const blocks: string[] = [];
    for (const contentBlock of response.content) {
      if (contentBlock.type === "text") {
        blocks.push(contentBlock.text);
      }
    }

    return blocks.join("");
  };

  return {
    metadata,
    complete,
    completeJson: async <T>(systemPrompt: string, userMessage: string): Promise<T> => {
      const text = await complete(systemPrompt, userMessage);
      return JSON.parse(stripCodeFence(text)) as T;
    },
  };
}

/**
 * Resolves the provider and model configured for a pipeline stage.
 *
 * @param config - Optional agenr runtime configuration.
 * @param stage - Pipeline stage that needs an LLM model.
 * @returns Provider and model ID to use for the requested stage.
 */
export function resolveModel(config: AgenrConfig | undefined, stage: "extraction" | "dedup"): { provider: string; modelId: string } {
  const override = stage === "extraction" ? config?.extractionModel : config?.dedupModel;

  return {
    provider: normalizeOptionalString(override?.provider) ?? normalizeOptionalString(config?.provider) ?? "openai",
    modelId: normalizeOptionalString(override?.model) ?? normalizeOptionalString(config?.model) ?? defaultModelForStage(stage),
  };
}

/**
 * Resolves the API key for an LLM provider from config or provider-specific
 * environment variables.
 *
 * @param config - Optional agenr runtime configuration.
 * @param provider - Provider whose credential should be resolved.
 * @returns API key string for the provider.
 */
export function resolveLlmApiKey(config: AgenrConfig | undefined, provider: string): string {
  const configuredApiKey = normalizeOptionalString(config?.apiKey);
  if (configuredApiKey) {
    return configuredApiKey;
  }

  const envApiKey = getEnvApiKey(provider as KnownProvider) ?? getEnvApiKey(provider);
  if (envApiKey) {
    return envApiKey;
  }

  throw new Error(`No API key found for provider "${provider}". Set config.apiKey or the provider's env var (for example OPENAI_API_KEY).`);
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

function defaultModelForStage(stage: "extraction" | "dedup"): string {
  switch (stage) {
    case "extraction":
      return "gpt-5.4-mini";
    case "dedup":
      return "gpt-5.4-nano";
  }
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

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
