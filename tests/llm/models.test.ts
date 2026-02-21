import { describe, expect, it } from "vitest";

import { resolveModel } from "../../src/llm/models.js";

describe("resolveModel OpenAI aliases", () => {
  it("accepts gpt-4.1 family aliases and resolves nano alias to registry id", () => {
    expect(() => resolveModel("openai", "gpt-4.1-nano")).not.toThrow();
    expect(() => resolveModel("openai", "gpt-4.1-mini")).not.toThrow();
    expect(() => resolveModel("openai", "openai/gpt-4.1-nano")).not.toThrow();
    expect(resolveModel("openai", "gpt-4.1-nano").modelId).toBe("openai/gpt-4.1-nano");
  });
});
