import { describe, expect, it } from "vitest";
import { resolveModel } from "../../src/llm/models.js";

describe("resolveModel OpenAI aliases", () => {
  it("resolves gpt-4.1 family short aliases without throwing", () => {
    expect(() => resolveModel("openai", "gpt-4.1-nano")).not.toThrow();
    expect(() => resolveModel("openai", "gpt-4.1-mini")).not.toThrow();
    expect(() => resolveModel("openai", "gpt-4.1")).not.toThrow();
  });

  it("resolves gpt-4.1-nano short alias to canonical registry modelId", () => {
    expect(resolveModel("openai", "gpt-4.1-nano").modelId).toBe("openai/gpt-4.1-nano");
  });

  it("accepts full prefixed id openai/gpt-4.1-nano without alias", () => {
    expect(() => resolveModel("openai", "openai/gpt-4.1-nano")).not.toThrow();
  });

  it("throws on unknown model id even with provider prefix", () => {
    expect(() => resolveModel("openai", "openai/nonexistent-model-xyz")).toThrow();
    expect(() => resolveModel("openai", "nonexistent-model-xyz")).toThrow();
  });
});
