import { describe, expect, it, vi, beforeEach } from "vitest";
import type { LlmClient } from "../../src/types.js";

const { resolveModelForTaskMock, resolveModelMock } = vi.hoisted(() => ({
  resolveModelForTaskMock: vi.fn(),
  resolveModelMock: vi.fn(),
}));

vi.mock("../../src/config.js", () => ({
  resolveModelForTask: resolveModelForTaskMock,
}));

vi.mock("../../src/llm/models.js", () => ({
  resolveModel: resolveModelMock,
}));

import { clampConfidence, extractToolCallArgs, resolveModelForLlmClient } from "../../src/db/llm-helpers.js";

function makeClient(provider = "openai"): LlmClient {
  return {
    auth: "openai-api-key",
    resolvedModel: {
      provider: provider as LlmClient["resolvedModel"]["provider"],
      modelId: "gpt-4.1-nano",
      model: {} as LlmClient["resolvedModel"]["model"],
    },
    credentials: {
      apiKey: "sk-test",
      source: "test",
    },
  };
}

describe("llm-helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveModelMock.mockReturnValue({
      provider: "openai",
      modelId: "resolved-model-id",
      model: "resolved-model",
    });
  });

  it("clampConfidence handles normal values and non-finite values", () => {
    expect(clampConfidence(0.35)).toBe(0.35);
    expect(clampConfidence(Number.NaN)).toBe(0.5);
    expect(clampConfidence(Number.POSITIVE_INFINITY)).toBe(0.5);
    expect(clampConfidence(Number.NEGATIVE_INFINITY)).toBe(0.5);
    expect(clampConfidence(Number.NaN, 0)).toBe(0);
    expect(clampConfidence(Number.NaN, 5)).toBe(1);
    expect(clampConfidence(Number.NaN, -1)).toBe(0);
  });

  it("resolveModelForLlmClient uses explicit model override when provided", () => {
    const model = resolveModelForLlmClient(
      makeClient(),
      "claimExtraction",
      " custom-model ",
      { model: "ignored-default" },
    );

    expect(resolveModelForTaskMock).not.toHaveBeenCalled();
    expect(resolveModelMock).toHaveBeenCalledWith("openai", "custom-model");
    expect(model).toBe("resolved-model");
  });

  it("resolveModelForLlmClient uses config-based task model when no override exists", () => {
    resolveModelForTaskMock.mockReturnValue("task-model");

    resolveModelForLlmClient(makeClient(), "contradictionJudge", undefined, { models: {} });

    expect(resolveModelForTaskMock).toHaveBeenCalledWith({ models: {} }, "contradictionJudge");
    expect(resolveModelMock).toHaveBeenCalledWith("openai", "task-model");
  });

  it("resolveModelForLlmClient falls back through resolveModelForTask with empty config", () => {
    resolveModelForTaskMock.mockReturnValue("fallback-model");

    resolveModelForLlmClient(makeClient(), "claimExtraction");

    expect(resolveModelForTaskMock).toHaveBeenCalledWith({}, "claimExtraction");
    expect(resolveModelMock).toHaveBeenCalledWith("openai", "fallback-model");
  });

  it("extractToolCallArgs returns parsed args for matching tool and required fields", () => {
    const response = {
      content: [
        {
          type: "toolCall",
          name: "extract_claim",
          arguments: { no_claim: false, confidence: 0.9 },
        },
      ],
    };

    const parsed = extractToolCallArgs<{ no_claim: boolean; confidence: number }>(
      response,
      "extract_claim",
      ["no_claim"],
    );

    expect(parsed).toEqual({ no_claim: false, confidence: 0.9 });
  });

  it("extractToolCallArgs returns null for wrong tool name", () => {
    const response = {
      content: [
        {
          type: "toolCall",
          name: "other_tool",
          arguments: { ok: true },
        },
      ],
    };

    expect(extractToolCallArgs<{ ok: boolean }>(response, "extract_claim", ["ok"])).toBeNull();
  });

  it("extractToolCallArgs returns null when required fields are missing", () => {
    const response = {
      content: [
        {
          type: "toolCall",
          name: "extract_claim",
          arguments: { confidence: 0.8 },
        },
      ],
    };

    expect(
      extractToolCallArgs<{ no_claim: boolean; confidence: number }>(response, "extract_claim", ["no_claim"]),
    ).toBeNull();
  });

  it("extractToolCallArgs skips malformed matching blocks and returns later valid args", () => {
    const response = {
      content: [
        {
          type: "toolCall",
          name: "extract_claim",
          arguments: { confidence: 0.3 },
        },
        {
          type: "toolCall",
          name: "extract_claim",
          arguments: { no_claim: true, confidence: 0.6 },
        },
      ],
    };

    expect(
      extractToolCallArgs<{ no_claim: boolean; confidence: number }>(response, "extract_claim", ["no_claim"]),
    ).toEqual({ no_claim: true, confidence: 0.6 });
  });

  it("extractToolCallArgs returns null when response has no tool calls", () => {
    const response = {
      content: [{ type: "text", text: "no tool" }],
    };

    expect(extractToolCallArgs<{ ok: boolean }>(response, "extract_claim", ["ok"])).toBeNull();
  });
});
