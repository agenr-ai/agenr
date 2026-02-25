import { getModels } from "@mariozechner/pi-ai";
import type { AgenrProvider } from "../../types.js";

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  modelId: string;
}

const CHARS_PER_TOKEN = 4;
const OUTPUT_TOKEN_RATIO = 0.1;

export function estimateIngestCost(
  totalBytes: number,
  modelId: string,
  provider: AgenrProvider,
): CostEstimate {
  const bareModelId = modelId.includes("/")
    ? modelId.slice(modelId.indexOf("/") + 1)
    : modelId;

  const models = getModels(provider);
  const model = models.find((entry) => entry.id === bareModelId);

  const inputCostPerMillion = model?.cost?.input ?? 0;
  const outputCostPerMillion = model?.cost?.output ?? 0;

  const inputTokens = Math.ceil(totalBytes / CHARS_PER_TOKEN);
  const outputTokens = Math.ceil(inputTokens * OUTPUT_TOKEN_RATIO);

  const inputCostUsd = (inputTokens / 1_000_000) * inputCostPerMillion;
  const outputCostUsd = (outputTokens / 1_000_000) * outputCostPerMillion;

  return {
    inputTokens,
    outputTokens,
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd,
    modelId,
  };
}

export function formatCostUsd(cost: number): string {
  if (cost < 0.01) {
    return "<$0.01";
  }
  return `~$${cost.toFixed(2)}`;
}

export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) {
    return `${tokens}`;
  }
  if (tokens < 1_000_000) {
    return `~${Math.round(tokens / 1000)}K`;
  }
  return `~${(tokens / 1_000_000).toFixed(1)}M`;
}
