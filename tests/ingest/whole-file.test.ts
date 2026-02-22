import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  buildWholeFileChunkFromMessages,
  fileFitsInContext,
  getContextWindowTokens,
  getOutputTokens,
  OUTPUT_BUDGET_TOKENS_DEFAULT,
  resolveWholeFileMode,
  usableWindowTokens,
  warnOnHighEntryCount,
} from "../../src/ingest/whole-file.js";
import { renderTranscriptLine } from "../../src/parser.js";
import type { KnowledgeEntry, LlmClient, TranscriptMessage } from "../../src/types.js";

function fakeModel(id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 16_384,
  };
}

function makeClient(modelId: string): LlmClient {
  return {
    auth: "openai-api-key",
    resolvedModel: {
      provider: "openai",
      modelId,
      model: fakeModel(modelId),
    },
    credentials: {
      apiKey: "test-key",
      source: "test",
    },
  };
}

function makeMessage(index: number, role: "user" | "assistant", text: string): TranscriptMessage {
  const minutes = index.toString().padStart(2, "0");
  return {
    index,
    role,
    text,
    timestamp: `2026-02-21T00:${minutes}:00.000Z`,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let cursor = 0;
  while (true) {
    const found = haystack.indexOf(needle, cursor);
    if (found < 0) {
      return count;
    }
    count += 1;
    cursor = found + needle.length;
  }
}

function makeEntry(importance: number): KnowledgeEntry {
  return {
    type: "fact",
    subject: `subject-${importance}`,
    content: `content-${importance}`,
    importance,
    expiry: "temporary",
    tags: ["test"],
    source: {
      file: "test.jsonl",
      context: "test",
    },
  };
}

describe("buildWholeFileChunkFromMessages", () => {
  it("rebuilds a whole-file chunk without overlap duplication", () => {
    const overlap = Array.from({ length: 300 }, (_value, index) => index.toString(36).padStart(4, "0")).join("");
    const messages: TranscriptMessage[] = [
      makeMessage(0, "user", `prefix-${overlap}`),
      makeMessage(1, "assistant", "suffix"),
    ];

    const output = buildWholeFileChunkFromMessages(messages);
    const expectedRenderedChars =
      messages.reduce((total, message) => total + renderTranscriptLine(message).length, 0) +
      (messages.length - 1);

    expect(countOccurrences(output.text, overlap)).toBe(1);
    expect(output.text.length).toBe(expectedRenderedChars);
    expect(output.chunk_index).toBe(0);
    expect(output.totalChunks).toBe(1);
    expect(output.index).toBe(0);
    expect(output.context_hint).toContain("2 messages");
    expect(output.timestamp_start).toBe(messages[0].timestamp);
    expect(output.timestamp_end).toBe(messages[1].timestamp);
    expect(output.message_start).toBe(messages[0].index);
    expect(output.message_end).toBe(messages[1].index);
  });

  it("throws for empty messages", () => {
    expect(() => buildWholeFileChunkFromMessages([])).toThrow("empty messages");
  });
});

describe("getContextWindowTokens", () => {
  it("returns context window for known model ids", () => {
    expect(getContextWindowTokens(makeClient("gpt-4o"))).toBe(128_000);
  });

  it("strips provider prefix before lookup", () => {
    expect(getContextWindowTokens(makeClient("openai/gpt-4o-mini"))).toBe(128_000);
  });

  it("strips date suffix before lookup", () => {
    expect(getContextWindowTokens(makeClient("gpt-4.1-nano-2025-04-14"))).toBe(1_000_000);
  });

  it("strips anthropic snapshot suffix before lookup", () => {
    expect(getContextWindowTokens(makeClient("anthropic/claude-opus-4-20250514"))).toBe(200_000);
  });

  it("returns undefined and warns for unknown models in verbose mode", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(getContextWindowTokens(makeClient("unknown-model"), true)).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it("returns undefined silently for unknown models when not verbose", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getContextWindowTokens(makeClient("unknown-model"))).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("getOutputTokens", () => {
  it("returns correct value for gpt-4.1-nano", () => {
    expect(getOutputTokens(makeClient("gpt-4.1-nano"))).toBe(32_768);
  });

  it("returns correct values for gpt-5 codex and nano models", () => {
    expect(getOutputTokens(makeClient("gpt-5-nano"))).toBe(131_072);
    expect(getOutputTokens(makeClient("gpt-5.2-codex"))).toBe(131_072);
    expect(getOutputTokens(makeClient("gpt-5.3-codex"))).toBe(100_000);
  });

  it("returns fallback output budget for unknown models", () => {
    expect(getOutputTokens(makeClient("unknown-model"))).toBe(OUTPUT_BUDGET_TOKENS_DEFAULT);
  });
});

describe("usableWindowTokens", () => {
  it("uses per-model output tokens in calculation", () => {
    const outputTokens = getOutputTokens(makeClient("gpt-4.1-nano"));
    expect(usableWindowTokens(1_000_000, outputTokens)).toBe(963_232);
  });
});

describe("fileFitsInContext", () => {
  it("uses rendered transcript length instead of raw message text length", () => {
    const client = makeClient("gpt-4o");
    const usableTokens = 128_000 - 16_384 - 4_000;
    const message = makeMessage(0, "user", "a".repeat(usableTokens * 4));
    const messages: TranscriptMessage[] = [message];

    expect(Math.ceil(message.text.length / 4)).toBeLessThanOrEqual(usableTokens);
    expect(fileFitsInContext(messages, client)).toBe(false);
  });

  it("returns true for a file that fits within context window", () => {
    const client = makeClient("gpt-4o");
    const usableTokens = 128_000 - 16_384 - 4_000;
    const message = makeMessage(0, "user", "a".repeat((usableTokens - 100) * 4));
    expect(fileFitsInContext([message], client)).toBe(true);
  });

  it("returns false for unknown model regardless of file size", () => {
    const client = makeClient("some-future-model");
    const smallMessage = makeMessage(0, "user", "tiny");
    expect(fileFitsInContext([smallMessage], client)).toBe(false);
  });
});

describe("resolveWholeFileMode", () => {
  it("handles never/auto/force modes", () => {
    const client = makeClient("gpt-4.1-nano");
    const smallMessages = [makeMessage(0, "user", "small file")];

    expect(resolveWholeFileMode("never", smallMessages, client)).toBe(false);
    expect(resolveWholeFileMode("auto", smallMessages, client)).toBe(true);
    expect(resolveWholeFileMode("force", smallMessages, client)).toBe(true);
  });

  it("returns false for empty messages in auto mode", () => {
    const client = makeClient("gpt-4.1-nano");
    expect(resolveWholeFileMode("auto", [], client)).toBe(false);
  });

  it("emits onVerbose warning for empty messages in auto mode", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeClient("gpt-4.1-nano");
    const onVerbose = vi.fn();

    const result = resolveWholeFileMode("auto", [], client, false, onVerbose);

    expect(result).toBe(false);
    expect(onVerbose).toHaveBeenCalledTimes(1);
    expect(onVerbose.mock.calls[0]?.[0]).toContain("no messages parsed from file");
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("returns false for unknown model in auto mode", () => {
    const client = makeClient("some-new-model");
    const messages = [makeMessage(0, "user", "hello")];
    expect(resolveWholeFileMode("auto", messages, client)).toBe(false);
  });

  it("throws in force mode when estimated tokens exceed a known context window", () => {
    const client = makeClient("gpt-4o");
    const tooLarge = [makeMessage(0, "user", "x".repeat(600_000))];

    expect(() => resolveWholeFileMode("force", tooLarge, client)).toThrow("force mode");
  });

  it("returns false in auto mode when file exceeds context window", () => {
    const client = makeClient("gpt-4o");
    const usableTokens = 128_000 - 16_384 - 4_000;
    const tooLarge = [makeMessage(0, "user", "x".repeat((usableTokens + 100) * 4))];
    expect(resolveWholeFileMode("auto", tooLarge, client)).toBe(false);
  });

  it("throws in force mode when messages array is empty", () => {
    const client = makeClient("gpt-4.1-nano");
    expect(() => resolveWholeFileMode("force", [], client)).toThrow("force mode");
  });

  it("returns true and warns when force mode tokens exceed 500K on large-context model", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeClient("gpt-4.1-nano");
    const bigMessages = [makeMessage(0, "user", "x".repeat(500_001 * 4))];

    const result = resolveWholeFileMode("force", bigMessages, client, true);
    expect(result).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("500");

    warnSpy.mockRestore();
  });

  it("warns in force mode when context window is unknown and proceeds", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeClient("some-future-model");
    const messages = [makeMessage(0, "user", "tiny")];

    const result = resolveWholeFileMode("force", messages, client, true);

    expect(result).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(
      warnSpy.mock.calls.some(
        (call) =>
          typeof call[0] === "string" &&
          call[0].includes("force mode: unknown context window from getContextWindowTokens"),
      ),
    ).toBe(true);

    warnSpy.mockRestore();
  });
});

describe("warnOnHighEntryCount", () => {
  it("does not truncate entries array", () => {
    const entries = Array.from({ length: 700 }, (_value, index) => makeEntry(index + 1));

    const result = warnOnHighEntryCount(entries, false);

    expect(result).toHaveLength(700);
    expect(result).toBe(entries);
  });

  it("emits warning via onVerbose when entries are greater than 500", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onVerbose = vi.fn();
    const entries = Array.from({ length: 501 }, (_value, index) => makeEntry(index + 1));

    const result = warnOnHighEntryCount(entries, true, onVerbose);

    expect(result).toHaveLength(501);
    expect(onVerbose).toHaveBeenCalledTimes(1);
    expect(onVerbose.mock.calls[0]?.[0]).toContain("Received 501 entries");
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("does not emit warning when entries are 500 or fewer", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onVerbose = vi.fn();
    const entries = Array.from({ length: 500 }, (_value, index) => makeEntry(index + 1));

    const result = warnOnHighEntryCount(entries, true, onVerbose);

    expect(result).toHaveLength(500);
    expect(onVerbose).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
