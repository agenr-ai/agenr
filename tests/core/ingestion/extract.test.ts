import { describe, expect, it, vi } from "vitest";

import { chunkTranscript, extractFromTranscript } from "../../../src/core/ingestion/extract.js";
import type { LlmPort } from "../../../src/core/ports.js";
import type { ParsedTranscript, TranscriptMessage } from "../../../src/core/types.js";

function buildTranscript(messages: TranscriptMessage[]): ParsedTranscript {
  return {
    messages,
    metadata: {},
    warnings: [],
  };
}

function buildMessage(index: number, role: "user" | "assistant", text: string): TranscriptMessage {
  return {
    index,
    role,
    text,
  };
}

function buildLlm(implementation: LlmPort["completeJson"]): LlmPort {
  return {
    complete: vi.fn(async () => ""),
    completeJson: vi.fn(implementation),
  };
}

describe("extractFromTranscript", () => {
  it("extracts a single chunk successfully", async () => {
    const transcript = buildTranscript([buildMessage(0, "user", "We always use pnpm for this repository."), buildMessage(1, "assistant", "Understood.")]);
    const llm = buildLlm(async () => ({
      entries: [
        {
          type: "decision",
          subject: "agenr package manager",
          content: "This project uses pnpm rather than npm for installs, scripts, and dependency changes.",
          importance: "high",
          expiry: "permanent",
          tags: ["workflow"],
          source_context: "User stated a standing tool choice",
        },
      ],
    }));

    const result = await extractFromTranscript(transcript, llm, {
      wholeFile: "never",
      interChunkDelayMs: 0,
    });

    expect(result).toEqual({
      entries: [
        {
          type: "decision",
          subject: "agenr package manager",
          content: "This project uses pnpm rather than npm for installs, scripts, and dependency changes.",
          importance: 8,
          expiry: "permanent",
          tags: ["workflow"],
          source_context: "User stated a standing tool choice",
        },
      ],
      chunks: 1,
      successfulChunks: 1,
      failedChunks: 0,
      chunkDetails: [
        {
          chunkIndex: 0,
          messageRange: [0, 1],
          success: true,
        },
      ],
      warnings: [],
    });
  });

  it("uses whole-file mode when the transcript fits in context", async () => {
    const transcript = buildTranscript([buildMessage(0, "user", "We always use pnpm for this repository.")]);
    const llm = buildLlm(async () => ({ entries: [] }));

    await extractFromTranscript(transcript, llm, {
      contextWindowTokens: 100_000,
      maxOutputTokens: 1_000,
      interChunkDelayMs: 0,
    });

    expect((llm.completeJson as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((llm.completeJson as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain("## Whole-File Calibration");
  });

  it("splits large transcripts into multiple chunks", async () => {
    const largeText = "x".repeat(20_000);
    const transcript = buildTranscript([
      buildMessage(0, "user", largeText),
      buildMessage(1, "assistant", largeText),
      buildMessage(2, "user", largeText),
      buildMessage(3, "assistant", largeText),
    ]);
    const llm = buildLlm(async () => ({ entries: [] }));

    const result = await extractFromTranscript(transcript, llm, {
      wholeFile: "never",
      interChunkDelayMs: 0,
    });

    expect(result.chunks).toBeGreaterThan(1);
    expect((llm.completeJson as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(result.chunks);
  });

  it("passes previously extracted subjects to later chunks", async () => {
    const transcript = buildTranscript([buildMessage(0, "user", "x".repeat(33_000)), buildMessage(1, "assistant", "y".repeat(33_000))]);
    const llm = buildLlm(async (_systemPrompt, userMessage) => {
      if (!userMessage.includes("Previously extracted from this file")) {
        return {
          entries: [
            {
              type: "decision",
              subject: "agenr package manager",
              content: "This project uses pnpm rather than npm for installs, scripts, and dependency changes.",
              importance: "high",
              expiry: "permanent",
            },
          ],
        };
      }

      return { entries: [] };
    });

    await extractFromTranscript(transcript, llm, {
      wholeFile: "never",
      interChunkDelayMs: 0,
    });

    const secondCallPrompt = (llm.completeJson as ReturnType<typeof vi.fn>).mock.calls[1]?.[1];
    expect(secondCallPrompt).toContain("Previously extracted from this file");
    expect(secondCallPrompt).toContain("agenr package manager");
  });

  it("retries a failed chunk and succeeds on the second attempt", async () => {
    vi.useFakeTimers();

    const transcript = buildTranscript([buildMessage(0, "user", "We always use pnpm for this repository.")]);
    const llm = buildLlm(
      vi
        .fn<LlmPort["completeJson"]>()
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockResolvedValueOnce({
          entries: [
            {
              type: "decision",
              subject: "agenr package manager",
              content: "This project uses pnpm rather than npm for installs, scripts, and dependency changes.",
              importance: "high",
              expiry: "permanent",
            },
          ],
        }),
    );

    const promise = extractFromTranscript(transcript, llm, {
      wholeFile: "never",
      interChunkDelayMs: 0,
    });

    await vi.runAllTimersAsync();
    const result = await promise;

    expect((llm.completeJson as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(result.successfulChunks).toBe(1);
    vi.useRealTimers();
  });

  it("returns empty entries and warnings when all chunk attempts fail", async () => {
    vi.useFakeTimers();

    const transcript = buildTranscript([buildMessage(0, "user", "We always use pnpm for this repository.")]);
    const llm = buildLlm(async () => {
      throw new Error("still failing");
    });

    const promise = extractFromTranscript(transcript, llm, {
      wholeFile: "never",
      interChunkDelayMs: 0,
    });

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.entries).toEqual([]);
    expect(result.failedChunks).toBe(1);
    expect(result.warnings[0]).toMatch(/failed after 3 attempts/i);
    vi.useRealTimers();
  });

  it('honors wholeFile: "never" even when the transcript would fit in context', async () => {
    const transcript = buildTranscript([buildMessage(0, "user", "Short transcript.")]);
    const llm = buildLlm(async () => ({ entries: [] }));

    await extractFromTranscript(transcript, llm, {
      wholeFile: "never",
      contextWindowTokens: 100_000,
      maxOutputTokens: 1_000,
      interChunkDelayMs: 0,
    });

    expect((llm.completeJson as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).not.toContain("## Whole-File Calibration");
  });
});

describe("chunkTranscript", () => {
  it("respects message boundaries", () => {
    const chunks = chunkTranscript(
      [buildMessage(0, "user", "x".repeat(16_000)), buildMessage(1, "assistant", "y".repeat(16_000)), buildMessage(2, "user", "z".repeat(16_000))],
      4_000,
    );

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({
      chunk_index: 0,
      message_range: [0, 0],
      text: `[m00000][user] ${"x".repeat(16_000)}`,
    });
    expect(chunks[1]?.message_range).toEqual([1, 1]);
    expect(chunks[2]?.message_range).toEqual([2, 2]);
  });
});
