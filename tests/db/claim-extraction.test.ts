import type { AssistantMessage } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "../../src/types.js";

vi.mock("../../src/llm/stream.js", () => ({
  runSimpleStream: vi.fn(),
}));

import { runSimpleStream } from "../../src/llm/stream.js";
import { extractClaim, extractClaimsBatch } from "../../src/db/claim-extraction.js";

function makeClient(): LlmClient {
  return {
    auth: "openai-api-key",
    resolvedModel: {
      provider: "openai",
      modelId: "gpt-4.1-nano",
      model: {} as LlmClient["resolvedModel"]["model"],
    },
    credentials: {
      apiKey: "sk-test",
      source: "test",
    },
  };
}

function makeToolMessage(args: Record<string, unknown>): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "tool_1",
        name: "extract_claim",
        arguments: args,
      },
    ],
    api: "openai-chat",
    provider: "openai",
    model: "gpt-4.1-nano",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

describe("claim extraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts claim from a simple fact entry", async () => {
    vi.mocked(runSimpleStream).mockResolvedValueOnce(
      makeToolMessage({
        no_claim: false,
        subject_entity: "jim",
        subject_attribute: "weight",
        predicate: "weighs",
        object: "185 lbs",
        confidence: 0.9,
      }),
    );

    const claim = await extractClaim("Jim weighs 185 lbs", "fact", "Jim weight", makeClient());

    expect(claim).toEqual({
      subjectEntity: "jim",
      subjectAttribute: "weight",
      subjectKey: "jim/weight",
      predicate: "weighs",
      object: "185 lbs",
      confidence: 0.9,
    });
  });

  it("extracts claim from a preference entry", async () => {
    vi.mocked(runSimpleStream).mockResolvedValueOnce(
      makeToolMessage({
        no_claim: false,
        subject_entity: "Jim",
        subject_attribute: "package_manager",
        predicate: "prefers",
        object: "pnpm",
        confidence: 0.92,
      }),
    );

    const claim = await extractClaim("Jim prefers pnpm", "preference", "Jim package manager", makeClient());

    expect(claim?.subjectEntity).toBe("jim");
    expect(claim?.subjectAttribute).toBe("package_manager");
    expect(claim?.subjectKey).toBe("jim/package_manager");
  });

  it("returns null for complex entry when no_claim is true", async () => {
    vi.mocked(runSimpleStream).mockResolvedValueOnce(
      makeToolMessage({
        no_claim: true,
      }),
    );

    const claim = await extractClaim(
      "Long meeting summary with many unrelated topics.",
      "event",
      "Q3 planning",
      makeClient(),
    );

    expect(claim).toBeNull();
  });

  it("returns null on llm error", async () => {
    vi.mocked(runSimpleStream).mockRejectedValueOnce(new Error("upstream failure"));

    await expect(extractClaim("Jim weighs 185 lbs", "fact", "Jim weight", makeClient())).resolves.toBeNull();
  });

  it("returns null on missing required fields", async () => {
    vi.mocked(runSimpleStream).mockResolvedValueOnce(
      makeToolMessage({
        no_claim: false,
        subject_entity: "jim",
        predicate: "weighs",
        object: "185 lbs",
        confidence: 0.9,
      }),
    );

    const claim = await extractClaim("Jim weighs 185 lbs", "fact", "Jim weight", makeClient());
    expect(claim).toBeNull();
  });

  it("composes subjectKey with lowercase normalization", async () => {
    vi.mocked(runSimpleStream).mockResolvedValueOnce(
      makeToolMessage({
        no_claim: false,
        subject_entity: "Jim",
        subject_attribute: "Weight",
        predicate: "weighs",
        object: "185 lbs",
        confidence: 0.9,
      }),
    );

    const claim = await extractClaim("Jim weighs 185 lbs", "fact", "Jim weight", makeClient());
    expect(claim?.subjectKey).toBe("jim/weight");
  });

  it("extractClaimsBatch processes multiple entries sequentially", async () => {
    vi.mocked(runSimpleStream)
      .mockResolvedValueOnce(
        makeToolMessage({
          no_claim: false,
          subject_entity: "jim",
          subject_attribute: "weight",
          predicate: "weighs",
          object: "185 lbs",
          confidence: 0.9,
        }),
      )
      .mockResolvedValueOnce(makeToolMessage({ no_claim: true }))
      .mockResolvedValueOnce(
        makeToolMessage({
          no_claim: false,
          subject_entity: "agenr",
          subject_attribute: "storage_backend",
          predicate: "uses",
          object: "libsql",
          confidence: 0.88,
        }),
      );

    const results = await extractClaimsBatch(
      [
        { content: "Jim weighs 185 lbs", type: "fact", subject: "Jim weight" },
        { content: "Long meeting summary", type: "event", subject: "meeting" },
        { content: "agenr uses libsql", type: "fact", subject: "agenr storage" },
      ],
      makeClient(),
    );

    expect(results).toHaveLength(3);
    expect(results[0]?.subjectKey).toBe("jim/weight");
    expect(results[1]).toBeNull();
    expect(results[2]?.subjectKey).toBe("agenr/storage_backend");
    expect(runSimpleStream).toHaveBeenCalledTimes(3);
  });

  it("handles empty content gracefully", async () => {
    const claim = await extractClaim("   ", "fact", "empty", makeClient());
    expect(claim).toBeNull();
    expect(runSimpleStream).not.toHaveBeenCalled();
  });
});
