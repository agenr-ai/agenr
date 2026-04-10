import { describe, expect, it } from "vitest";

import {
  collectStringValue,
  normalizeOptionalString,
  normalizeStringList,
  parseCsvList,
  parseIntegerInRange,
  parseModelRef,
  parseNonNegativeInteger,
  parsePositiveInteger,
  parsePositiveNumber,
  parseUnitInterval,
} from "../../../src/cli/shared/parse.js";

describe("cli shared parse helpers", () => {
  it("normalizes optional strings", () => {
    expect(normalizeOptionalString("  agenr  ")).toBe("agenr");
    expect(normalizeOptionalString("   ")).toBeUndefined();
  });

  it("normalizes repeated string lists", () => {
    expect(normalizeStringList(["  one ", "two", "one", "   "])).toEqual(["one", "two"]);
    expect(normalizeStringList(["   "])).toBeUndefined();
  });

  it("collects repeated string values after trimming", () => {
    expect(collectStringValue("  alpha  ", ["beta"])).toEqual(["beta", "alpha"]);
    expect(() => collectStringValue("   ", [])).toThrow("Value cannot be empty.");
  });

  it("parses comma-separated lists into unique values", () => {
    expect(parseCsvList(" alpha, beta ,alpha ")).toEqual(["alpha", "beta"]);
  });

  it("parses positive integers", () => {
    expect(parsePositiveInteger("7")).toBe(7);
    expect(() => parsePositiveInteger("0")).toThrow("Value must be a positive integer.");
  });

  it("parses non-negative integers", () => {
    expect(parseNonNegativeInteger("0")).toBe(0);
    expect(() => parseNonNegativeInteger("-1")).toThrow("Value must be a non-negative integer.");
  });

  it("parses bounded integers", () => {
    expect(parseIntegerInRange("10", "Concurrency", 1, 50)).toBe(10);
    expect(() => parseIntegerInRange("100", "Concurrency", 1, 50)).toThrow("Concurrency must be between 1 and 50.");
  });

  it("parses positive numbers", () => {
    expect(parsePositiveNumber("0.5")).toBe(0.5);
    expect(() => parsePositiveNumber("0")).toThrow("Value must be a positive number.");
  });

  it("parses unit-interval numbers", () => {
    expect(parseUnitInterval("1")).toBe(1);
    expect(() => parseUnitInterval("1.1")).toThrow("Value must be between 0 and 1.");
  });

  it("parses model references with or without a provider", () => {
    expect(parseModelRef(" anthropic/claude-sonnet-4-6 ")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
    expect(parseModelRef(" gpt-5.4-mini ")).toEqual({
      modelId: "gpt-5.4-mini",
    });
    expect(() => parseModelRef("openai/")).toThrow('Model reference must look like "provider/model" or "model".');
  });
});
