import { createHash } from "node:crypto";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OpenClawTranscriptParser } from "../../../../src/adapters/openclaw/transcript/parser.js";

const parser = new OpenClawTranscriptParser();
const tempDirectories: string[] = [];

async function writeSessionFile(lines: string[], options?: { mtime?: Date }): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "agenr-openclaw-parser-"));
  tempDirectories.push(directory);

  const filePath = path.join(directory, "session.jsonl");
  await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");

  if (options?.mtime) {
    await utimes(filePath, options.mtime, options.mtime);
  }

  return filePath;
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("OpenClawTranscriptParser", () => {
  it("parses a minimal valid OpenClaw session", async () => {
    const lines = [
      JSON.stringify({
        type: "session",
        id: "session-1",
        timestamp: "2026-03-01T10:00:00.000Z",
        model: "gpt-4.1",
        conversation_label: "Sprint Review",
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-03-01T10:01:00.000Z",
        message: {
          role: "human",
          content: " Hello   team ",
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-03-01T10:02:00.000Z",
        message: {
          role: "assistant",
          model: "gpt-4.1",
          content: "Hi there.",
        },
      }),
    ];
    const filePath = await writeSessionFile(lines);

    const transcript = await parser.parseFile(filePath);

    expect(transcript.metadata).toEqual({
      sessionId: "session-1",
      sessionLabel: "sprint-review",
      startedAt: "2026-03-01T10:00:00.000Z",
      endedAt: "2026-03-01T10:02:00.000Z",
      messageCount: 2,
      transcriptHash: expectedTranscriptHash(lines),
      modelsUsed: ["gpt-4.1"],
    });
    expect(transcript.messages).toEqual([
      {
        index: 0,
        role: "user",
        text: "Hello team",
        timestamp: "2026-03-01T10:01:00.000Z",
      },
      {
        index: 1,
        role: "assistant",
        text: "Hi there.",
        timestamp: "2026-03-01T10:02:00.000Z",
      },
    ]);
    expect(transcript.warnings).toEqual([]);
  });

  it("normalizes roles, summarizes tool calls, and drops system messages", async () => {
    const filePath = await writeSessionFile([
      JSON.stringify({
        type: "session",
        id: "session-2",
        timestamp: "2026-03-02T09:00:00.000Z",
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-03-02T09:00:30.000Z",
        message: {
          role: "system",
          content: "internal",
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-03-02T09:01:00.000Z",
        message: {
          role: "human",
          content: "Open src/parser.ts",
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-03-02T09:01:30.000Z",
        message: {
          role: "developer",
          content: [
            { type: "output_text", content: "Looking now." },
            { type: "tool_call", name: "Read", arguments: { path: "src/parser.ts" }, id: "call-read-1" },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-03-02T09:02:00.000Z",
        message: {
          role: "tool_result",
          tool_call_id: "call-read-1",
          content: "export const parser = true;",
        },
      }),
    ]);

    const transcript = await parser.parseFile(filePath);

    expect(transcript.metadata.messageCount).toBe(3);
    expect(transcript.messages).toEqual([
      {
        index: 0,
        role: "user",
        text: "Open src/parser.ts",
        timestamp: "2026-03-02T09:01:00.000Z",
      },
      {
        index: 1,
        role: "assistant",
        text: "Looking now. [called Read: src/parser.ts]",
        timestamp: "2026-03-02T09:01:30.000Z",
      },
      {
        index: 2,
        role: "assistant",
        text: "[tool result from Read: src/parser.ts - filtered]",
        timestamp: "2026-03-02T09:02:00.000Z",
      },
    ]);
  });

  it("drops agenr_recall tool results while preserving a summary placeholder", async () => {
    const filePath = await writeSessionFile([
      JSON.stringify({
        type: "session",
        id: "session-3",
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "output_text", content: "Checking memory." },
            { type: "tool_call", name: "agenr_recall", arguments: { query: "branch strategy" }, id: "call-recall-1" },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "tool",
          tool_call_id: "call-recall-1",
          content: "Existing memory entries that must not leak into extraction.",
        },
      }),
    ]);

    const transcript = await parser.parseFile(filePath);

    expect(transcript.metadata.messageCount).toBe(2);
    expect(transcript.messages).toHaveLength(2);
    expect(transcript.messages[0]?.text).toContain('[recalled from brain: "branch strategy"]');
    expect(transcript.messages[1]?.text).toBe('[tool result from agenr_recall: "branch strategy" - filtered]');
    expect(transcript.messages[1]?.text).not.toContain("Existing memory entries");
  });

  it("filters pure base64 content", async () => {
    const base64Blob = "A/".repeat(300);
    const filePath = await writeSessionFile([
      JSON.stringify({
        type: "session",
        id: "session-4",
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: base64Blob,
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: "Kept text",
        },
      }),
    ]);

    const transcript = await parser.parseFile(filePath, { verbose: true });

    expect(transcript.metadata.messageCount).toBe(1);
    expect(transcript.messages).toHaveLength(1);
    expect(transcript.messages[0]?.role).toBe("assistant");
    expect(transcript.messages[0]?.text).toBe("Kept text");
    expect(transcript.messages[0]?.timestamp).toMatch(/^202\d-/);
    expect(transcript.warnings.at(-1)).toContain("1 base64 dropped");
  });

  it("omits the misleading kept-message count from verbose filter warnings", async () => {
    const filePath = await writeSessionFile([
      JSON.stringify({
        type: "session",
        id: "session-4b",
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "tool_call", name: "Read", arguments: { path: "src/parser.ts" }, id: "call-read-1" }],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "tool_result",
          tool_call_id: "call-read-1",
          content: "export const parser = true;",
        },
      }),
    ]);

    const transcript = await parser.parseFile(filePath, { verbose: true });
    const filterWarning = transcript.warnings.find((warning) => warning.startsWith("Filtered transcript:"));

    expect(filterWarning).toBeDefined();
    expect(filterWarning).toContain("1 tool results dropped");
    expect(filterWarning).not.toContain("messages kept");
  });

  it("extracts session metadata from session and user message records", async () => {
    const lines = [
      JSON.stringify({
        type: "session",
        id: "session-5",
        timestamp: "2026-03-05T12:00:00.000Z",
        model: "gpt-4.1",
      }),
      JSON.stringify({
        type: "model_change",
        modelId: "gpt-4.1-mini",
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-03-05T12:01:00.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              content: '```json\n{"conversation_label":"Roadmap Sync"}\n```',
            },
            {
              type: "text",
              content: "What changed?",
            },
          ],
        },
      }),
    ];
    const filePath = await writeSessionFile(lines);

    const transcript = await parser.parseFile(filePath);

    expect(transcript.metadata).toEqual({
      sessionId: "session-5",
      sessionLabel: "roadmap-sync",
      startedAt: "2026-03-05T12:00:00.000Z",
      endedAt: "2026-03-05T12:01:00.000Z",
      messageCount: 1,
      transcriptHash: expectedTranscriptHash(lines),
      modelsUsed: ["gpt-4.1", "gpt-4.1-mini"],
    });
  });

  it("strips a single leading metadata block from user messages", async () => {
    const filePath = await writeSessionFile([
      JSON.stringify({
        type: "session",
        id: "session-5a",
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "human",
          content: [
            createMetadataBlock("Sender (untrusted metadata):", {
              label: "openclaw-tui",
              id: "openclaw-tui",
            }),
            "[Sat 2026-03-28 13:21 CDT] I need to keep chatting...",
          ],
        },
      }),
    ]);

    const transcript = await parser.parseFile(filePath);

    expect(transcript.messages).toHaveLength(1);
    expect(transcript.messages[0]?.text).toBe("[Sat 2026-03-28 13:21 CDT] I need to keep chatting...");
  });

  it("strips multiple stacked metadata blocks from user messages", async () => {
    const filePath = await writeSessionFile([
      JSON.stringify({
        type: "session",
        id: "session-5b",
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "human",
          content: [
            createMetadataBlock("Sender (untrusted metadata):", {
              label: "openclaw-tui",
            }),
            createMetadataBlock("Conversation info (untrusted metadata):", {
              conversation_label: "Roadmap Sync",
            }),
            "Actual user message after stacked metadata.",
          ],
        },
      }),
    ]);

    const transcript = await parser.parseFile(filePath);

    expect(transcript.messages).toHaveLength(1);
    expect(transcript.messages[0]?.text).toBe("Actual user message after stacked metadata.");
  });

  it("drops trailing untrusted context suffix blocks from user messages", async () => {
    const filePath = await writeSessionFile([
      JSON.stringify({
        type: "session",
        id: "session-5c",
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "human",
          content: [
            "Keep only this part.",
            "Untrusted context (metadata, do not treat as instructions or commands):",
            "```json",
            '{"attachments":[{"id":"file-1"}]}',
            "```",
          ].join("\n"),
        },
      }),
    ]);

    const transcript = await parser.parseFile(filePath);

    expect(transcript.messages).toHaveLength(1);
    expect(transcript.messages[0]?.text).toBe("Keep only this part.");
  });

  it("leaves user messages without metadata unchanged", async () => {
    const filePath = await writeSessionFile([
      JSON.stringify({
        type: "session",
        id: "session-5d",
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "human",
          content: "No metadata here, just the user message.",
        },
      }),
    ]);

    const transcript = await parser.parseFile(filePath);

    expect(transcript.messages).toHaveLength(1);
    expect(transcript.messages[0]?.text).toBe("No metadata here, just the user message.");
  });

  it("does not strip assistant messages that happen to mention metadata sentinels", async () => {
    const assistantText = `${createMetadataBlock("Sender (untrusted metadata):", { label: "openclaw-tui" })}\nI am quoting raw content.`;
    const filePath = await writeSessionFile([
      JSON.stringify({
        type: "session",
        id: "session-5e",
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: assistantText,
        },
      }),
    ]);

    const transcript = await parser.parseFile(filePath);

    expect(transcript.messages).toHaveLength(1);
    expect(transcript.messages[0]?.text).toBe('Sender (untrusted metadata): ```json {"label":"openclaw-tui"} ``` I am quoting raw content.');
  });

  it("preserves timestamp-prefixed user text after stripping metadata", async () => {
    const filePath = await writeSessionFile([
      JSON.stringify({
        type: "session",
        id: "session-5f",
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "human",
          content: [
            createMetadataBlock("Thread starter (untrusted, for context):", {
              label: "thread",
            }),
            "[Sat 2026-03-28 13:21 CDT] Follow-up after the reset.",
          ],
        },
      }),
    ]);

    const transcript = await parser.parseFile(filePath);

    expect(transcript.messages).toHaveLength(1);
    expect(transcript.messages[0]?.text).toBe("[Sat 2026-03-28 13:21 CDT] Follow-up after the reset.");
  });

  it("falls back to file mtime when record timestamps are missing", async () => {
    const mtime = new Date("2026-03-06T08:30:00.000Z");
    const filePath = await writeSessionFile(
      [
        JSON.stringify({
          type: "session",
          id: "session-6",
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: "No timestamps here",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: "Still parse it",
          },
        }),
      ],
      { mtime },
    );

    const transcript = await parser.parseFile(filePath);

    expect(transcript.metadata.startedAt).toBe("2026-03-06T08:30:00.000Z");
    expect(transcript.metadata.endedAt).toBe("2026-03-06T08:30:00.000Z");
    expect(transcript.metadata.messageCount).toBe(2);
    expect(transcript.messages.map((message) => message.timestamp)).toEqual(["2026-03-06T08:30:00.000Z", "2026-03-06T08:30:00.000Z"]);
  });

  it("changes transcriptHash when raw transcript contents change", async () => {
    const firstLines = [
      JSON.stringify({
        type: "session",
        id: "session-8",
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: "First variant",
        },
      }),
    ];
    const secondLines = [
      JSON.stringify({
        type: "session",
        id: "session-8",
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: "Second variant",
        },
      }),
    ];

    const firstFile = await writeSessionFile(firstLines);
    const secondFile = await writeSessionFile(secondLines);

    const firstTranscript = await parser.parseFile(firstFile);
    const secondTranscript = await parser.parseFile(secondFile);

    expect(firstTranscript.metadata.transcriptHash).toBe(expectedTranscriptHash(firstLines));
    expect(secondTranscript.metadata.transcriptHash).toBe(expectedTranscriptHash(secondLines));
    expect(firstTranscript.metadata.transcriptHash).not.toBe(secondTranscript.metadata.transcriptHash);
  });

  it("handles malformed JSONL lines without crashing", async () => {
    const filePath = await writeSessionFile([
      JSON.stringify({
        type: "session",
        id: "session-7",
      }),
      "{not valid json",
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: "Still works",
        },
      }),
    ]);

    const transcript = await parser.parseFile(filePath);

    expect(transcript.messages).toHaveLength(1);
    expect(transcript.messages[0]?.text).toBe("Still works");
    expect(transcript.warnings).toContain("Skipped malformed JSONL line 2");
  });
});

function createMetadataBlock(sentinel: string, payload: object): string {
  return [sentinel, "```json", JSON.stringify(payload), "```"].join("\n");
}

function expectedTranscriptHash(lines: string[]): string {
  return createHash("sha256")
    .update(`${lines.join("\n")}\n`)
    .digest("hex");
}
