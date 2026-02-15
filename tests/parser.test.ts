import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chunkMessages, parseTranscriptFile } from "../src/parser.js";
import type { TranscriptMessage } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

async function makeTempFile(name: string, content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-parser-test-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

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

  it("parses markdown files into text chunks", async () => {
    const filePath = await makeTempFile("note.md", "# Header\n\nThis is markdown content.\n");
    const parsed = await parseTranscriptFile(filePath);

    expect(parsed.messages).toEqual([]);
    expect(parsed.chunks).toHaveLength(1);
    expect(parsed.chunks[0]?.text).toContain("Header");
    expect(parsed.chunks[0]?.chunk_index).toBe(0);
    expect(parsed.chunks[0]?.totalChunks).toBe(1);
  });

  it("parses plain text files into text chunks", async () => {
    const filePath = await makeTempFile("note.txt", "line one\nline two\n");
    const parsed = await parseTranscriptFile(filePath);

    expect(parsed.messages).toEqual([]);
    expect(parsed.chunks).toHaveLength(1);
    expect(parsed.chunks[0]?.text).toContain("line one");
    expect(parsed.chunks[0]?.index).toBe(0);
  });

  it("splits large markdown with overlap", async () => {
    const large = "x".repeat(26_000);
    const filePath = await makeTempFile("large.md", large);
    const parsed = await parseTranscriptFile(filePath);

    expect(parsed.chunks.length).toBeGreaterThan(2);
    const first = parsed.chunks[0]?.text ?? "";
    const second = parsed.chunks[1]?.text ?? "";
    expect(second.slice(0, 100)).toBe(first.slice(-100));
  });

  it("keeps small text files as a single chunk", async () => {
    const filePath = await makeTempFile("small.md", "small file");
    const parsed = await parseTranscriptFile(filePath);

    expect(parsed.chunks).toHaveLength(1);
  });

  it("returns zero chunks for empty text files", async () => {
    const filePath = await makeTempFile("empty.txt", "   \n\n");
    const parsed = await parseTranscriptFile(filePath);

    expect(parsed.chunks).toEqual([]);
    expect(parsed.messages).toEqual([]);
  });

  it("detects JSONL by content even with non-jsonl extension", async () => {
    const filePath = await makeTempFile("transcript.txt", '{"role":"user","content":"hello"}\n');
    const parsed = await parseTranscriptFile(filePath);

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.role).toBe("user");
    expect(parsed.chunks[0]?.text).toContain("[m00000][user] hello");
  });
});
