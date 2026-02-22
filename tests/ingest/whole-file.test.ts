import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  applyEntryHardCap,
  buildWholeFileChunkFromMessages,
  fileFitsInContext,
  getContextWindowTokens,
  resolveWholeFileMode,
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

function makeClient(modelId: string | undefined): LlmClient {
  return {
    auth: "openai-api-key",
    resolvedModel: {
      provider: "openai",
      modelId: modelId as string,
      model: fakeModel(modelId ?? "unknown"),
    },
    credentials: {
      apiKey: "test-key",
      source: "test",
    },
  };
}

function makeMessage(index: number, role: "user" | "assistant", text: string): TranscriptMessage {
  return {
    index,
    role,
    text,
    timestamp: `2026-02-21T00:0${index}:00.000Z`,
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
    const expectedRenderedChars = messages.reduce((total, message) => total + renderTranscriptLine(message).length, 0);

    expect(countOccurrences(output.text, overlap)).toBe(1);
    expect(output.text.length).toBe(expectedRenderedChars);
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

  it("returns undefined and warns for unknown models in verbose mode", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(getContextWindowTokens(makeClient("unknown-model"), true)).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
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
});

describe("resolveWholeFileMode", () => {
  it("handles never/auto/force modes", () => {
    const client = makeClient("gpt-4.1-nano");
    const smallMessages = [makeMessage(0, "user", "small file")];

    expect(resolveWholeFileMode("never", smallMessages, client)).toBe(false);
    expect(resolveWholeFileMode("auto", smallMessages, client)).toBe(true);
    expect(resolveWholeFileMode("force", smallMessages, client)).toBe(true);
  });

  it("returns false for empty messages", () => {
    const client = makeClient("gpt-4.1-nano");
    expect(resolveWholeFileMode("auto", [], client)).toBe(false);
    expect(resolveWholeFileMode("force", [], client)).toBe(false);
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
});

describe("applyEntryHardCap", () => {
  it("truncates to top 100 entries by importance and warns", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entries = Array.from({ length: 147 }, (_value, index) => makeEntry(index + 1));

    const capped = applyEntryHardCap(entries, true);
    const importances = capped.map((entry) => entry.importance);

    expect(capped).toHaveLength(100);
    expect(Math.max(...importances)).toBe(147);
    expect(Math.min(...importances)).toBe(48);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it("keeps exactly 100 entries without warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entries = Array.from({ length: 100 }, (_value, index) => makeEntry(index + 1));

    const capped = applyEntryHardCap(entries, true);

    expect(capped).toHaveLength(100);
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
