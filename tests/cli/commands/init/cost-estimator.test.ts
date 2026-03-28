import { beforeEach, describe, expect, it, vi } from "vitest";

const piAiMocks = vi.hoisted(() => ({
  getModels: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getModels: piAiMocks.getModels,
}));

import { estimateIngestCost } from "../../../../src/cli/commands/init/cost-estimator.js";

describe("estimateIngestCost", () => {
  beforeEach(() => {
    piAiMocks.getModels.mockReset();
    piAiMocks.getModels.mockReturnValue([
      {
        id: "gpt-5.4-mini",
        cost: {
          input: 1,
          output: 1.5,
        },
      },
    ]);
  });

  it("applies the effective content ratio to full-history estimates", () => {
    const estimate = estimateIngestCost(500_000_000, "gpt-5.4-mini", "openai");

    expect(estimate.inputTokens).toBe(12_500_000);
    expect(estimate.outputTokens).toBe(1_250_000);
    expect(estimate.totalCostUsd).toBeCloseTo(14.375, 6);
  });

  it("keeps recent-session estimates near one dollar instead of raw-byte pricing", () => {
    const estimate = estimateIngestCost(40_000_000, "gpt-5.4-mini", "openai");

    expect(estimate.inputTokens).toBe(1_000_000);
    expect(estimate.outputTokens).toBe(100_000);
    expect(estimate.totalCostUsd).toBeCloseTo(1.15, 6);
  });

  it("returns zero cost for empty input", () => {
    const estimate = estimateIngestCost(0, "gpt-5.4-mini", "openai");

    expect(estimate.inputTokens).toBe(0);
    expect(estimate.outputTokens).toBe(0);
    expect(estimate.totalCostUsd).toBe(0);
  });
});
