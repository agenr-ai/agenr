import { DEFAULT_CLAIM_EXTRACTION_CONCURRENCY } from "../../../../config.js";
import type { ClaimExtractionPreviewLlm } from "../types.js";

/** Sums token and cost usage across claim-extraction preview LLM instances. */
export function claimExtractionUsage(llms: ClaimExtractionPreviewLlm[]): {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
} {
  return llms.reduce(
    (total, llm) => {
      const usage = llm.metadata?.usage;
      total.inputTokens += usage?.inputTokens ?? 0;
      total.outputTokens += usage?.outputTokens ?? 0;
      total.estimatedCostUsd += usage?.totalCost ?? 0;
      return total;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
    },
  );
}

/** Resolves configured claim-extraction concurrency with the default fallback. */
export function resolveClaimExtractionConcurrency(config: { concurrency?: number }): number {
  const concurrency = config.concurrency;
  const normalized = typeof concurrency === "number" ? Math.trunc(concurrency) : Number.NaN;
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return DEFAULT_CLAIM_EXTRACTION_CONCURRENCY;
  }

  return normalized;
}
