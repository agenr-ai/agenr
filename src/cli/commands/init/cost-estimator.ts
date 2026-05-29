import { getModels } from "@earendil-works/pi-ai";

import type { SetupProvider } from "../setup.js";

const CHARS_PER_TOKEN = 4;
// Observed full-history OpenClaw ingests cost about $14 in practice, while a
// raw-byte estimate for the same corpus landed around $146. Most JSONL bytes
// never reach the extraction LLM because transcript parsing strips metadata,
// summarizes tool calls, removes bookkeeping noise, and chunks the remaining
// conversation content. Model only 10% of raw bytes as effective LLM input.
const EFFECTIVE_CONTENT_RATIO = 0.1;
const OUTPUT_TOKEN_RATIO = 0.1;

/** Cost estimate for a potential bulk ingest run. */
export interface CostEstimate {
  /** Approximate input tokens derived from transcript bytes. */
  inputTokens: number;
  /** Approximate output tokens derived from the input-token estimate. */
  outputTokens: number;
  /** Approximate input-side USD cost. */
  inputCostUsd: number;
  /** Approximate output-side USD cost. */
  outputCostUsd: number;
  /** Combined estimated USD cost. */
  totalCostUsd: number;
  /** Extraction model used for the estimate. */
  modelId: string;
}

/**
 * Estimates the extraction cost for a byte-sized session corpus.
 *
 * @param totalBytes - Total raw transcript bytes to ingest.
 * @param modelId - Extraction model identifier.
 * @param provider - Extraction provider used for pricing lookup.
 * @returns Approximate token and USD cost breakdown.
 */
export function estimateIngestCost(totalBytes: number, modelId: string, provider: SetupProvider): CostEstimate {
  const safeTotalBytes = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
  const pricingModel = getModels(provider).find((model) => model.id === modelId);

  const inputCostPerMillion = pricingModel?.cost?.input ?? 0;
  const outputCostPerMillion = pricingModel?.cost?.output ?? 0;

  const inputTokens = Math.ceil((safeTotalBytes * EFFECTIVE_CONTENT_RATIO) / CHARS_PER_TOKEN);
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

/**
 * Formats a USD estimate for init wizard display.
 *
 * @param cost - Approximate USD cost.
 * @returns Short user-facing cost string.
 */
export function formatCostUsd(cost: number): string {
  if (cost < 0.01) {
    return "<$0.01";
  }

  return `~$${cost.toFixed(2)}`;
}

/**
 * Formats token counts using `K` and `M` suffixes.
 *
 * @param tokens - Token count to format.
 * @returns Short user-facing token string.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) {
    return `${tokens}`;
  }

  if (tokens < 1_000_000) {
    return `~${Math.round(tokens / 1_000)}K`;
  }

  return `~${(tokens / 1_000_000).toFixed(1)}M`;
}
