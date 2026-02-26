import { describe, expect, it } from "vitest";
import {
  estimateIngestCost,
  formatCostUsd,
  formatTokenCount,
} from "./cost-estimator.js";

describe("estimateIngestCost", () => {
  it("estimateIngestCost calculates token count from bytes", () => {
    const estimate = estimateIngestCost(4000, "gpt-4.1-mini", "openai");
    expect(estimate.inputTokens).toBe(1000);
  });

  it("estimateIngestCost calculates output tokens at 10%", () => {
    const estimate = estimateIngestCost(4000, "gpt-4.1-mini", "openai");
    expect(estimate.outputTokens).toBe(100);
  });

  it("estimateIngestCost uses model cost data for gpt-4.1-mini", () => {
    const estimate = estimateIngestCost(4000, "gpt-4.1-mini", "openai");
    expect(estimate.inputCostUsd).toBeCloseTo(0.0004, 10);
    expect(estimate.outputCostUsd).toBeCloseTo(0.00016, 10);
    expect(estimate.totalCostUsd).toBeCloseTo(0.00056, 10);
  });

  it("estimateIngestCost strips provider prefix from model ID", () => {
    const prefixed = estimateIngestCost(4000, "openai/gpt-4.1-mini", "openai");
    const bare = estimateIngestCost(4000, "gpt-4.1-mini", "openai");
    expect(prefixed.inputCostUsd).toBeCloseTo(bare.inputCostUsd, 10);
    expect(prefixed.outputCostUsd).toBeCloseTo(bare.outputCostUsd, 10);
    expect(prefixed.totalCostUsd).toBeCloseTo(bare.totalCostUsd, 10);
  });

  it("estimateIngestCost returns zero cost for unknown model", () => {
    const estimate = estimateIngestCost(4000, "nonexistent-model", "openai");
    expect(estimate.totalCostUsd).toBe(0);
  });

  it("estimateIngestCost clamps invalid byte sizes to zero", () => {
    for (const input of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const estimate = estimateIngestCost(input, "gpt-4.1-mini", "openai");
      expect(estimate.inputTokens).toBe(0);
      expect(estimate.outputTokens).toBe(0);
      expect(estimate.totalCostUsd).toBe(0);
    }
  });
});

describe("formatCostUsd", () => {
  it("formatCostUsd returns <$0.01 for tiny amounts", () => {
    expect(formatCostUsd(0.001)).toBe("<$0.01");
  });

  it("formatCostUsd formats dollars with 2 decimal places", () => {
    expect(formatCostUsd(1.234)).toBe("~$1.23");
  });
});

describe("formatTokenCount", () => {
  it("formatTokenCount formats thousands as K", () => {
    expect(formatTokenCount(5000)).toBe("~5K");
  });

  it("formatTokenCount formats millions as M", () => {
    expect(formatTokenCount(1_500_000)).toBe("~1.5M");
  });

  it("formatTokenCount returns raw number for small counts", () => {
    expect(formatTokenCount(500)).toBe("500");
  });
});
