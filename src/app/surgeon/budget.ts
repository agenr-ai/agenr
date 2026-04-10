import type { Usage } from "@mariozechner/pi-ai";

/**
 * Tracks surgeon token, context, and cost consumption for one run.
 */
export interface BudgetTracker {
  /**
   * Adds one usage sample to the cumulative totals.
   *
   * @param usage - Usage payload reported by the underlying model call.
   */
  addUsage(usage: Usage): void;

  /**
   * Returns whether the most recent input token count hit the context limit.
   *
   * @returns True when the tracked context window is exhausted.
   */
  isExhausted(): boolean;

  /**
   * Returns whether cumulative spend met or exceeded the configured cost cap.
   *
   * @returns True when the run should stop due to cost.
   */
  isCostCapExceeded(): boolean;

  /**
   * Returns the remaining context and cost budget snapshot.
   *
   * @returns Current budget remainder details.
   */
  remaining(): {
    currentContextTokens: number;
    contextLimit: number;
    remainingContextTokens: number;
    costCapUsd: number;
    remainingCostUsd: number;
  };

  /**
   * Returns cumulative token and cost totals.
   *
   * @returns Aggregate usage totals for the run.
   */
  totals(): {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    lastInputTokens: number;
  };
}

/**
 * Creates a run-local surgeon budget tracker.
 *
 * @param options - Context and cost budget limits for the run.
 * @returns Mutable budget tracker instance.
 */
export function createBudgetTracker(options: { contextLimit: number; costCapUsd: number }): BudgetTracker {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let lastInputTokens = 0;

  const contextLimit = Number.isFinite(options.contextLimit) ? Math.max(0, Math.floor(options.contextLimit)) : 0;
  const costCapUsd = Number.isFinite(options.costCapUsd) ? Math.max(0, options.costCapUsd) : 0;

  return {
    addUsage(usage: Usage): void {
      const input = normalizeUsageAmount(usage.input);
      inputTokens += input;
      outputTokens += normalizeUsageAmount(usage.output);
      costUsd += normalizeUsageAmount(usage.cost?.total);
      lastInputTokens = input;
    },

    isExhausted(): boolean {
      return contextLimit > 0 && lastInputTokens >= contextLimit;
    },

    isCostCapExceeded(): boolean {
      return costCapUsd > 0 && costUsd >= costCapUsd;
    },

    remaining(): {
      currentContextTokens: number;
      contextLimit: number;
      remainingContextTokens: number;
      costCapUsd: number;
      remainingCostUsd: number;
    } {
      return {
        currentContextTokens: lastInputTokens,
        contextLimit,
        remainingContextTokens: contextLimit > 0 ? Math.max(0, contextLimit - lastInputTokens) : 0,
        costCapUsd,
        remainingCostUsd: costCapUsd > 0 ? Math.max(0, costCapUsd - costUsd) : 0,
      };
    },

    totals(): {
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      lastInputTokens: number;
    } {
      return {
        inputTokens,
        outputTokens,
        costUsd,
        lastInputTokens,
      };
    },
  };
}

/**
 * Normalizes an optional usage amount into a finite non-negative number.
 *
 * @param value - Reported usage amount.
 * @returns Safe numeric amount for budget tracking.
 */
function normalizeUsageAmount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, value);
}
