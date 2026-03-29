import { describe, expect, it } from "vitest";

import { createBudgetTracker } from "../../../src/app/surgeon/budget.js";

describe("createBudgetTracker", () => {
  it("accumulates usage totals and updates the latest context snapshot", () => {
    const tracker = createBudgetTracker({
      contextLimit: 8_000,
      costCapUsd: 1.5,
    });

    tracker.addUsage({
      input: 1_200,
      output: 300,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1_500,
      cost: {
        input: 0.01,
        output: 0.02,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.03,
      },
    });
    tracker.addUsage({
      input: 2_000,
      output: 400,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2_400,
      cost: {
        input: 0.04,
        output: 0.01,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.05,
      },
    });

    expect(tracker.totals()).toEqual({
      inputTokens: 3_200,
      outputTokens: 700,
      costUsd: 0.08,
      lastInputTokens: 2_000,
    });
    expect(tracker.remaining()).toEqual({
      currentContextTokens: 2_000,
      contextLimit: 8_000,
      remainingContextTokens: 6_000,
      costCapUsd: 1.5,
      remainingCostUsd: 1.42,
    });
  });

  it("reports exhausted and cost-capped states based on the configured limits", () => {
    const tracker = createBudgetTracker({
      contextLimit: 1_000,
      costCapUsd: 0.05,
    });

    tracker.addUsage({
      input: 1_000,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1_020,
      cost: {
        input: 0.02,
        output: 0.03,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.05,
      },
    });

    expect(tracker.isExhausted()).toBe(true);
    expect(tracker.isCostCapExceeded()).toBe(true);
    expect(tracker.remaining()).toEqual({
      currentContextTokens: 1_000,
      contextLimit: 1_000,
      remainingContextTokens: 0,
      costCapUsd: 0.05,
      remainingCostUsd: 0,
    });
  });

  it("normalizes invalid limits and negative usage values safely", () => {
    const tracker = createBudgetTracker({
      contextLimit: Number.NaN,
      costCapUsd: Number.NEGATIVE_INFINITY,
    });

    tracker.addUsage({
      input: -10,
      output: -5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: -3,
      },
    });

    expect(tracker.totals()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      lastInputTokens: 0,
    });
    expect(tracker.isExhausted()).toBe(false);
    expect(tracker.isCostCapExceeded()).toBe(false);
    expect(tracker.remaining()).toEqual({
      currentContextTokens: 0,
      contextLimit: 0,
      remainingContextTokens: 0,
      costCapUsd: 0,
      remainingCostUsd: 0,
    });
  });

  it("treats a zero context limit as unlimited", () => {
    const tracker = createBudgetTracker({
      contextLimit: 0,
      costCapUsd: 1,
    });

    tracker.addUsage({
      input: 25_000,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 25_100,
      cost: {
        input: 0.1,
        output: 0.02,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.12,
      },
    });

    expect(tracker.isExhausted()).toBe(false);
    expect(tracker.remaining()).toEqual({
      currentContextTokens: 25_000,
      contextLimit: 0,
      remainingContextTokens: 0,
      costCapUsd: 1,
      remainingCostUsd: 0.88,
    });
  });

  it("treats a zero cost cap as unlimited", () => {
    const tracker = createBudgetTracker({
      contextLimit: 2_000,
      costCapUsd: 0,
    });

    tracker.addUsage({
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
      cost: {
        input: 2,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        total: 5,
      },
    });

    expect(tracker.isCostCapExceeded()).toBe(false);
    expect(tracker.remaining()).toEqual({
      currentContextTokens: 100,
      contextLimit: 2_000,
      remainingContextTokens: 1_900,
      costCapUsd: 0,
      remainingCostUsd: 0,
    });
  });
});
