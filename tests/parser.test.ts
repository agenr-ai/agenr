import path from "node:path";
import { describe, expect, it } from "vitest";
import { chunkMessages, parseTranscriptFile } from "../src/parser.js";
import type { TranscriptMessage } from "../src/types.js";

describe("parser", () => {
  it("parses OpenClaw JSONL, drops toolResult entries, and warns on malformed lines", async () => {
    const fixture = path.resolve("tests/fixtures/sample-transcript.jsonl");
    const parsed = await parseTranscriptFile(fixture);

    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(parsed.warnings.some((w) => w.includes("Skipped malformed JSONL line"))).toBe(true);
    expect(parsed.chunks.length).toBeGreaterThan(0);
    expect(parsed.chunks[0]?.text).toContain("[m00000][user]");
    expect(parsed.chunks[0]?.text).toContain("[m00001][assistant]");
  });

  it("chunks by message boundaries with overlap and stable indexing", () => {
    const messages: TranscriptMessage[] = [];
    for (let i = 0; i < 12; i += 1) {
      messages.push({
        index: i,
        role: i % 2 === 0 ? "user" : "assistant",
        text: `Message ${i} ` + "x".repeat(45),
      });
    }

    const chunks = chunkMessages(messages, 180, 80);
    expect(chunks.length).toBeGreaterThan(1);

    for (let i = 1; i < chunks.length; i += 1) {
      const current = chunks[i];
      const previous = chunks[i - 1];
      expect(current?.message_start).toBeLessThanOrEqual(previous?.message_end ?? 0);
      expect(current?.chunk_index).toBe(i);
    }
  });
});
