import { describe, expect, test } from "bun:test";

import {
  buildCompleteRequestOptions,
  buildStreamRequestOptions,
  isReasoningModelId,
  shouldStripSamplingParams,
  type PiAiModel,
} from "../../src/cli/pi-ai-client";

function createModel(id: string, api: string): PiAiModel {
  return {
    id,
    api,
  } as unknown as PiAiModel;
}

describe("pi-ai client reasoning model option handling", () => {
  test("detects reasoning model IDs", () => {
    const reasoningIds = ["gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.1", "o3", "o4-mini", "my-model-reasoning"];
    for (const modelId of reasoningIds) {
      expect(isReasoningModelId(modelId)).toBe(true);
    }

    expect(isReasoningModelId("gpt-4.1")).toBe(false);
    expect(isReasoningModelId("claude-opus-4-6")).toBe(false);
  });

  test("strips sampling params for OpenAI-family reasoning models only", () => {
    expect(shouldStripSamplingParams(createModel("gpt-5.2-codex", "openai-responses"))).toBe(true);
    expect(shouldStripSamplingParams(createModel("o3", "openai-completions"))).toBe(true);
    expect(shouldStripSamplingParams(createModel("gpt-4.1", "openai-responses"))).toBe(false);
    expect(shouldStripSamplingParams(createModel("gpt-5.2-codex", "anthropic-messages"))).toBe(false);
  });

  test("complete request options omit temperature and maxTokens for reasoning models", () => {
    const options = buildCompleteRequestOptions(createModel("gpt-5.2-codex", "openai-responses"), {
      apiKey: "token",
      temperature: 0.1,
      maxTokens: 16_000,
    });

    expect(options).toEqual({
      apiKey: "token",
    });
  });

  test("complete request options keep temperature and maxTokens for non-reasoning models", () => {
    const options = buildCompleteRequestOptions(createModel("gpt-4.1", "openai-responses"), {
      apiKey: "token",
      temperature: 0.1,
      maxTokens: 16_000,
    });

    expect(options).toEqual({
      apiKey: "token",
      temperature: 0.1,
      maxTokens: 16_000,
    });
  });

  test("stream request options omit sampling params for reasoning models", () => {
    const options = buildStreamRequestOptions(createModel("o4-mini", "openai-responses"), {
      apiKey: "token",
      temperature: 0.3,
      maxTokens: 1024,
      onThinking: () => {},
      onText: () => {},
    });

    expect(options).toEqual({
      apiKey: "token",
      reasoningEffort: "high",
      reasoningSummary: "detailed",
    });
  });

  test("anthropic thinking stream still forces temperature=1 and keeps maxTokens", () => {
    const options = buildStreamRequestOptions(createModel("claude-opus-4-6", "anthropic-messages"), {
      apiKey: "token",
      temperature: 0.2,
      maxTokens: 4096,
      onThinking: () => {},
      onText: () => {},
    });

    expect(options).toEqual({
      apiKey: "token",
      thinkingEnabled: true,
      effort: "high",
      temperature: 1,
      maxTokens: 4096,
    });
  });
});
